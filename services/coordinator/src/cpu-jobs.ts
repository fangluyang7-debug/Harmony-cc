import {dispatchDiagnostics} from './dispatch-diagnostics';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { canonical, DispatchOfferV2, sampleUsableV2, protocolId, PlacementRequest, SnapshotDecision } from '@harmony/scheduler-core';
import { ArtifactChannel, ArtifactDescriptor } from '@harmony/resource-transport';
import { builtinCpuPacks, ReferencePack } from '@harmony/reference-capabilities';
import { PrismaClient } from '../generated/client';
import { Peer } from './channel';
import { DeviceDirectory } from './directory';
import { CoordinatorStore } from './store';
import { AllotmentIssuer } from './allotments';
import { ProfileProjection } from './profile-projection';
import { SnapshotBuilder, PlanningService } from './planning';
import { TraceService } from './traces';
import { AppRegistry } from './apps';
import {DirectTransfers} from './direct-transfers';

interface StartContext {until:number;jobId:string;stage?:string;retries?:number;}
interface JobData {resultReceivedAt?:number;delivery?:{id:string;senderHolderId:string;senderEndpointId:string;senderEpoch:string;relay?:boolean;preparation?:{at:number;remainingMs:number;uploadMs?:number;downloadMs?:number;estimatedMs:number|null;reservedTailMs:number;relaySlots:number;reason:string};failure?:{authorizationId:string;endpointId:string;at:number;reason:string}};retainOutput?:{id:string;epoch:string};sourceAttemptId?:string;sourceNodeId?:string;offer:DispatchOfferV2;holderId:string;input:ArtifactDescriptor;output:ArtifactDescriptor|null;traceId:string;
  budgetMs:number;deadlineAt:number;fingerprint?:string;choices?:{request:PlacementRequest;parameters:string}[];
  request:PlacementRequest;plan:SnapshotDecision;planTiming:{start:number;end:number;clockDomainId?:string};
  decisionEvidence?:{snapshotVersion:number;policyVersion:string;profileSequence:number;profileSampledAt:number;resultDelivery:string;phaseCosts?:{EXECUTE:number|null;QUEUE:number|null;PUBLISH:number|null}};}
/** First usable single-node submission path. Uses qualified available targets, with an optional explicit target. */
export class CpuJobs {
  private readonly starts=new Map<string,Promise<unknown>>();
  constructor(private readonly db:PrismaClient,private readonly directory:DeviceDirectory,private readonly profiles:ProfileProjection,
    private readonly snapshots:SnapshotBuilder,private readonly allotments:AllotmentIssuer,private readonly artifacts:ArtifactChannel,
    private readonly store:CoordinatorStore,private readonly epoch:()=>number,private readonly flush:()=>Promise<void>,
    private readonly planning:PlanningService,private readonly traces:TraceService,private readonly apps:AppRegistry,private readonly packs:ReferencePack[]=builtinCpuPacks(),private readonly directTransfers?:DirectTransfers){}
  async submit(peer:Peer,input:any,variants?:{parameters:string;targetId?:string}[],fingerprint?:string,graph?:{workflowId:string;nodeId:string;deadlineAt:number;dependencies:string[];retain?:boolean;source?:{descriptor:ArtifactDescriptor;attemptId:string;nodeId:string}}){
    const app=await this.apps.context(peer);
    if(!input||!protocolId(input.requestId)||input.requestId.length>100||typeof input.capability!=='string'||typeof input.contentHash!=='string'||!/^[a-f0-9]{64}$/.test(input.contentHash)||
      !Number.isSafeInteger(input.bytes)||input.bytes<1||input.bytes>8388608||input.targetId!==undefined&&!protocolId(input.targetId)||
      input.budgetMs!==undefined&&(!Number.isSafeInteger(input.budgetMs)||input.budgetMs<0||input.budgetMs>30000)||
      input.parameters!==undefined&&(typeof input.parameters!=='string'||Buffer.byteLength(input.parameters)>32768)||
      input.inputLocation!==undefined&&input.inputLocation!=='ORIGIN'||Object.keys(input).some(k=>!['requestId','capability','contentHash','bytes','targetId','budgetMs','parameters','inputLocation'].includes(k)))throw Error('JOB_INPUT_INVALID');
    const parameters=input.parameters??'{}';try{JSON.parse(parameters);}catch{throw Error('JOB_INPUT_INVALID');}
    const id=input.requestId,existing=await this.db.cpuJob.findUnique({where:{id}});
    if(existing){const d=await this.owned(peer,id);if(d.fingerprint!==fingerprint||(!fingerprint&&d.offer.task.parameters!==parameters)||d.input.ref.contentHash!==input.contentHash||d.input.bytes!==input.bytes||d.offer.task.contract.capability!==input.capability||!fingerprint&&input.targetId&&d.offer.target.targetId!==input.targetId||input.budgetMs!==undefined&&d.budgetMs!==input.budgetMs)throw Error('JOB_CONFLICT');if(existing.state==='CANCELLED')throw Error('JOB_CANCELLED');this.artifacts.register(d.input);return this.upload(peer,id,d);}
    const pack=this.packs.find(p=>p.manifest.contract.capability===input.capability);if(!pack)throw Error('CAPABILITY_UNSUPPORTED');
    if(!app.identity.allowedContracts.includes(pack.manifest.contract.contractId))throw Error('APP_CONTRACT_FORBIDDEN');
    const now=Date.now();
    const artifact:ArtifactDescriptor=graph?.source?.descriptor??{ref:{artifactId:'in-'+id,contentVersion:1,contentHash:input.contentHash,schemaId:pack.manifest.contract.inputSchemas[0],schemaVersion:1},
      groupId:peer.groupId,ownerPrincipalId:peer.principalId,domain:this.directory.domain,bytes:input.bytes,expiresAt:now+3600000};
    if(graph?.source&&(artifact.groupId!==peer.groupId||artifact.ownerPrincipalId!==peer.principalId||artifact.domain!==this.directory.domain||
      artifact.ref.contentHash!==input.contentHash||artifact.bytes!==input.bytes||!pack.manifest.contract.inputSchemas.includes(artifact.ref.schemaId)||
      !graph.dependencies.includes(graph.source.nodeId)))throw Error('GRAPH_INPUT_SCOPE');
    // Recover a legacy pre-reservation descriptor without extending its hard expiry.
    const registered=this.artifacts.lookup(peer.groupId,artifact.ref);
    if(!graph?.source&&registered&&registered.ownerPrincipalId===artifact.ownerPrincipalId&&registered.bytes===artifact.bytes&&registered.expiresAt<artifact.expiresAt)artifact.expiresAt=registered.expiresAt;
    // S1 has one fixed relay path. The planner prices input -> worker -> relay;
    // subsequent source polling/download is not claimed as an end-to-end estimate.
    const request:PlacementRequest={nodes:[{id:'compute',capability:input.capability,...(pack.manifest.contract.serviceId?{serviceId:pack.manifest.contract.serviceId}:{}),dependencies:[],inputs:[artifact.ref.artifactId],
      // Reference numeric/text transforms: bound expansion conservatively rather
      // than pricing every tiny vector result as the global 8 MiB limit.
      // Raster expansion depends on crop/resize parameters; retain its declared maximum.
      output:{id:'out-'+id,bytes:pack.manifest.contract.outputSchemas.includes('image.raster')?pack.maxOutputBytes:Math.min(pack.maxOutputBytes,input.bytes*64+4096)},
      baselineTargetId:input.targetId??'',...(input.targetId?{allowedTargetIds:[input.targetId]}:{}),
      memoryBytes:pack.manifest.resourceLimit.find(r=>r.resourcePoolId==='ram')?.amount??0,minimumQuality:pack.manifest.qualityThreshold,candidates:[]}],
      artifacts:[{id:artifact.ref.artifactId,bytes:artifact.bytes,replicas:[input.inputLocation==='ORIGIN'?{deviceId:peer.deviceId,holderInstanceId:peer.holderInstanceId,readMs:0}:{deviceId:this.store.senderInstanceId,readMs:0}]}],links:[],deviceResources:[],
      ...(input.inputLocation==='ORIGIN'?{inputRelayId:this.store.senderInstanceId,localResultHolderId:peer.holderInstanceId}:{}),
      ...(graph?{localResultHolderId:peer.holderInstanceId}:{}),originHolderId:peer.holderInstanceId,appInstanceId:app.identity.appInstanceId,domain:this.directory.domain,remainingBudgetMs:input.budgetMs??30000,networkAllowed:true,privacy:'AUTHORIZED_REMOTE',localDeviceId:peer.deviceId,
      now,committedNodeIds:[],committedArtifacts:[],materializeOutputsAt:this.store.senderInstanceId,finalDestination:this.store.senderInstanceId};
    const parent=graph?.source?await this.owned(peer,graph.source.attemptId):null;
    if(graph?.source&&artifact.expiresAt<=Date.now())throw Error('ARTIFACT_UNAVAILABLE:ARTIFACT_EXPIRED');
    if(parent?.retainOutput&&this.directTransfers){const problem=await this.directTransfers.sourceProblem(peer.groupId,app.identity.appInstanceId,artifact.ref,graph!.source!.attemptId);if(problem&&!this.artifacts.available(artifact))throw Error('ARTIFACT_UNAVAILABLE:'+problem);}
    if(parent?.retainOutput){
      request.inputRelayId=this.store.senderInstanceId;
      request.artifacts[0].replicas=[{deviceId:parent.offer.target.deviceId,holderInstanceId:parent.holderId,readMs:0,transferOperation:'WRITE',endpointId:parent.retainOutput.id,endpointEpoch:parent.retainOutput.epoch}];
    }
    if(graph?.retain){request.nodes[0].output.retainAtExecutor=true;request.finalDestination=undefined;}
    const choices=variants?.map(v=>{const r=structuredClone(request);r.nodes[0].baselineTargetId=v.targetId??'';r.nodes[0].allowedTargetIds=v.targetId?[v.targetId]:undefined;return {request:r,parameters:v.parameters};});
    const planned=await this.choose(peer,request,choices?.map(c=>c.request),undefined,id),{profile,executor,grant,decision,planTiming}=planned;
    const selectedRequest=choices?.[planned.selected]?.request??request,selectedParameters=choices?.[planned.selected]?.parameters??parameters;
    const offer:DispatchOfferV2={task:{groupId:peer.groupId,sessionId:null,originDeviceId:peer.deviceId,resultDestination:peer.deviceId,workflowId:graph?.workflowId??id,nodeId:graph?.nodeId??'compute',attemptId:id,
      coordinatorEpoch:this.epoch(),planRevision:1,app:app.identity,
      contract:executor.contract,budget:{remainingMs:request.remainingBudgetMs,deadlineAt:now+request.remainingBudgetMs},inputs:[artifact.ref],allowedTargetIds:[executor.target.targetId],qualityTarget:'reference',privacy:'AUTHORIZED_REMOTE',
      priority:'REMOTE_INTERACTIVE',parameters:selectedParameters,allowedConfigurations:executor.configurations.map(c=>c.id),businessIdempotencyKey:null},target:executor.target,resources:executor.resources,allowedConfigs:executor.configurations,
      allotmentId:grant.allotmentId,allotmentVersion:grant.version,leaseMs:request.remainingBudgetMs,
      transferPlan:[{ref:artifact.ref,from:this.store.senderInstanceId,to:executor.target.deviceId,via:null}],dependencies:graph?.dependencies.map(nodeId=>({nodeId,planRevision:1,committed:true}))??[],reasonCode:decision.decision.reason};
    const data:JobData={sourceAttemptId:graph?.source?.attemptId,sourceNodeId:graph?.source?.nodeId,offer,holderId:profile.holderInstanceId,input:artifact,output:null,traceId:graph?.workflowId??randomUUID(),budgetMs:request.remainingBudgetMs,deadlineAt:graph?.deadlineAt??now+request.remainingBudgetMs,request:selectedRequest,choices,fingerprint,plan:decision,planTiming,
      decisionEvidence:this.evidence(planned)};
    if(parent?.retainOutput)data.delivery={id:randomUUID(),senderHolderId:parent.holderId,senderEndpointId:parent.retainOutput.id,senderEpoch:parent.retainOutput.epoch};
    if(this.localInput(peer,data)){data.offer.transferPlan=[];data.decisionEvidence!.resultDelivery='ORIGIN_LOCAL';}
    await this.db.$transaction(async tx=>{await this.apps.reserveJob(tx,peer,id,offer.resources,data.deadlineAt);await tx.cpuJob.create({data:{id,groupId:peer.groupId,principalId:peer.principalId,sourceHolderId:peer.holderInstanceId,state:'WAITING_INPUT',metadataJson:JSON.stringify(data)}});});
    this.artifacts.register(artifact);return this.upload(peer,id,data);
  }
  private async choose(peer:Peer,request:PlacementRequest,alternatives?:PlacementRequest[],wait?:StartContext,diagnosticJobId?:string){
    // Empty groups still go through plan(), which owns the refusal reason.
    if((await this.directory.profiles(peer.groupId)).length)await this.profiles.refresh(peer.groupId,wait?'START':'SUBMIT',wait?.jobId??diagnosticJobId);
    let built;
    try{built=await this.snapshots.build(peer.groupId);}catch(e){if(!(e instanceof Error)||e.message!=='GROUP_UNKNOWN')throw e;
      built={snapshot:{version:1,policyVersion:peer.groupId,groupId:peer.groupId,domain:this.directory.domain,capturedAt:Date.now(),devices:[],resources:[],candidates:[],links:[]},
        policy:{version:peer.groupId,revoked:false,allowedTargetIds:[],limits:{maxCandidates:64,lookahead:16,beamWidth:8,planningBudgetMs:20,switchCostMs:0,hysteresisMs:0}}};}
    const start=performance.now(),clock={now:Date.now(),monotonic:()=>performance.now()},choice=alternatives?this.planning.alternatives(built.snapshot,alternatives,built.policy,clock):{selected:0,decision:this.planning.plan(built.snapshot,request,built.policy,clock)},decision=choice.decision,end=performance.now();
    const selected=decision.decision.suggestion?.[0];if(!selected)throw Error(decision.decision.reason);
    const profile=(await this.directory.profiles(peer.groupId)).find(p=>p.deviceId===selected.deviceId&&p.executors.some(e=>e.target.targetId===selected.targetId));
    const executor=profile?.executors.find(e=>e.target.targetId===selected.targetId),pack=this.packs.find(p=>p.manifest.contract.capability===request.nodes[0].capability);
    if(!profile||!executor||!pack||canonical(executor.contract)!==canonical(pack.manifest.contract))throw Error('TARGET_UNAVAILABLE');
    const grant=await this.confirmedGrant(peer,profile.deviceId,profile.holderInstanceId,wait);
    return {decision,profile,executor,grant,selected:choice.selected,planTiming:{start,end,clockDomainId:this.traces.clockDomainId}};
  }
  private async confirmedGrant(peer:Peer,deviceId:string,holderId:string,wait?:StartContext){
    for(;;){
      let wake!:()=>void;
      const changed=new Promise<void>(resolve=>{wake=resolve;}),unwatch=this.allotments.watch(peer.groupId,holderId,wake);
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{
        if(wait){
          const data=await this.owned(peer,wait.jobId),row=await this.db.cpuJob.findUniqueOrThrow({where:{id:wait.jobId}});
          if(!['WAITING_INPUT','DISPATCHING'].includes(row.state))throw Error('JOB_CANCELLED');
          if(data.deadlineAt<=Date.now())throw Error('BUDGET_EXHAUSTED');
          wait.until=Math.min(wait.until,data.deadlineAt-100);
        }
        const reservation=(await this.allotments.reservations(deviceId)).find(a=>a.grant.groupId===peer.groupId&&a.grant.holderInstanceId===holderId);
        if(!reservation||reservation.grant.coordinatorEpoch!==this.epoch())throw Error('ALLOTMENT_UNAVAILABLE');
        if(reservation.ack?.version===reservation.grant.version)return reservation.grant;
        if(!wait)throw Error('ALLOTMENT_UNAVAILABLE');
        if(Date.now()>=wait.until)throw Error('ALLOTMENT_ACK_PENDING');
        await Promise.race([changed,new Promise<void>(resolve=>{timer=setTimeout(resolve,Math.min(100,wait.until-Date.now()));})]);
      }finally{unwatch();if(timer)clearTimeout(timer);}
    }
  }
  private evidence(p:Awaited<ReturnType<CpuJobs['choose']>>){
    const value=(sample:{value:number|null}|undefined)=>sample&&sample.value!==null&&Number.isFinite(sample.value)?sample.value:null;
    const compute=value(p.executor.compute),queue=value(p.executor.queue),cold=value(p.executor.cold),execution=p.decision.decision.suggestion?.[0]?.executionMs;
    const publication=compute!==null&&queue!==null&&cold!==null&&typeof execution==='number'?execution-compute-queue-cold:null;
    return {snapshotVersion:p.decision.snapshotVersion,policyVersion:p.decision.policyVersion,profileSequence:p.profile.sequence,profileSampledAt:p.profile.ownerActivity.sampledAt,
      resultDelivery:'SOURCE_PULL_NOT_ESTIMATED',phaseCosts:{EXECUTE:compute,QUEUE:queue,PUBLISH:publication!==null&&publication>=0?publication:null}};
  }
  private localInput(peer:Peer,d:JobData){return !d.delivery&&d.request.inputRelayId!==undefined&&d.holderId===peer.holderInstanceId&&d.offer.task.app.appInstanceId===peer.app?.appInstanceId;}
  private localOutput(peer:Peer,d:JobData){return d.holderId===peer.holderInstanceId&&d.offer.task.app.appInstanceId===peer.app?.appInstanceId&&d.request.localResultHolderId===peer.holderInstanceId;}
  async graphPlan(peer:Peer,request:PlacementRequest){
    await this.apps.context(peer);await this.profiles.refresh(peer.groupId);
    const built=await this.snapshots.build(peer.groupId);
    return this.planning.plan(built.snapshot,request,built.policy,{now:Date.now(),monotonic:()=>performance.now()});
  }
  relayId(){return this.store.senderInstanceId;}
  async graphInput(peer:Peer,id:string,source:ArtifactDescriptor,prepare=true){
    const data=await this.owned(peer,id);
    if(data.delivery){if(prepare)await this.prepareDelivery(peer,id,data);return null;}
    if(await this.inputReady(peer,data))return null; // The authenticated producer prepares this edge; start still checks readiness.
    const endpointId=data.plan.decision.suggestion?.[0]?.inputEndpointId;
    if(endpointId)return {read:this.artifacts.issue(source,peer,'READ'),write:{...this.artifacts.issue(data.input,peer,'WRITE'),direct:{jobId:id,endpointId}}};
    if(this.artifacts.available(source)){await this.artifacts.writeForControl(data.input,await this.artifacts.readForControl(source));return null;}
    return {read:this.artifacts.issue(source,peer,'READ'),write:this.artifacts.issue(data.input,peer,'WRITE')};
  }
  /** Prepare bytes before start's input gate. No compute attempt/outbox is created here. */
  private async deliveryArranged(id:string){return !!await this.db.attempt.findUnique({where:{id}})||await this.db.outbox.count({where:{attemptId:id}})>0;}
  private async prepareDelivery(peer:Peer,id:string,data:JobData){
    if(!data.delivery||data.deadlineAt<=Date.now()||await this.deliveryArranged(id))return;
    const previous=JSON.stringify(data),request=structuredClone(data.request),now=Date.now();
    const tail=await this.remainingTail(data);request.now=now;request.remainingBudgetMs=Math.max(0,data.deadlineAt-now-tail);
    request.excludedInputEndpoints=[...new Set([...(request.excludedInputEndpoints??[]),...(data.delivery.failure?[data.delivery.failure.endpointId]:[])])];
    const active=await this.db.transferAuthorization.count({where:{endpointId:this.store.senderInstanceId,state:{in:['ISSUED','CONSUMED']},expiresAt:{gt:now}}});
    request.relayCapacity={deviceId:this.store.senderInstanceId,availableSlots:Math.max(0,Math.min(4-active,this.directTransfers?.relaySlots()??0)),availableBytes:this.directTransfers?.relayBytes?.(),observedAt:now,ttlMs:1000};
    await this.refreshCopies(data,request);
    const problem=await this.directTransfers?.sourceProblem(peer.groupId,data.offer.task.app.appInstanceId,data.input.ref,data.sourceAttemptId!);
    const relayReady=this.artifacts.available(data.input)&&await this.directTransfers?.relayConfirmed(id);
    if(problem&&!relayReady){if(await this.deliveryArranged(id))return;throw Error('ARTIFACT_UNAVAILABLE:'+problem);}
    let chosen:Awaited<ReturnType<CpuJobs['choose']>>;
    try{chosen=await this.choose(peer,request);}catch(error){
      if(await this.deliveryArranged(id))return;
      if(error instanceof Error&&error.message==='NO_LEGAL_PLAN'&&!relayReady&&request.relayCapacity.availableBytes!==undefined&&request.relayCapacity.availableBytes<data.input.bytes)throw Error('ARTIFACT_CACHE_FULL');
      const estimate=data.plan.decision.suggestionMs;
      if(error instanceof Error&&['NO_LEGAL_PLAN','NO_AVAILABLE_TARGET'].includes(error.message)&&typeof estimate==='number'&&data.deadlineAt-Date.now()<estimate+tail)throw Error('ARTIFACT_UNAVAILABLE:REMAINING_BUDGET_INSUFFICIENT');
      throw error;
    }
    const placement=chosen.decision.decision.suggestion![0];
    const oldRoute=JSON.stringify([data.holderId,data.delivery.senderHolderId,data.delivery.senderEpoch,data.delivery.relay??false,data.plan.decision.suggestion?.[0]?.inputEndpointId]);
    data.request=request;data.plan=chosen.decision;data.planTiming=chosen.planTiming;data.decisionEvidence=this.evidence(chosen);
    data.holderId=chosen.profile.holderInstanceId;data.offer.target=chosen.executor.target;
    data.offer.resources=chosen.executor.resources;data.offer.allowedConfigs=chosen.executor.configurations;
    data.offer.task.allowedTargetIds=[chosen.executor.target.targetId];data.offer.task.allowedConfigurations=chosen.executor.configurations.map(c=>c.id);
    data.offer.allotmentId=chosen.grant.allotmentId;data.offer.allotmentVersion=chosen.grant.version;
    data.offer.task.budget={deadlineAt:data.deadlineAt,remainingMs:Math.max(0,data.deadlineAt-Date.now())};
    const sender=placement.inputSourceHolderId??data.delivery.senderHolderId,senderEndpoint=placement.inputSourceEndpointId??data.delivery.senderEndpointId,senderEpoch=placement.inputSourceEndpointEpoch??data.delivery.senderEpoch;
    const changedRoute=oldRoute!==JSON.stringify([chosen.profile.holderInstanceId,sender,senderEpoch,placement.inputRelayId===this.store.senderInstanceId,placement.inputEndpointId]);
    data.delivery={...data.delivery,id:changedRoute?randomUUID():data.delivery.id,senderHolderId:sender,senderEndpointId:senderEndpoint,senderEpoch,relay:placement.inputRelayId===this.store.senderInstanceId,preparation:{at:now,remainingMs:request.remainingBudgetMs,uploadMs:placement.inputUploadMs,downloadMs:placement.inputDownloadMs,estimatedMs:chosen.decision.decision.suggestionMs,reservedTailMs:tail,relaySlots:request.relayCapacity.availableSlots,reason:data.delivery.failure?.reason??'INPUT_PREPARATION'},failure:undefined};
    await this.db.$transaction(async tx=>{
      if(await tx.attempt.findUnique({where:{id}})||await tx.outbox.count({where:{attemptId:id}}))return;
      const changed=await tx.cpuJob.updateMany({where:{id,state:'WAITING_INPUT',metadataJson:previous},data:{metadataJson:JSON.stringify(data)}});
      if(changed.count&&changedRoute)await tx.transferAuthorization.updateMany({where:{attemptId:id,state:'ISSUED'},data:{state:'REVOKED'}});
    });
  }
  private async remainingTail(data:JobData){
    if(!data.sourceAttemptId)return 0;
    const row=await this.db.sdkWorkflowJob.findUnique({where:{id:data.offer.task.workflowId}});if(!row)return 0;
    const graph=JSON.parse(row.metadataJson),assignment=graph.plan?.decision?.suggestion?.find((a:any)=>a.nodeId===data.offer.task.nodeId),end=graph.plan?.decision?.suggestionMs;
    return typeof end==='number'&&Number.isFinite(end)&&typeof assignment?.finishMs==='number'?Math.max(0,end-assignment.finishMs):0;
  }
  private async refreshCopies(data:JobData,request:PlacementRequest){
    if(!data.delivery||!data.sourceAttemptId||!this.directTransfers)return;
    const copies=await this.directTransfers.inputCopies(data.offer.task.groupId,data.offer.task.app.appInstanceId,data.input.ref,data.sourceAttemptId);
    const artifact=request.artifacts.find(a=>a.id===data.input.ref.artifactId);if(artifact)artifact.replicas=copies;
    if(artifact&&this.artifacts.available(data.input)&&(!data.delivery||await this.directTransfers.relayConfirmed(data.offer.task.attemptId)))artifact.replicas.push({deviceId:this.store.senderInstanceId,readMs:0});
  }
  async graphOutput(peer:Peer,id:string){
    const data=await this.owned(peer,id),output=data.output;
    if(!output)return null;
    const task=data.offer.task;
    const node=await this.db.node.findUnique({where:{id:JSON.stringify([task.workflowId,task.nodeId])}});
    if(node?.currentAttemptId!==id||node.state!=='COMMITTED')return null;
    const receipt=await this.db.receipt.findUnique({where:{id}});
    if(!receipt?.committed)return null;
    const result=JSON.parse(receipt.recordJson);
    if(result.state!=='SUCCEEDED'||!result.outputs.some((ref:unknown)=>canonical(ref)===canonical(output.ref)))return null;
    const local=this.localOutput(peer,data)&&!this.artifacts.available(output);
    if(!local&&!this.artifacts.available(output)&&!await this.directTransfers?.hasInput(peer.groupId,data.holderId,task.app.appInstanceId,output.ref))return null;
    return {descriptor:output,local};
  }
  private upload(peer:Peer,id:string,d:JobData){const endpointId=d.plan.decision.suggestion?.[0]?.inputEndpointId;return {jobId:id,targetId:d.offer.target.targetId,deviceId:d.offer.target.deviceId,reason:d.offer.reasonCode,inputDelivery:this.localInput(peer,d)?'LOCAL':endpointId?'DIRECT':'RELAY',...(endpointId?{inputEndpointId:endpointId}:{}),inputTicket:this.artifacts.issue(d.input,peer,'WRITE')};}
  private async inputReady(peer:Peer,d:JobData){return this.localInput(peer,d)||this.artifacts.available(d.input)&&(!d.delivery||!!await this.directTransfers?.relayConfirmed(d.offer.task.attemptId))||!!await this.directTransfers?.hasInput(peer.groupId,d.holderId,d.offer.task.app.appInstanceId,d.input.ref);}
  private async owned(peer:Peer,id:string):Promise<JobData>{
    await this.apps.context(peer);
    const row=await this.db.cpuJob.findUnique({where:{id}});if(!row||row.groupId!==peer.groupId||row.principalId!==peer.principalId||row.sourceHolderId!==peer.holderInstanceId)throw Error('JOB_SCOPE');return JSON.parse(row.metadataJson);
  }
  async received(peer:Peer,id:string,body:any){
    const data=await this.owned(peer,id),status=await this.status(peer,id);
    if(!body||Object.keys(body).sort().join('|')!==(body.sourceInterval?'bytes|ref|sourceInterval':'bytes|ref')||status.state!=='SUCCEEDED'||!data.output||canonical(body.ref)!==canonical(data.output.ref)||body.bytes!==data.output.bytes)throw Error('RESULT_RECEIPT_SCOPE');
    if(body.sourceInterval)await this.traces.sourceRoot(peer,data.offer,data.traceId,data.plan.snapshotVersion,body.sourceInterval);
    if(!data.resultReceivedAt){const previous=JSON.stringify(data);data.resultReceivedAt=Date.now();await this.db.cpuJob.updateMany({where:{id,metadataJson:previous},data:{metadataJson:JSON.stringify(data)}});}return {received:true};
  }
  async sourceRoot(peer:Peer,data:JobData,interval:unknown){return this.traces.sourceRoot(peer,data.offer,data.traceId,data.plan.snapshotVersion,interval);}
  async trace(peer:Peer,id:string){const data=await this.owned(peer,id);return this.traces.read(peer,data.traceId);}
  async writeInput(peer:Peer,id:string,bytes:Buffer){const data=await this.owned(peer,id);await this.artifacts.writeForControl(data.input,bytes);}
  async readOutput(peer:Peer,id:string){const data=await this.owned(peer,id),status=await this.status(peer,id);if(!status.outputTicket||!data.output)throw Error('OUTPUT_NOT_READY');return this.artifacts.readForControl(data.output);}
  /** No durable dispatch evidence may be erased by a planning retry. */
  private async resetUndispatched(id:string):Promise<boolean>{
    return this.db.$transaction(async tx=>{
      if(await tx.attempt.findUnique({where:{id}})||await tx.outbox.count({where:{attemptId:id}}))return false;
      return (await tx.cpuJob.updateMany({where:{id,state:'DISPATCHING'},data:{state:'WAITING_INPUT'}})).count===1;
    });
  }
  async start(peer:Peer,id:string):Promise<unknown>{
    await this.owned(peer,id);
    const startedAt=Date.now(),deadline=startedAt+2500,previous=this.starts.get(id),context:StartContext={until:deadline,jobId:id,stage:"QUEUE",retries:0};
    let release!:()=>void;
    const slot=new Promise<void>(resolve=>{release=resolve;});
    const tail=(previous??Promise.resolve()).catch(()=>{}).then(()=>slot);
    this.starts.set(id,tail);
    try{
      if(previous){
        let timer:ReturnType<typeof setTimeout>|undefined;
        try{await Promise.race([previous.catch(()=>{}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('START_BUSY')),Math.max(0,deadline-Date.now()));})]);}
        finally{if(timer)clearTimeout(timer);}
      }
      return await this.startAttempt(peer,id,0,context);
    }catch(error){
      try{
        const data=await this.owned(peer,id),reservation=(await this.allotments.reservations(data.offer.target.deviceId)).find(r=>r.grant.groupId===peer.groupId&&r.grant.holderInstanceId===data.holderId);
        dispatchDiagnostics.record({at:Date.now(),kind:'START_FAILED',groupId:peer.groupId,holderId:data.holderId,jobId:id,
          stage:context.stage,retries:context.retries,code:error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'UNKNOWN',durationMs:Date.now()-startedAt,remainingMs:data.deadlineAt-Date.now(),
          offerVersion:data.offer.allotmentVersion,version:reservation?.grant.version,ackVersion:reservation?.ack?.version,snapshotVersion:data.plan?.snapshotVersion});
      }catch{/* Diagnostic collection cannot replace the original refusal. */}
      throw error;
    }finally{release();if(this.starts.get(id)===tail)void tail.then(()=>{if(this.starts.get(id)===tail)this.starts.delete(id);});}
  }
  private async startAttempt(peer:Peer,id:string,replans=0,wait?:StartContext):Promise<unknown>{
    if(wait){wait.stage="LOAD";wait.retries=replans;}
    let data=await this.owned(peer,id),row=await this.db.cpuJob.findUniqueOrThrow({where:{id}});
    const arranged=await this.db.attempt.findUnique({where:{id}});
    if(arranged){
      if(arranged.groupId!==peer.groupId||arranged.holderInstanceId!==data.holderId||!arranged.offerJson||canonical(JSON.parse(arranged.offerJson))!==canonical(data.offer))throw Error('JOB_RECOVERY_REQUIRED');
      if(data.offer.task.coordinatorEpoch!==this.epoch())await this.store.requestStatus(peer.groupId,data.holderId,this.epoch());
      await this.db.cpuJob.updateMany({where:{id,state:{in:['WAITING_INPUT','DISPATCHING']}},data:{state:'DISPATCHED'}});
      await this.flush();return this.status(peer,id);
    }
    if(!await this.inputReady(peer,data))throw Error('INPUT_NOT_UPLOADED');
    if(row.state==='WAITING_INPUT'){
      if(await this.db.attempt.findUnique({where:{id}})||await this.db.outbox.count({where:{attemptId:id}}))throw Error('JOB_RECOVERY_REQUIRED');
      if(!data.request||!Number.isFinite(data.deadlineAt))throw Error('JOB_REPLAN_REQUIRED');
      const copies=new Map<string,boolean>();
      for(const request of [data.request,...(data.choices??[]).map(c=>c.request)])for(const artifact of request.artifacts){
        if(artifact.id!==data.input.ref.artifactId)continue;
        for(const replica of artifact.replicas){
          if(!replica.localOnly||!replica.holderInstanceId||replica.holderInstanceId===peer.holderInstanceId)continue;
          if(!copies.has(replica.holderInstanceId))copies.set(replica.holderInstanceId,!!await this.directTransfers?.hasInput(peer.groupId,replica.holderInstanceId,data.offer.task.app.appInstanceId,data.input.ref));
        }
        artifact.replicas=artifact.replicas.filter(r=>!r.holderInstanceId||!copies.has(r.holderInstanceId)||copies.get(r.holderInstanceId));
      }
      // A verified direct upload is now an executor-local replica, regardless of
      // whether the latest link model still prefers the original upload route.
      if(await this.directTransfers?.hasInput(peer.groupId,data.holderId,data.offer.task.app.appInstanceId,data.input.ref)){
        for(const request of [data.request,...(data.choices??[]).map(c=>c.request)]){
          const artifact=request.artifacts.find(a=>a.id===data.input.ref.artifactId);
          if(artifact&&!artifact.replicas.some(r=>r.holderInstanceId===data.holderId))artifact.replicas.push({deviceId:data.offer.target.deviceId,holderInstanceId:data.holderId,readMs:0,localOnly:true});
        }
      }
      // A completed relay fallback is an actual replica. Price the remaining
      // download, preserving source-local execution but not a second direct upload.
      if(this.artifacts.available(data.input))for(const request of [data.request,...(data.choices??[]).map(c=>c.request)]){
        const artifact=request.artifacts.find(a=>a.id===data.input.ref.artifactId);
        if(artifact){
          for(const replica of artifact.replicas)if(replica.holderInstanceId)replica.localOnly=true;
          if(!artifact.replicas.some(r=>r.deviceId===this.store.senderInstanceId))artifact.replicas.push({deviceId:this.store.senderInstanceId,readMs:0});
        }
      }
      await this.refreshCopies(data,data.request);
      data.request.remainingBudgetMs=Math.max(0,data.deadlineAt-Date.now()-await this.remainingTail(data));
      if(data.choices)for(const c of data.choices)c.request.remainingBudgetMs=data.request.remainingBudgetMs;
      if(wait)wait.stage="PLAN_AND_CONFIRM";
      let p:Awaited<ReturnType<CpuJobs['choose']>>;
      try{p=await this.choose(peer,data.request,data.choices?.map(c=>c.request),wait);}catch(error){
        if(error instanceof Error&&['ALLOTMENT_UNAVAILABLE','PLAN_STALE','NO_LEGAL_PLAN'].includes(error.message)&&replans<8&&data.deadlineAt>Date.now()+100){await new Promise(resolve=>setTimeout(resolve,100));return this.startAttempt(peer,id,replans+1,wait);}throw error;
      }if(data.choices){data.request=data.choices[p.selected].request;data.offer.task.parameters=data.choices[p.selected].parameters;}
      const placement=p.decision.decision.suggestion![0];
      data.retainOutput=placement.outputEndpointId&&placement.outputEndpointEpoch?{id:placement.outputEndpointId,epoch:placement.outputEndpointEpoch}:undefined;
      if(data.delivery&&(data.holderId!==p.profile.holderInstanceId||data.delivery.senderHolderId!==placement.inputSourceHolderId&&placement.inputSourceHolderId)){
        data.delivery={...data.delivery,id:randomUUID(),senderHolderId:placement.inputSourceHolderId??data.delivery.senderHolderId,senderEndpointId:placement.inputSourceEndpointId??data.delivery.senderEndpointId,senderEpoch:placement.inputSourceEndpointEpoch??data.delivery.senderEpoch,relay:placement.inputRelayId===this.store.senderInstanceId};
      }
      data.plan=p.decision;data.planTiming=p.planTiming;data.decisionEvidence=this.evidence(p);
      data.holderId=p.profile.holderInstanceId;data.offer.target=p.executor.target;data.offer.resources=p.executor.resources;data.offer.allowedConfigs=p.executor.configurations;
      data.offer.task.contract=p.executor.contract;data.offer.task.allowedTargetIds=[p.executor.target.targetId];data.offer.task.allowedConfigurations=p.executor.configurations.map(c=>c.id);
      data.offer.reasonCode=p.decision.decision.reason;
      if(this.localInput(peer,data))data.decisionEvidence!.resultDelivery='ORIGIN_LOCAL';
      const directInput=!!await this.directTransfers?.hasInput(peer.groupId,data.holderId,data.offer.task.app.appInstanceId,data.input.ref);
      data.offer.transferPlan=this.localInput(peer,data)||directInput?[]:[{ref:data.input.ref,from:this.store.senderInstanceId,to:p.executor.target.deviceId,via:null}];
      if(!await this.inputReady(peer,data)){
        // Publish the new input destination so graph polling can prepare it.
        await this.db.cpuJob.updateMany({where:{id,state:'WAITING_INPUT'},data:{metadataJson:JSON.stringify(data)}});
        throw Error('INPUT_NOT_UPLOADED');
      }
      data.offer.allotmentVersion=p.grant.version;data.offer.allotmentId=p.grant.allotmentId;data.offer.task.coordinatorEpoch=this.epoch();
      data.offer.task.budget={remainingMs:Math.max(0,data.deadlineAt-Date.now()),deadlineAt:data.deadlineAt};
      data.offer.leaseMs=data.offer.task.budget.remainingMs;
      await this.db.cpuJob.updateMany({where:{id,state:'WAITING_INPUT'},data:{state:'DISPATCHING',metadataJson:JSON.stringify(data)}});
      row=await this.db.cpuJob.findUniqueOrThrow({where:{id}});data=JSON.parse(row.metadataJson);
    }
    if(row.state==='DISPATCHING'){
      if(data.offer.task.coordinatorEpoch!==this.epoch()){
        const reset=await this.resetUndispatched(id);
        if(reset&&replans<2)return this.startAttempt(peer,id,replans+1,wait);throw Error('JOB_RECOVERY_REQUIRED');
      }
      if(data.deadlineAt<=Date.now())throw Error('BUDGET_EXHAUSTED');
      if(wait)wait.stage="PREFLIGHT";
      if(!data.plan||!await this.planning.preflight(peer.groupId,data.plan,data.request,{now:Date.now(),monotonic:()=>performance.now()},id)){
        if(!await this.resetUndispatched(id))throw Error('JOB_RECOVERY_REQUIRED');
        if(replans<8)return this.startAttempt(peer,id,replans+1,wait);throw Error('PLAN_STALE');
      }
      if(wait)wait.stage="PERSIST_OFFER";
      const offerStart=performance.now();
      try{await this.store.persistOffer(data.offer,data.holderId,{protocolVersion:2,messageId:'job-'+id,type:'DispatchOffer',groupId:peer.groupId,senderInstanceId:this.store.senderInstanceId,
        coordinatorEpoch:this.epoch(),seq:1,ackOf:null,traceId:data.traceId,payload:JSON.stringify(data.offer),extensions:[]},async tx=>{
          const job=await tx.cpuJob.findUnique({where:{id}});if(job?.state!=='DISPATCHING')throw Error('JOB_CANCELLED');
          for(const dependency of data.offer.dependencies){
            const parent=await tx.node.findUnique({where:{id:JSON.stringify([data.offer.task.workflowId,dependency.nodeId])}}),receipt=parent?.currentAttemptId?await tx.receipt.findUnique({where:{id:parent.currentAttemptId}}):null;
            if(parent?.state!=='COMMITTED'||!receipt?.committed)throw Error('GRAPH_DEPENDENCY_UNCOMMITTED');
          }
          const app=await this.apps.context(peer,tx);if(!app.identity.allowedContracts.includes(data.offer.task.contract.contractId))throw Error('APP_CONTRACT_FORBIDDEN');
          await this.apps.reserveJob(tx,peer,id,data.offer.resources,data.deadlineAt);
          const row=await tx.allotment.findUnique({where:{id:JSON.stringify(['allotment',peer.groupId,data.holderId])}}),reservation=row?JSON.parse(row.metadataJson):null;
          if(!reservation||reservation.grant.version!==data.offer.allotmentVersion||reservation.ack?.version!==reservation.grant.version)throw Error('PLAN_STALE');
        });}catch(error){
          if(error instanceof Error&&error.message==='PLAN_STALE'){
            if(!await this.resetUndispatched(id))throw Error('JOB_RECOVERY_REQUIRED');
            if(replans<8)return this.startAttempt(peer,id,replans+1,wait);
          }throw error;
        }
      await this.db.cpuJob.updateMany({where:{id,state:'DISPATCHING'},data:{state:'DISPATCHED'}});
      await this.flush();
      try{if(data.planTiming.clockDomainId===this.traces.clockDomainId)await this.traces.control(data.offer,data.traceId,data.plan.snapshotVersion,'PLAN',data.planTiming.start,data.planTiming.end);
        await this.traces.control(data.offer,data.traceId,data.plan.snapshotVersion,'OFFER',offerStart,performance.now());}catch{} // Telemetry never changes settlement.
    }
    await this.flush();return this.status(peer,id);
  }
  async status(peer:Peer,id:string){
    const d=await this.owned(peer,id),attempt=await this.db.attempt.findUnique({where:{id}}),receipt=await this.db.receipt.findUnique({where:{id}});
    const result=receipt?JSON.parse(receipt.recordJson):null;
    const committed=receipt?.committed===true&&result?.state==='SUCCEEDED'&&d.output&&result.outputs.some((r:any)=>canonical(r)===canonical(d.output!.ref));
    const row=await this.db.cpuJob.findUniqueOrThrow({where:{id}});
    return {jobId:id,state:attempt?.state??row.state,targetId:d.offer.target.targetId,deviceId:d.offer.target.deviceId,traceId:d.traceId,
      decisionEvidence:d.decisionEvidence??null,
      rejection:attempt?.rejectionJson?JSON.parse(attempt.rejectionJson):null,
      dispatch:{coordinatorEpoch:d.offer.task.coordinatorEpoch,planRevision:d.offer.task.planRevision,allotmentId:d.offer.allotmentId,allotmentVersion:d.offer.allotmentVersion},
      outputTicket:committed&&!d.resultReceivedAt&&d.output&&this.artifacts.lookup(peer.groupId,d.output.ref)&&(this.artifacts.available(d.output)||this.localOutput(peer,d))?this.artifacts.issue(d.output,peer,'READ'):null};
  }
  async cancel(peer:Peer,id:string){
    await this.owned(peer,id);
    return this.db.$transaction(async tx=>{
      const attempt=await tx.attempt.findUnique({where:{id}}),row=await tx.cpuJob.findUniqueOrThrow({where:{id}});
      if(attempt){if(attempt.state==='REJECTED'||attempt.recordJson&&JSON.parse(attempt.recordJson).resourcesSettled)return {jobId:id,state:attempt.state};await tx.cpuJob.update({where:{id},data:{state:'CANCEL_REQUESTED'}});return {jobId:id,state:'CANCEL_REQUESTED'};}
      if(['WAITING_INPUT','DISPATCHING'].includes(row.state))await tx.cpuJob.update({where:{id},data:{state:'CANCELLED'}});
      return {jobId:id,state:'CANCELLED'};
    });
  }
  async execution(peer:Peer,id:string,action:string,body:any){
    const row=await this.db.cpuJob.findUnique({where:{id}}),attempt=await this.db.attempt.findUnique({where:{id}});
    if(!row||row.groupId!==peer.groupId||!attempt||attempt.holderInstanceId!==peer.holderInstanceId)throw Error('EXECUTION_SCOPE');
    const d:JobData=JSON.parse(row.metadataJson),offer=d.offer;
    if(offer.target.deviceId!==peer.deviceId)throw Error('EXECUTION_SCOPE');
    if(action==='control')return {cancel:row.state==='CANCEL_REQUESTED',settled:!!attempt.recordJson&&JSON.parse(attempt.recordJson).resourcesSettled===true};
    if(action==='authorize'&&row.state==='CANCEL_REQUESTED')throw Error('CANCEL_REQUESTED');
    if(offer.target.deviceId!==peer.deviceId||offer.task.coordinatorEpoch!==this.epoch()||!['OFFERED','ACCEPTED','RUNNING'].includes(attempt.state))throw Error('EXECUTION_EXPIRED');
    const evidence=await this.directory.qualification(peer,offer.target.targetId);
    if(!['CANARY','ACTIVE'].includes(evidence.admission.state)||!sampleUsableV2(evidence.admission.quality,Date.now(),this.directory.domain))throw Error('CAPABILITY_NOT_QUALIFIED');
    if(action==='retained'&&this.directTransfers)return this.directTransfers.publishOutput(peer,id,body);
    if(action==='authorize')return {offer,snapshotVersion:d.plan?.snapshotVersion??null,inputTicket:this.artifacts.issue(d.input,peer,'READ')};
    if(action==='input')return {ticket:this.artifacts.issue(d.input,peer,'READ')};
    if(action!=='output'||!body||!Number.isSafeInteger(body.bytes)||body.bytes<1||body.bytes>8388608||typeof body.contentHash!=='string'||!/^[a-f0-9]{64}$/.test(body.contentHash)||!offer.task.contract.outputSchemas.includes(body.schemaId))throw Error('OUTPUT_INVALID');
    const output:ArtifactDescriptor={...d.input,ref:{artifactId:'out-'+id,contentVersion:1,contentHash:body.contentHash,schemaId:body.schemaId,schemaVersion:1},bytes:body.bytes};
    if(d.output&&canonical(d.output)!==canonical(output))throw Error('OUTPUT_CONFLICT');
    this.artifacts.register(output);d.output=output;await this.db.cpuJob.update({where:{id},data:{metadataJson:JSON.stringify(d)}});
    if(body.retentionFailure!==undefined){
      if(body.retentionFailure!=='ARTIFACT_CACHE_FULL'||!d.retainOutput)throw Error('OUTPUT_FALLBACK_SCOPE');
      await this.profiles.refresh(peer.groupId);const built=await this.snapshots.build(peer.groupId),now=Date.now(),request={...d.request,remainingBudgetMs:Math.max(0,d.deadlineAt-now-await this.remainingTail(d)),relayCapacity:{deviceId:this.store.senderInstanceId,availableSlots:this.directTransfers?.relaySlots()??0,availableBytes:this.directTransfers?.relayBytes?.(),observedAt:now,ttlMs:1000}};
      const costMs=this.planning.publication(built.snapshot,request,{id:output.ref.artifactId,bytes:output.bytes,replicas:[{deviceId:peer.deviceId,readMs:0}]},this.store.senderInstanceId,built.policy,{now,monotonic:()=>performance.now()});
      d.retainOutput=undefined;d.request.nodes[0].output.retainAtExecutor=false;
      await this.db.cpuJob.update({where:{id},data:{metadataJson:JSON.stringify({...d,outputFallback:{reason:'ARTIFACT_CACHE_FULL',costMs,remainingMs:request.remainingBudgetMs,at:now}})}});
      return {ticket:this.artifacts.issue(output,peer,'WRITE',Math.max(1,Math.min(30000,Math.floor(d.deadlineAt-Date.now())))),delivery:'RELAY'};
    }
    if(d.retainOutput)return {delivery:'RETAINED',descriptor:output,endpoint:d.retainOutput};
    return {ticket:this.artifacts.issue(output,peer,'WRITE'),delivery:this.localOutput(peer,d)?'LOCAL':'RELAY'};
  }
}

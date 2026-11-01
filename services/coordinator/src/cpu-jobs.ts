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

interface JobData {offer:DispatchOfferV2;holderId:string;input:ArtifactDescriptor;output:ArtifactDescriptor|null;traceId:string;
  budgetMs:number;deadlineAt:number;fingerprint?:string;choices?:{request:PlacementRequest;parameters:string}[];
  request:PlacementRequest;plan:SnapshotDecision;planTiming:{start:number;end:number};
  decisionEvidence?:{snapshotVersion:number;policyVersion:string;profileSequence:number;profileSampledAt:number;resultDelivery:string};}
/** First usable single-node submission path. Uses qualified available targets, with an optional explicit target. */
export class CpuJobs {
  constructor(private readonly db:PrismaClient,private readonly directory:DeviceDirectory,private readonly profiles:ProfileProjection,
    private readonly snapshots:SnapshotBuilder,private readonly allotments:AllotmentIssuer,private readonly artifacts:ArtifactChannel,
    private readonly store:CoordinatorStore,private readonly epoch:()=>number,private readonly flush:()=>Promise<void>,
    private readonly planning:PlanningService,private readonly traces:TraceService,private readonly apps:AppRegistry,private readonly packs:ReferencePack[]=builtinCpuPacks()){}
  async submit(peer:Peer,input:any,variants?:{parameters:string;targetId?:string}[],fingerprint?:string){
    const app=await this.apps.context(peer);
    if(!input||!protocolId(input.requestId)||input.requestId.length>100||typeof input.capability!=='string'||typeof input.contentHash!=='string'||!/^[a-f0-9]{64}$/.test(input.contentHash)||
      !Number.isSafeInteger(input.bytes)||input.bytes<1||input.bytes>8388608||input.targetId!==undefined&&!protocolId(input.targetId)||
      input.budgetMs!==undefined&&(!Number.isSafeInteger(input.budgetMs)||input.budgetMs<0||input.budgetMs>30000)||
      input.parameters!==undefined&&(typeof input.parameters!=='string'||Buffer.byteLength(input.parameters)>32768)||
      Object.keys(input).some(k=>!['requestId','capability','contentHash','bytes','targetId','budgetMs','parameters'].includes(k)))throw Error('JOB_INPUT_INVALID');
    const parameters=input.parameters??'{}';try{JSON.parse(parameters);}catch{throw Error('JOB_INPUT_INVALID');}
    const id=input.requestId,existing=await this.db.cpuJob.findUnique({where:{id}});
    if(existing){const d=await this.owned(peer,id);if(d.fingerprint!==fingerprint||(!fingerprint&&d.offer.task.parameters!==parameters)||d.input.ref.contentHash!==input.contentHash||d.input.bytes!==input.bytes||d.offer.task.contract.capability!==input.capability||!fingerprint&&input.targetId&&d.offer.target.targetId!==input.targetId||input.budgetMs!==undefined&&d.budgetMs!==input.budgetMs)throw Error('JOB_CONFLICT');if(existing.state==='CANCELLED')throw Error('JOB_CANCELLED');return this.upload(peer,id,d);}
    const pack=this.packs.find(p=>p.manifest.contract.capability===input.capability);if(!pack)throw Error('CAPABILITY_UNSUPPORTED');
    if(!app.identity.allowedContracts.includes(pack.manifest.contract.contractId))throw Error('APP_CONTRACT_FORBIDDEN');
    const now=Date.now();
    const artifact:ArtifactDescriptor={ref:{artifactId:'in-'+id,contentVersion:1,contentHash:input.contentHash,schemaId:pack.manifest.contract.inputSchemas[0],schemaVersion:1},
      groupId:peer.groupId,ownerPrincipalId:peer.principalId,domain:this.directory.domain,bytes:input.bytes,expiresAt:now+3600000};
    // S1 has one fixed relay path. The planner prices input -> worker -> relay;
    // subsequent source polling/download is not claimed as an end-to-end estimate.
    const request:PlacementRequest={nodes:[{id:'compute',capability:input.capability,dependencies:[],inputs:[artifact.ref.artifactId],
      // Reference numeric/text transforms: bound expansion conservatively rather
      // than pricing every tiny vector result as the global 8 MiB limit.
      // Raster expansion depends on crop/resize parameters; retain its declared maximum.
      output:{id:'out-'+id,bytes:pack.manifest.contract.outputSchemas.includes('image.raster')?pack.maxOutputBytes:Math.min(pack.maxOutputBytes,input.bytes*64+4096)},
      baselineTargetId:input.targetId??'',...(input.targetId?{allowedTargetIds:[input.targetId]}:{}),
      memoryBytes:pack.manifest.resourceLimit.find(r=>r.resourcePoolId==='ram')?.amount??0,minimumQuality:pack.manifest.qualityThreshold,candidates:[]}],
      artifacts:[{id:artifact.ref.artifactId,bytes:artifact.bytes,replicas:[{deviceId:this.store.senderInstanceId,readMs:0}]}],links:[],deviceResources:[],
      domain:this.directory.domain,remainingBudgetMs:input.budgetMs??30000,networkAllowed:true,privacy:'AUTHORIZED_REMOTE',localDeviceId:peer.deviceId,
      now,committedNodeIds:[],committedArtifacts:[],materializeOutputsAt:this.store.senderInstanceId,finalDestination:this.store.senderInstanceId};
    const choices=variants?.map(v=>{const r=structuredClone(request);r.nodes[0].baselineTargetId=v.targetId??'';r.nodes[0].allowedTargetIds=v.targetId?[v.targetId]:undefined;return {request:r,parameters:v.parameters};});
    const planned=await this.choose(peer,request,choices?.map(c=>c.request)),{profile,executor,grant,decision,planTiming}=planned;
    const selectedRequest=choices?.[planned.selected]?.request??request,selectedParameters=choices?.[planned.selected]?.parameters??parameters;
    const offer:DispatchOfferV2={task:{groupId:peer.groupId,sessionId:null,originDeviceId:peer.deviceId,resultDestination:peer.deviceId,workflowId:id,nodeId:'compute',attemptId:id,
      coordinatorEpoch:this.epoch(),planRevision:1,app:app.identity,
      contract:executor.contract,budget:{remainingMs:request.remainingBudgetMs,deadlineAt:now+request.remainingBudgetMs},inputs:[artifact.ref],allowedTargetIds:[executor.target.targetId],qualityTarget:'reference',privacy:'AUTHORIZED_REMOTE',
      priority:'REMOTE_INTERACTIVE',parameters:selectedParameters,allowedConfigurations:executor.configurations.map(c=>c.id),businessIdempotencyKey:null},target:executor.target,resources:executor.resources,allowedConfigs:executor.configurations,
      allotmentId:grant.allotmentId,allotmentVersion:grant.version,leaseMs:request.remainingBudgetMs,
      transferPlan:[{ref:artifact.ref,from:this.store.senderInstanceId,to:executor.target.deviceId,via:null}],dependencies:[],reasonCode:decision.decision.reason};
    const data:JobData={offer,holderId:profile.holderInstanceId,input:artifact,output:null,traceId:randomUUID(),budgetMs:request.remainingBudgetMs,deadlineAt:now+request.remainingBudgetMs,request:selectedRequest,choices,fingerprint,plan:decision,planTiming,
      decisionEvidence:this.evidence(planned)};
    this.artifacts.register(artifact);
    await this.db.$transaction(async tx=>{await this.apps.reserveJob(tx,peer,id,offer.resources,data.deadlineAt);await tx.cpuJob.create({data:{id,groupId:peer.groupId,principalId:peer.principalId,sourceHolderId:peer.holderInstanceId,state:'WAITING_INPUT',metadataJson:JSON.stringify(data)}});});
    return this.upload(peer,id,data);
  }
  private async choose(peer:Peer,request:PlacementRequest,alternatives?:PlacementRequest[]){
    // Empty groups still go through plan(), which owns the refusal reason.
    if((await this.directory.profiles(peer.groupId)).length)await this.profiles.refresh(peer.groupId);
    let built;
    try{built=await this.snapshots.build(peer.groupId);}catch(e){if(!(e instanceof Error)||e.message!=='GROUP_UNKNOWN')throw e;
      built={snapshot:{version:1,policyVersion:peer.groupId,groupId:peer.groupId,domain:this.directory.domain,capturedAt:Date.now(),devices:[],resources:[],candidates:[],links:[]},
        policy:{version:peer.groupId,revoked:false,allowedTargetIds:[],limits:{maxCandidates:64,lookahead:16,beamWidth:8,planningBudgetMs:20,switchCostMs:0,hysteresisMs:0}}};}
    const start=performance.now(),clock={now:Date.now(),monotonic:()=>performance.now()},choice=alternatives?this.planning.alternatives(built.snapshot,alternatives,built.policy,clock):{selected:0,decision:this.planning.plan(built.snapshot,request,built.policy,clock)},decision=choice.decision,end=performance.now();
    const selected=decision.decision.suggestion?.[0];if(!selected)throw Error(decision.decision.reason);
    const profile=(await this.directory.profiles(peer.groupId)).find(p=>p.deviceId===selected.deviceId&&p.executors.some(e=>e.target.targetId===selected.targetId));
    const executor=profile?.executors.find(e=>e.target.targetId===selected.targetId),pack=this.packs.find(p=>p.manifest.contract.capability===request.nodes[0].capability);
    if(!profile||!executor||!pack||canonical(executor.contract)!==canonical(pack.manifest.contract))throw Error('TARGET_UNAVAILABLE');
    const reservation=(await this.allotments.reservations(profile.deviceId)).find(a=>a.grant.groupId===peer.groupId&&a.grant.holderInstanceId===profile.holderInstanceId);
    const grant=reservation?.ack?.version===reservation?.grant.version?reservation?.grant:undefined;
    if(!grant||grant.coordinatorEpoch!==this.epoch())throw Error('ALLOTMENT_UNAVAILABLE');
    return {decision,profile,executor,grant,selected:choice.selected,planTiming:{start,end}};
  }
  private evidence(p:Awaited<ReturnType<CpuJobs['choose']>>){return {snapshotVersion:p.decision.snapshotVersion,policyVersion:p.decision.policyVersion,
    profileSequence:p.profile.sequence,profileSampledAt:p.profile.ownerActivity.sampledAt,resultDelivery:'SOURCE_PULL_NOT_ESTIMATED'};}
  private upload(peer:Peer,id:string,d:JobData){return {jobId:id,targetId:d.offer.target.targetId,deviceId:d.offer.target.deviceId,reason:d.offer.reasonCode,inputTicket:this.artifacts.issue(d.input,peer,'WRITE')};}
  private async owned(peer:Peer,id:string):Promise<JobData>{
    await this.apps.context(peer);
    const row=await this.db.cpuJob.findUnique({where:{id}});if(!row||row.groupId!==peer.groupId||row.principalId!==peer.principalId||row.sourceHolderId!==peer.holderInstanceId)throw Error('JOB_SCOPE');return JSON.parse(row.metadataJson);
  }
  async trace(peer:Peer,id:string){const data=await this.owned(peer,id);return this.traces.read(peer,data.traceId);}
  async writeInput(peer:Peer,id:string,bytes:Buffer){const data=await this.owned(peer,id);await this.artifacts.writeForControl(data.input,bytes);}
  async readOutput(peer:Peer,id:string){const data=await this.owned(peer,id),status=await this.status(peer,id);if(!status.outputTicket||!data.output)throw Error('OUTPUT_NOT_READY');return this.artifacts.readForControl(data.output);}
  async start(peer:Peer,id:string,replans=0):Promise<unknown>{
    let data=await this.owned(peer,id),row=await this.db.cpuJob.findUniqueOrThrow({where:{id}});
    if(!this.artifacts.available(data.input))throw Error('INPUT_NOT_UPLOADED');
    if(row.state==='WAITING_INPUT'){
      if(!data.request||!Number.isFinite(data.deadlineAt))throw Error('JOB_REPLAN_REQUIRED');
      data.request.remainingBudgetMs=Math.max(0,data.deadlineAt-Date.now());
      if(data.choices)for(const c of data.choices)c.request.remainingBudgetMs=data.request.remainingBudgetMs;
      const p=await this.choose(peer,data.request,data.choices?.map(c=>c.request));if(data.choices){data.request=data.choices[p.selected].request;data.offer.task.parameters=data.choices[p.selected].parameters;}
      data.plan=p.decision;data.planTiming=p.planTiming;data.decisionEvidence=this.evidence(p);
      data.holderId=p.profile.holderInstanceId;data.offer.target=p.executor.target;data.offer.resources=p.executor.resources;data.offer.allowedConfigs=p.executor.configurations;
      data.offer.task.contract=p.executor.contract;data.offer.task.allowedTargetIds=[p.executor.target.targetId];data.offer.task.allowedConfigurations=p.executor.configurations.map(c=>c.id);
      data.offer.reasonCode=p.decision.decision.reason;data.offer.transferPlan[0].to=p.executor.target.deviceId;
      data.offer.allotmentVersion=p.grant.version;data.offer.allotmentId=p.grant.allotmentId;data.offer.task.coordinatorEpoch=this.epoch();
      data.offer.task.budget={remainingMs:Math.max(0,data.deadlineAt-Date.now()),deadlineAt:data.deadlineAt};
      data.offer.leaseMs=data.offer.task.budget.remainingMs;
      await this.db.cpuJob.updateMany({where:{id,state:'WAITING_INPUT'},data:{state:'DISPATCHING',metadataJson:JSON.stringify(data)}});
      row=await this.db.cpuJob.findUniqueOrThrow({where:{id}});data=JSON.parse(row.metadataJson);
    }
    if(row.state==='DISPATCHING'){
      if(data.offer.task.coordinatorEpoch!==this.epoch())throw Error('JOB_RECOVERY_REQUIRED');
      if(data.deadlineAt<=Date.now())throw Error('BUDGET_EXHAUSTED');
      if(!data.plan||!await this.planning.preflight(peer.groupId,data.plan,data.request,{now:Date.now(),monotonic:()=>performance.now()})){
        await this.db.cpuJob.updateMany({where:{id,state:'DISPATCHING'},data:{state:'WAITING_INPUT'}});
        if(replans<2)return this.start(peer,id,replans+1);throw Error('PLAN_STALE');
      }
      const offerStart=performance.now();
      try{await this.store.persistOffer(data.offer,data.holderId,{protocolVersion:2,messageId:'job-'+id,type:'DispatchOffer',groupId:peer.groupId,senderInstanceId:this.store.senderInstanceId,
        coordinatorEpoch:this.epoch(),seq:1,ackOf:null,traceId:data.traceId,payload:JSON.stringify(data.offer),extensions:[]},async tx=>{
          const job=await tx.cpuJob.findUnique({where:{id}});if(job?.state!=='DISPATCHING')throw Error('JOB_CANCELLED');
          const app=await this.apps.context(peer,tx);if(!app.identity.allowedContracts.includes(data.offer.task.contract.contractId))throw Error('APP_CONTRACT_FORBIDDEN');
          await this.apps.reserveJob(tx,peer,id,data.offer.resources,data.deadlineAt);
          const row=await tx.allotment.findUnique({where:{id:JSON.stringify(['allotment',peer.groupId,data.holderId])}}),reservation=row?JSON.parse(row.metadataJson):null;
          if(!reservation||reservation.grant.version!==data.offer.allotmentVersion||reservation.ack?.version!==reservation.grant.version)throw Error('PLAN_STALE');
        });}catch(error){
          if(error instanceof Error&&error.message==='PLAN_STALE'){
            await this.db.cpuJob.updateMany({where:{id,state:'DISPATCHING'},data:{state:'WAITING_INPUT'}});
            if(replans<2)return this.start(peer,id,replans+1);
          }throw error;
        }
      await this.db.cpuJob.update({where:{id},data:{state:'DISPATCHED'}});
      await this.flush();
      try{await this.traces.control(data.offer,data.traceId,data.plan.snapshotVersion,'PLAN',data.planTiming.start,data.planTiming.end);
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
      outputTicket:committed&&d.output&&this.artifacts.available(d.output)?this.artifacts.issue(d.output,peer,'READ'):null};
  }
  async cancel(peer:Peer,id:string){
    await this.owned(peer,id);
    return this.db.$transaction(async tx=>{
      const attempt=await tx.attempt.findUnique({where:{id}}),row=await tx.cpuJob.findUniqueOrThrow({where:{id}});
      if(attempt){if(attempt.recordJson&&JSON.parse(attempt.recordJson).resourcesSettled)return {jobId:id,state:attempt.state};throw Error('CANCEL_REQUIRES_HOST');}
      if(['WAITING_INPUT','DISPATCHING'].includes(row.state))await tx.cpuJob.update({where:{id},data:{state:'CANCELLED'}});
      return {jobId:id,state:'CANCELLED'};
    });
  }
  async execution(peer:Peer,id:string,action:string,body:any){
    const row=await this.db.cpuJob.findUnique({where:{id}}),attempt=await this.db.attempt.findUnique({where:{id}});
    if(!row||row.groupId!==peer.groupId||!attempt||attempt.holderInstanceId!==peer.holderInstanceId)throw Error('EXECUTION_SCOPE');
    const d:JobData=JSON.parse(row.metadataJson),offer=d.offer;
    if(offer.target.deviceId!==peer.deviceId||offer.task.coordinatorEpoch!==this.epoch()||!['OFFERED','ACCEPTED','RUNNING'].includes(attempt.state))throw Error('EXECUTION_EXPIRED');
    const evidence=await this.directory.qualification(peer,offer.target.targetId);
    if(!['CANARY','ACTIVE'].includes(evidence.admission.state)||!sampleUsableV2(evidence.admission.quality,Date.now(),this.directory.domain))throw Error('CAPABILITY_NOT_QUALIFIED');
    if(action==='authorize')return {offer,snapshotVersion:d.plan?.snapshotVersion??null,inputTicket:this.artifacts.issue(d.input,peer,'READ')};
    if(action==='input')return {ticket:this.artifacts.issue(d.input,peer,'READ')};
    if(action!=='output'||!body||!Number.isSafeInteger(body.bytes)||body.bytes<1||body.bytes>8388608||typeof body.contentHash!=='string'||!/^[a-f0-9]{64}$/.test(body.contentHash)||!offer.task.contract.outputSchemas.includes(body.schemaId))throw Error('OUTPUT_INVALID');
    const output:ArtifactDescriptor={...d.input,ref:{artifactId:'out-'+id,contentVersion:1,contentHash:body.contentHash,schemaId:body.schemaId,schemaVersion:1},bytes:body.bytes};
    if(d.output&&canonical(d.output)!==canonical(output))throw Error('OUTPUT_CONFLICT');
    this.artifacts.register(output);d.output=output;await this.db.cpuJob.update({where:{id},data:{metadataJson:JSON.stringify(d)}});
    return {ticket:this.artifacts.issue(output,peer,'WRITE')};
  }
}

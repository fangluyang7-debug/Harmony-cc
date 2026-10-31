import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { canonical, DispatchOfferV2, sampleUsableV2, protocolId, PlacementRequest, SnapshotDecision } from '@harmony/scheduler-core';
import { ArtifactChannel, ArtifactDescriptor } from '@harmony/resource-transport';
import { builtinCpuPacks } from '@harmony/reference-capabilities';
import { PrismaClient } from '../generated/client';
import { Peer } from './channel';
import { DeviceDirectory } from './directory';
import { CoordinatorStore } from './store';
import { AllotmentIssuer } from './allotments';
import { ProfileProjection } from './profile-projection';
import { SnapshotBuilder, PlanningService } from './planning';
import { TraceService } from './traces';

interface JobData {offer:DispatchOfferV2;holderId:string;input:ArtifactDescriptor;output:ArtifactDescriptor|null;traceId:string;
  budgetMs:number;deadlineAt:number;
  request:PlacementRequest;plan:SnapshotDecision;planTiming:{start:number;end:number};
  decisionEvidence?:{snapshotVersion:number;policyVersion:string;profileSequence:number;profileSampledAt:number;resultDelivery:string};}
/** First usable single-node submission path. Uses qualified available targets, with an optional explicit target. */
export class CpuJobs {
  constructor(private readonly db:PrismaClient,private readonly directory:DeviceDirectory,private readonly profiles:ProfileProjection,
    private readonly snapshots:SnapshotBuilder,private readonly allotments:AllotmentIssuer,private readonly artifacts:ArtifactChannel,
    private readonly store:CoordinatorStore,private readonly epoch:()=>number,private readonly flush:()=>Promise<void>,
    private readonly planning:PlanningService,private readonly traces:TraceService){}
  async submit(peer:Peer,input:any){
    if(!input||!protocolId(input.requestId)||input.requestId.length>100||typeof input.capability!=='string'||typeof input.contentHash!=='string'||!/^[a-f0-9]{64}$/.test(input.contentHash)||
      !Number.isSafeInteger(input.bytes)||input.bytes<1||input.bytes>8388608||input.targetId!==undefined&&!protocolId(input.targetId)||
      input.budgetMs!==undefined&&(!Number.isSafeInteger(input.budgetMs)||input.budgetMs<0||input.budgetMs>30000)||
      Object.keys(input).some(k=>!['requestId','capability','contentHash','bytes','targetId','budgetMs'].includes(k)))throw Error('JOB_INPUT_INVALID');
    const id=input.requestId,existing=await this.db.cpuJob.findUnique({where:{id}});
    if(existing){const d=await this.owned(peer,id);if(d.input.ref.contentHash!==input.contentHash||d.input.bytes!==input.bytes||d.offer.task.contract.capability!==input.capability||input.targetId&&d.offer.target.targetId!==input.targetId||input.budgetMs!==undefined&&d.budgetMs!==input.budgetMs)throw Error('JOB_CONFLICT');return this.upload(peer,id,d);}
    const pack=builtinCpuPacks().find(p=>p.manifest.contract.capability===input.capability);if(!pack)throw Error('CAPABILITY_UNSUPPORTED');
    const now=Date.now();
    const artifact:ArtifactDescriptor={ref:{artifactId:'in-'+id,contentVersion:1,contentHash:input.contentHash,schemaId:pack.manifest.contract.inputSchemas[0],schemaVersion:1},
      groupId:peer.groupId,ownerPrincipalId:peer.principalId,domain:this.directory.domain,bytes:input.bytes,expiresAt:now+3600000};
    // S1 has one fixed relay path. The planner prices input -> worker -> relay;
    // subsequent source polling/download is not claimed as an end-to-end estimate.
    const request:PlacementRequest={nodes:[{id:'compute',capability:input.capability,dependencies:[],inputs:[artifact.ref.artifactId],
      // Reference numeric/text transforms: bound expansion conservatively rather
      // than pricing every tiny vector result as the global 8 MiB limit.
      output:{id:'out-'+id,bytes:Math.min(pack.maxOutputBytes,input.bytes*64+4096)},
      baselineTargetId:input.targetId??'',...(input.targetId?{allowedTargetIds:[input.targetId]}:{}),
      memoryBytes:pack.manifest.resourceLimit.find(r=>r.resourcePoolId==='ram')?.amount??0,minimumQuality:pack.manifest.qualityThreshold,candidates:[]}],
      artifacts:[{id:artifact.ref.artifactId,bytes:artifact.bytes,replicas:[{deviceId:this.store.senderInstanceId,readMs:0}]}],links:[],deviceResources:[],
      domain:this.directory.domain,remainingBudgetMs:input.budgetMs??30000,networkAllowed:true,privacy:'AUTHORIZED_REMOTE',localDeviceId:peer.deviceId,
      now,committedNodeIds:[],committedArtifacts:[],materializeOutputsAt:this.store.senderInstanceId,finalDestination:this.store.senderInstanceId};
    const planned=await this.choose(peer,request),{profile,executor,grant,decision,planTiming}=planned;
    const key={groupId:peer.groupId,principalId:peer.principalId,holderInstanceId:peer.holderInstanceId};
    const app=await this.db.consoleApp.upsert({where:{groupId_principalId_holderInstanceId:key},
      create:{id:randomUUID(),...key,appId:randomUUID(),appInstanceId:randomUUID()},update:{}});
    const offer:DispatchOfferV2={task:{groupId:peer.groupId,sessionId:null,originDeviceId:peer.deviceId,resultDestination:peer.deviceId,workflowId:id,nodeId:'compute',attemptId:id,
      coordinatorEpoch:this.epoch(),planRevision:1,app:{groupId:peer.groupId,principalId:peer.principalId,appId:app.appId,appInstanceId:app.appInstanceId,allowedContracts:[pack.manifest.contract.contractId]},
      contract:executor.contract,budget:{remainingMs:request.remainingBudgetMs,deadlineAt:now+request.remainingBudgetMs},inputs:[artifact.ref],allowedTargetIds:[executor.target.targetId],qualityTarget:'reference',privacy:'AUTHORIZED_REMOTE',
      priority:'REMOTE_INTERACTIVE',parameters:'{}',allowedConfigurations:executor.configurations.map(c=>c.id),businessIdempotencyKey:null},target:executor.target,resources:executor.resources,allowedConfigs:executor.configurations,
      allotmentId:grant.allotmentId,allotmentVersion:grant.version,leaseMs:request.remainingBudgetMs,
      transferPlan:[{ref:artifact.ref,from:this.store.senderInstanceId,to:executor.target.deviceId,via:null}],dependencies:[],reasonCode:decision.decision.reason};
    const data:JobData={offer,holderId:profile.holderInstanceId,input:artifact,output:null,traceId:randomUUID(),budgetMs:request.remainingBudgetMs,deadlineAt:now+request.remainingBudgetMs,request,plan:decision,planTiming,
      decisionEvidence:this.evidence(planned)};
    this.artifacts.register(artifact);
    await this.db.cpuJob.create({data:{id,groupId:peer.groupId,principalId:peer.principalId,sourceHolderId:peer.holderInstanceId,state:'WAITING_INPUT',metadataJson:JSON.stringify(data)}});
    return this.upload(peer,id,data);
  }
  private async choose(peer:Peer,request:PlacementRequest){
    // Empty groups still go through plan(), which owns the refusal reason.
    if((await this.directory.profiles(peer.groupId)).length)await this.profiles.refresh(peer.groupId);
    let built;
    try{built=await this.snapshots.build(peer.groupId);}catch(e){if(!(e instanceof Error)||e.message!=='GROUP_UNKNOWN')throw e;
      built={snapshot:{version:1,policyVersion:peer.groupId,groupId:peer.groupId,domain:this.directory.domain,capturedAt:Date.now(),devices:[],resources:[],candidates:[],links:[]},
        policy:{version:peer.groupId,revoked:false,allowedTargetIds:[],limits:{maxCandidates:64,lookahead:16,beamWidth:8,planningBudgetMs:20,switchCostMs:0,hysteresisMs:0}}};}
    const start=performance.now(),decision=this.planning.plan(built.snapshot,request,built.policy,{now:Date.now(),monotonic:()=>performance.now()}),end=performance.now();
    const selected=decision.decision.suggestion?.[0];if(!selected)throw Error(decision.decision.reason);
    const profile=(await this.directory.profiles(peer.groupId)).find(p=>p.deviceId===selected.deviceId&&p.executors.some(e=>e.target.targetId===selected.targetId));
    const executor=profile?.executors.find(e=>e.target.targetId===selected.targetId),pack=builtinCpuPacks().find(p=>p.manifest.contract.capability===request.nodes[0].capability);
    if(!profile||!executor||!pack||canonical(executor.contract)!==canonical(pack.manifest.contract))throw Error('TARGET_UNAVAILABLE');
    const grant=(await this.allotments.reservations(profile.deviceId)).find(a=>a.grant.groupId===peer.groupId&&a.grant.holderInstanceId===profile.holderInstanceId)?.grant;
    if(!grant||grant.coordinatorEpoch!==this.epoch())throw Error('ALLOTMENT_UNAVAILABLE');
    return {decision,profile,executor,grant,planTiming:{start,end}};
  }
  private evidence(p:Awaited<ReturnType<CpuJobs['choose']>>){return {snapshotVersion:p.decision.snapshotVersion,policyVersion:p.decision.policyVersion,
    profileSequence:p.profile.sequence,profileSampledAt:p.profile.ownerActivity.sampledAt,resultDelivery:'SOURCE_PULL_NOT_ESTIMATED'};}
  private upload(peer:Peer,id:string,d:JobData){return {jobId:id,targetId:d.offer.target.targetId,deviceId:d.offer.target.deviceId,reason:d.offer.reasonCode,inputTicket:this.artifacts.issue(d.input,peer,'WRITE')};}
  private async owned(peer:Peer,id:string):Promise<JobData>{
    const row=await this.db.cpuJob.findUnique({where:{id}});if(!row||row.groupId!==peer.groupId||row.principalId!==peer.principalId||row.sourceHolderId!==peer.holderInstanceId)throw Error('JOB_SCOPE');return JSON.parse(row.metadataJson);
  }
  async trace(peer:Peer,id:string){const data=await this.owned(peer,id);return this.traces.read(peer,data.traceId);}
  async start(peer:Peer,id:string,replans=0):Promise<unknown>{
    let data=await this.owned(peer,id),row=await this.db.cpuJob.findUniqueOrThrow({where:{id}});
    if(!this.artifacts.available(data.input))throw Error('INPUT_NOT_UPLOADED');
    if(row.state==='WAITING_INPUT'){
      if(!data.request||!Number.isFinite(data.deadlineAt))throw Error('JOB_REPLAN_REQUIRED');
      data.request.remainingBudgetMs=Math.max(0,data.deadlineAt-Date.now());
      const p=await this.choose(peer,data.request);data.plan=p.decision;data.planTiming=p.planTiming;data.decisionEvidence=this.evidence(p);
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
      await this.store.persistOffer(data.offer,data.holderId,{protocolVersion:2,messageId:'job-'+id,type:'DispatchOffer',groupId:peer.groupId,senderInstanceId:this.store.senderInstanceId,
        coordinatorEpoch:this.epoch(),seq:1,ackOf:null,traceId:data.traceId,payload:JSON.stringify(data.offer),extensions:[]});
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
    return {jobId:id,state:attempt?.state??'WAITING_INPUT',targetId:d.offer.target.targetId,deviceId:d.offer.target.deviceId,traceId:d.traceId,
      decisionEvidence:d.decisionEvidence??null,
      rejection:attempt?.rejectionJson?JSON.parse(attempt.rejectionJson):null,
      dispatch:{coordinatorEpoch:d.offer.task.coordinatorEpoch,planRevision:d.offer.task.planRevision,allotmentId:d.offer.allotmentId,allotmentVersion:d.offer.allotmentVersion},
      outputTicket:committed&&d.output&&this.artifacts.available(d.output)?this.artifacts.issue(d.output,peer,'READ'):null};
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

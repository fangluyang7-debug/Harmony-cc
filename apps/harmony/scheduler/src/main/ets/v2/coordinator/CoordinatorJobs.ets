import { util } from '@kit.ArkTS';
import { CoordinatorDatabase, CoordinatorTransaction } from './CoordinatorDatabase';
import { CoordinatorPeer } from './CoordinatorCredentials';
import { CoordinatorChannel } from './CoordinatorChannel';
import { nativeGpuQueueAllowed } from './CoordinatorDispatchCapacity';
import { CoordinatorArtifacts, CoordinatorArtifact } from './CoordinatorArtifacts';
import { CoordinatorQualification, CoordinatorQualificationEvidence } from './CoordinatorQualification';
import { CoordinatorReservation } from './CoordinatorAllotments';
import { SdkSubmission, SdkWorkflow, SdkNode, SdkPlan, SdkStatus, SdkTicket } from '../client/SchedulerSdk';
import { DeviceProfileV2, DispatchOfferV2, AdmissionReplyV2, ExecutionReportV2, AttemptStatusReplyV2, YieldNoticeV2, validAdmissionReplyV2, validExecutionReportV2, validAttemptStatusReplyV2, validYieldNoticeV2, validDispatchOfferV2, TransferHopV2 } from '../protocol/ResourcesV2';
import { AttemptRecordV2, ExecutionReceiptV2, MessageEnvelopeV2, TraceSpanV2, TaskContractV2, ArtifactRefV2, AttemptStatusQueryV2, validTraceSpanV2 } from '../protocol/SchedulingProtocolV2';
import { canonical } from '../core/CanonicalV2';
import { hash, bytes, monotonic } from '../platform/NativeTransport';
import { nativePlanJson } from './generated/PlanningCore';
interface InternalDispatch {target:Object;}
interface JobAck {jobId:string;state?:string;}
interface ResultAck {acknowledged:boolean;}
interface ResultReceived {ref:Object;bytes:number;}
interface ExecutionControl {cancel:boolean;settled:boolean;}
interface Authorization {offer:DispatchOfferV2;snapshotVersion:number;inputTicket:SdkTicket;qualification:CoordinatorQualificationEvidence;}
interface TicketResponse {ticket:SdkTicket;delivery?:string;}
interface PerformanceRow {job:string;span:string;}
interface PlanInput {originLocal:boolean;backlog:string[];history:PerformanceRow[];id:string;groupId:string;originDeviceId:string;originHolderId:string;appInstanceId:string;coordinatorId:string;artifactId:string;priority:string;budgetMs:number;node:SdkNode;contract:TaskContractV2;}
interface ExecutionIdentity {inputs:ArtifactRefV2[];contract:TaskContractV2;parameters:string;allowedTargetIds:string[];allowedConfigurations:string[];}
interface NativeJob {restartable?:boolean;settlement?:ExecutionReceiptV2;yieldNotice?:YieldNoticeV2;originLocal?:boolean;owner:CoordinatorPeer;submission:SdkSubmission;digest:string;input:CoordinatorArtifact;output:CoordinatorArtifact|null;offer:DispatchOfferV2|null;holder:string;state:string;deadlineAt:number;traceId:string;decision:string;executionIdentity?:string;startup?:string;rejection?:AdmissionReplyV2;createdAt?:number;offeredAt?:number;acceptedAt?:number;settledAt?:number;}
interface Choice {targetId:string;deviceId:string;finishMs:number;}
interface DecisionBody {status:string;suggestion:Choice[]|null;reason:string;}
interface NativeDecision {snapshotVersion:number;decision:DecisionBody;}
interface NativeCandidate {profile:DeviceProfileV2;peer:CoordinatorPeer;grant:CoordinatorReservation;evidence:CoordinatorQualificationEvidence;}
interface OutputRequest {contentHash:string;bytes:number;schemaId:string;}
interface TraceBatch {spans:TraceSpanV2[];}
function exact(value:Object,required:string[],optional:string[]=[]):boolean{return value!==null&&typeof value==='object'&&!Array.isArray(value)&&required.every(k=>Object.keys(value).includes(k))&&Object.keys(value).every(k=>required.includes(k)||optional.includes(k));}
function id(value:string):boolean{return typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/.test(value);}
function digest(offer:DispatchOfferV2):string{const t=offer.task;return hash(bytes(canonical({inputs:t.inputs,contract:t.contract,parameters:t.parameters,allowedTargetIds:t.allowedTargetIds,allowedConfigurations:t.allowedConfigurations} as ExecutionIdentity)));}
/** Native job service uses durable offers and the shared main-branch planner. */
export class CoordinatorJobs {
 onChanged:(()=>void)|null=null;
 private wake():void{setTimeout(()=>{this.onChanged?.();},0);}
 private history:PerformanceRow[]=[];
 private historyDirty:boolean=true;
 private timer:number=-1;
 private database:CoordinatorDatabase;
 private channel:CoordinatorChannel;
 private artifacts:CoordinatorArtifacts;
 private qualification:CoordinatorQualification;
 private coordinatorId:string;
 private epoch:number;
 constructor(database:CoordinatorDatabase,channel:CoordinatorChannel,artifacts:CoordinatorArtifacts,qualification:CoordinatorQualification,coordinatorId:string,epoch:number){this.database=database;this.channel=channel;this.artifacts=artifacts;this.qualification=qualification;this.coordinatorId=coordinatorId;this.epoch=epoch;
  channel.register('AdmissionReply',{validate:p=>validAdmissionReplyV2(p as AdmissionReplyV2),handle:(tx,peer,p)=>this.admission(tx,peer,p as AdmissionReplyV2)});
  channel.register('ExecutionReceipt',{validate:p=>validExecutionReportV2(p as ExecutionReportV2),handle:(tx,peer,p)=>this.receipt(tx,peer,p as ExecutionReportV2)});
  channel.register('TraceBatch',{validate:p=>exact(p,['spans'])&&Array.isArray((p as TraceBatch).spans)&&(p as TraceBatch).spans.length<=128&&(p as TraceBatch).spans.every(s=>validTraceSpanV2(s)),handle:(tx,peer,p)=>this.trace(tx,peer,p as TraceBatch)});
  channel.register('YieldNotice',{validate:p=>validYieldNoticeV2(p as YieldNoticeV2),handle:async(tx,peer,p):Promise<void>=>{const v=p as YieldNoticeV2;await this.executionJob(tx,peer,v.attemptId);await tx.executeSql('UPDATE Attempt SET yieldJson=? WHERE id=?',[JSON.stringify(v),v.attemptId]);}});
  channel.register('RecoveryRequest',{validate:p=>exact(p,[]),handle:(tx,peer)=>this.recover(tx,peer)});
  channel.register('AttemptStatusReply',{validate:p=>validAttemptStatusReplyV2(p as AttemptStatusReplyV2),handle:(tx,peer,p)=>this.recovered(tx,peer,p as AttemptStatusReplyV2)});
 }
 start():void{this.timer=setInterval(()=>{void this.channel.pump().catch(()=>{});},500);}
 close():void{if(this.timer!==-1)clearInterval(this.timer);this.timer=-1;}
 private async load(tx:CoordinatorTransaction,id:string):Promise<NativeJob>{const rows=await tx.querySql('SELECT metadataJson FROM CpuJob WHERE id=?',[id]);try{if(!rows.goToFirstRow())throw Error('JOB_UNKNOWN');return JSON.parse(rows.getString(0)) as NativeJob;}finally{rows.close();}}
 private async save(tx:CoordinatorTransaction,id:string,job:NativeJob):Promise<void>{await tx.executeSql('UPDATE CpuJob SET state=?,metadataJson=? WHERE id=?',[job.state,JSON.stringify(job),id]);}
 private async owned(tx:CoordinatorTransaction,peer:CoordinatorPeer,id:string):Promise<NativeJob>{const job=await this.load(tx,id);if(peer.groupId!==job.owner.groupId||peer.principalId!==job.owner.principalId||peer.app?.appInstanceId!==job.owner.app?.appInstanceId||peer.holderInstanceId!==job.owner.holderInstanceId)throw Error('JOB_SCOPE');return job;}
 private async executionJob(tx:CoordinatorTransaction,peer:CoordinatorPeer,id:string):Promise<NativeJob>{const job=await this.load(tx,id);if(!job.offer||job.owner.groupId!==peer.groupId||job.holder!==peer.holderInstanceId||job.offer.target.deviceId!==peer.deviceId)throw Error('EXECUTION_SCOPE');return job;}
 private async candidates(tx:CoordinatorTransaction,job:NativeJob):Promise<NativeCandidate[]>{
  const result:NativeCandidate[]=[],rows=await tx.querySql('SELECT id,metadataJson FROM DeviceInstance WHERE groupId=?',[job.owner.groupId]),profiles:DeviceProfileV2[]=[];
  try{while(rows.goToNextRow())if(rows.getString(0).startsWith('["profile",'))profiles.push(JSON.parse(rows.getString(1)) as DeviceProfileV2);}finally{rows.close();}
  for(const profile of profiles){
   if(this.database.controlState?.(job.owner.groupId,profile.holderInstanceId,profile.deviceInstanceId,profile.ledgerEpoch)!=='ONLINE')continue;
   const grants=await tx.querySql('SELECT metadataJson FROM Allotment WHERE id=?',[JSON.stringify(['allotment',job.owner.groupId,profile.holderInstanceId])]);let grant:CoordinatorReservation|null=null;try{if(grants.goToFirstRow())grant=JSON.parse(grants.getString(0)) as CoordinatorReservation;}finally{grants.close();}
   if(!grant||grant.grant.coordinatorEpoch!==this.epoch||grant.grant.ledgerEpoch!==profile.ledgerEpoch||grant.ack?.version!==grant.grant.version||!grant.ack.persisted||grant.grant.appInstanceId!==null&&grant.grant.appInstanceId!==job.owner.app?.appInstanceId)continue;
   // A validated settled receipt is newer evidence than a heartbeat still listing that attempt.
   // Release only those exact reported reservations, never unrelated or merely predicted work.
   const settled=await tx.querySql('SELECT a.id,a.offerJson,r.recordJson FROM Attempt a JOIN Receipt r ON r.attemptId=a.id WHERE a.groupId=? AND a.holderInstanceId=? ORDER BY a.rowid DESC LIMIT 64',[job.owner.groupId,profile.holderInstanceId]);
   try{while(settled.goToNextRow()){
    const attempt=settled.getString(0),flight=profile.inFlight?.find(f=>f.attemptId===attempt);if(!flight)continue;
    const receipt=JSON.parse(settled.getString(2)) as ExecutionReceiptV2,offer=JSON.parse(settled.getString(1)) as DispatchOfferV2;
    if(!receipt.resourcesSettled||receipt.fence.ledgerEpoch!==profile.ledgerEpoch||receipt.coordinatorEpoch!==this.epoch)continue;
    for(const r of flight.resources){const pool=profile.pools.find(p=>p.resourcePoolId===r.resourcePoolId);if(pool&&pool.occupied.value!==null)pool.occupied.value=Math.max(0,pool.occupied.value-r.amount);}
    profile.inFlight=profile.inFlight!.filter(f=>f.attemptId!==attempt);
    const credit=profile.credits.find(c=>c.priority===offer.task.priority);if(credit)credit.slots++;
   }}finally{settled.close();}
   // Account for durable offers not yet present in telemetry instead of blocking the entire holder.
   const pending=await tx.querySql("SELECT id,offerJson FROM Attempt WHERE groupId=? AND holderInstanceId=? AND state IN ('OFFERED','ACCEPTED','RUNNING','CANCEL_REQUESTED')",[job.owner.groupId,profile.holderInstanceId]);
   try{while(pending.goToNextRow()){
    const attempt=pending.getString(0);if(profile.inFlight?.some(f=>f.attemptId===attempt)||profile.queued?.some(q=>q.attemptId===attempt))continue;
    const offer=JSON.parse(pending.getString(1)) as DispatchOfferV2;
    for(const r of offer.resources){const pool=profile.pools.find(p=>p.resourcePoolId===r.resourcePoolId);if(pool&&pool.occupied.value!==null)pool.occupied.value+=r.amount;}
    const credit=profile.credits.find(c=>c.priority===offer.task.priority);if(credit)credit.slots=Math.max(0,credit.slots-1);
   }}finally{pending.close();}
   const peer:CoordinatorPeer={groupId:job.owner.groupId,deviceId:profile.deviceId,holderInstanceId:profile.holderInstanceId,principalId:job.owner.principalId,credentialId:''};
   for(const e of profile.executors){if(e.contract.capability!==(job.submission.workflow as SdkWorkflow).nodes[0].capability)continue;const evidence=await this.qualification.evidence(tx,peer,e.target.targetId,profile);if(evidence.admission.state==='ACTIVE')result.push({profile,peer,grant,evidence});}
  }return result;
 }
 private async choose(tx:CoordinatorTransaction,job:NativeJob,id:string):Promise<void>{
  const candidates=await this.candidates(tx,job);if(!candidates.length)throw Error('NO_LEGAL_PLAN');
  const workflow=job.submission.workflow as SdkWorkflow,node=workflow.nodes[0],contract=candidates[0].evidence.executor.contract;
  if(!job.owner.app!.allowedContracts.includes(contract.contractId)||!contract.inputSchemas.includes(node.input!.schemaId)||!contract.outputSchemas.includes(workflow.outputContract)||contract.sideEffectPolicy!=='PURE')throw Error('SDK_CONTRACT_INVALID');
  const profiles:DeviceProfileV2[]=[];for(const candidate of candidates)if(!profiles.some(p=>p.holderInstanceId===candidate.profile.holderInstanceId))profiles.push(candidate.profile);
  if(this.historyDirty){const rows=await tx.querySql("SELECT j.metadataJson,t.metadataJson FROM TraceSpan t JOIN CpuJob j ON j.id=json_extract(t.metadataJson,'$.attemptId') WHERE j.state='SUCCEEDED' AND json_extract(t.metadataJson,'$.phase')='EXECUTE' AND json_extract(t.metadataJson,'$.snapshotVersion')>? ORDER BY t.rowid DESC LIMIT 96",[Date.now()-600000]);const history:PerformanceRow[]=[];try{while(rows.goToNextRow())history.push({job:rows.getString(0),span:rows.getString(1)});}finally{rows.close();}this.history=history;this.historyDirty=false;}
  const backlog:string[]=[],pendingJobs=await tx.querySql("SELECT metadataJson FROM CpuJob WHERE groupId=? AND state IN ('OFFERED','ACCEPTED','RUNNING','CANCEL_REQUESTED') LIMIT 128",[job.owner.groupId]);try{while(pendingJobs.goToNextRow())backlog.push(pendingJobs.getString(0));}finally{pendingJobs.close();}
  const request:PlanInput={originLocal:job.originLocal===true,backlog,history:this.history,id,groupId:job.owner.groupId,originDeviceId:job.owner.deviceId,originHolderId:job.owner.holderInstanceId,appInstanceId:job.owner.app!.appInstanceId,coordinatorId:this.coordinatorId,artifactId:job.input.ref.artifactId,priority:job.submission.options.priority??'REMOTE_INTERACTIVE',budgetMs:Math.max(0,job.deadlineAt-Date.now()),node,contract};
  const planned=nativePlanJson(JSON.stringify(profiles),JSON.stringify(candidates.map(c=>c.evidence)),JSON.stringify(request),Date.now(),monotonic),decision=JSON.parse(planned) as NativeDecision;
  const chosen=decision.decision.suggestion?.[0],candidate=candidates.find(c=>c.evidence.executor.target.targetId===chosen?.targetId);if(!chosen||!candidate)throw Error('NO_LEGAL_PLAN');
  const selectedExecutor=candidate.evidence.executor;
  // Keep a faster GPU supplied while its earlier work computes/uploads. This is
  // a bounded queue offer, never a claim that occupied resources are free.
  const immediate=candidate.profile.credits.some(c=>c.priority===(job.submission.options.priority??'REMOTE_INTERACTIVE')&&c.slots>0)&&!selectedExecutor.resources.some(r=>{const pool=candidate.profile.pools.find(p=>p.resourcePoolId===r.resourcePoolId);return !pool||pool.admissionLimit.value===null||pool.occupied.value===null||pool.admissionLimit.value-pool.occupied.value<r.amount;});
  const outstanding=backlog.map(raw=>JSON.parse(raw) as NativeJob).filter(j=>j.holder===candidate.peer.holderInstanceId).map(j=>j.offer!.task.attemptId);
  if(!immediate&&!nativeGpuQueueAllowed(candidate.profile,selectedExecutor,outstanding,chosen.finishMs,job.deadlineAt-Date.now(),Date.now()))throw Error('NO_LEGAL_PLAN');
  job.executionIdentity=candidate.evidence.admission.identity;job.startup=selectedExecutor.startup;
  const e=candidate.evidence.executor,g=candidate.grant.grant,remaining=Math.max(1,Math.floor(job.deadlineAt-Date.now()));
  const offer:DispatchOfferV2={task:{groupId:job.owner.groupId,sessionId:null,originDeviceId:job.owner.deviceId,resultDestination:job.owner.deviceId,workflowId:id,nodeId:node.id,attemptId:id,coordinatorEpoch:this.epoch,planRevision:1,app:job.owner.app!,contract:e.contract,budget:{remainingMs:remaining,deadlineAt:job.deadlineAt},inputs:[job.input.ref],allowedTargetIds:[e.target.targetId],qualityTarget:'reference',privacy:node.privacy==='LOCAL_ONLY'?'LOCAL_ONLY':'AUTHORIZED_REMOTE',priority:job.submission.options.priority??'REMOTE_INTERACTIVE',parameters:node.parameters,allowedConfigurations:e.configurations.map(c=>c.id),businessIdempotencyKey:null},target:e.target,resources:e.resources,allowedConfigs:e.configurations,allotmentId:g.allotmentId,allotmentVersion:g.version,leaseMs:remaining,transferPlan:job.originLocal?[]:[{ref:job.input.ref as ArtifactRefV2,from:this.coordinatorId,to:e.target.deviceId,via:null} as TransferHopV2],dependencies:[],reasonCode:decision.decision.reason};
  if(!validDispatchOfferV2(offer))throw Error('DISPATCH_INVALID');job.offer=offer;job.holder=candidate.profile.holderInstanceId;job.decision=planned;
 }
 async submit(peer:CoordinatorPeer,body:SdkSubmission,source?:CoordinatorArtifact,start:boolean=false,sourceLocal:boolean=false):Promise<Object>{
  const w=body?.workflow as SdkWorkflow,o=body?.options,n=w?.nodes?.[0];
  if(!peer.app||!exact(body,['workflow','options'])||!exact(o,['requestId','budgetMs','resultDestination'],['inputLocation','priority'])||!id(o.requestId)||!Number.isSafeInteger(o.budgetMs)||o.budgetMs<1||o.budgetMs>300000||o.resultDestination!=='ORIGIN'||o.priority!==undefined&&!['REMOTE_INTERACTIVE','REMOTE_BATCH'].includes(o.priority)||o.inputLocation!==undefined&&o.inputLocation!=='ORIGIN')throw Error('SDK_SUBMISSION_INVALID');
  if(!exact(w,['version','id','outputContract','qualityTarget','nodes'])||w.version!==3||!id(w.id)||w.qualityTarget!=='reference'||w.nodes.length!==1||!exact(n,['id','capability','input','parameters','dependsOn'],['targetId','executionScope','effects','privacy'])||!id(n.id)||n.dependsOn.length!==0||n.effects!==undefined&&n.effects!=='PURE'||n.executionScope!==undefined&&n.executionScope!=='ORIGIN_DEVICE'||n.privacy!==undefined&&!['SHARED','LOCAL_ONLY'].includes(n.privacy)||n.targetId!==undefined&&!id(n.targetId)||typeof n.parameters!=='string'||bytes(n.parameters).length>32768)throw Error('SDK_WORKFLOW_INVALID');
  if(sourceLocal&&(!source||!start||n.executionScope!=='ORIGIN_DEVICE'||o.inputLocation!=='ORIGIN'))throw Error('LOCAL_INPUT_SCOPE');
  JSON.parse(n.parameters);const input=n.input!;if(!exact(input,['contentHash','bytes','schemaId','schemaVersion'])||!/^[a-f0-9]{64}$/.test(input.contentHash)||!Number.isSafeInteger(input.bytes)||input.bytes<1||input.bytes>8388608||input.schemaVersion!==1)throw Error('SDK_INPUT_INVALID');
  let result:Object=new Object();await this.database.transaction(async(tx:CoordinatorTransaction):Promise<void>=>{
   const fingerprint=hash(bytes(canonical(body))),rows=await tx.querySql('SELECT id FROM CpuJob WHERE id=?',[o.requestId]);let exists=false;try{exists=rows.goToFirstRow();}finally{rows.close();}
   let job:NativeJob;
   if(exists){job=await this.owned(tx,peer,o.requestId);if(job.digest!==fingerprint&&(!start||canonical(job.submission.workflow)!==canonical(body.workflow)||job.input.ref.contentHash!==source?.ref.contentHash))throw Error('JOB_CONFLICT');}
   else{job={originLocal:sourceLocal,owner:peer,submission:body,digest:fingerprint,input:{groupId:peer.groupId,ownerPrincipalId:peer.principalId,ref:{artifactId:'in-'+o.requestId,contentVersion:1,contentHash:input.contentHash,schemaId:input.schemaId,schemaVersion:1},bytes:input.bytes,expiresAt:Date.now()+3600000},output:null,offer:null,holder:'',state:'WAITING_INPUT',createdAt:Date.now(),deadlineAt:Date.now()+o.budgetMs,traceId:util.generateRandomUUID(true),decision:''};if(source){if(source.groupId!==peer.groupId||source.ownerPrincipalId!==peer.principalId||source.ref.contentHash!==input.contentHash||source.ref.schemaId!==input.schemaId||source.bytes!==input.bytes)throw Error('INPUT_SCOPE');job.input=source;}if(start&&(!source||!job.originLocal&&!await this.artifacts.available(tx,job.input)))throw Error('INPUT_NOT_UPLOADED');await this.choose(tx,job,o.requestId);await tx.executeSql('INSERT INTO CpuJob (id,groupId,principalId,sourceHolderId,state,metadataJson) VALUES (?,?,?,?,?,?)',[o.requestId,peer.groupId,peer.principalId,peer.holderInstanceId,job.state,JSON.stringify(job)]);}
   if(start){if(job.state==='WAITING_INPUT'){if(exists)await this.choose(tx,job,o.requestId);await this.enqueueJob(tx,job,o.requestId);}result={target:job.offer!.target} as InternalDispatch;return;}
   result={jobId:o.requestId,targetId:job.offer!.target.targetId,deviceId:job.offer!.target.deviceId,reason:job.offer!.reasonCode,inputDelivery:'RELAY',inputTicket:await this.artifacts.issue(tx,job.input,peer,'WRITE')} as SdkPlan;
  });if(start)void this.channel.pump().catch(()=>{});return result;
 }
 async inspect(peer:CoordinatorPeer,id:string):Promise<string>{let value='';await this.database.transaction(async(tx:CoordinatorTransaction):Promise<void>=>{value=JSON.stringify(await this.owned(tx,peer,id));});return value;}
 async inspectMany(peer:CoordinatorPeer,ids:string[]):Promise<string>{const jobs:NativeJob[]=[];await this.database.transaction(async(tx:CoordinatorTransaction):Promise<void>=>{for(const id of ids){
  const job=await this.owned(tx,peer,id);job.restartable=false;
  // Restart proof comes from durable authenticated notices AND a settled receipt, never a UI state.
  if(['CANCELLED_SETTLED','YIELDED'].includes(job.state)){
   const rows=await tx.querySql('SELECT recordJson,yieldJson FROM Attempt WHERE id=?',[id]);try{if(rows.goToFirstRow()){
    const recordJson=rows.getString(0),yieldJson=rows.getString(1),record:AttemptRecordV2|null=recordJson?JSON.parse(recordJson) as AttemptRecordV2:null;
    const notice:YieldNoticeV2|null=yieldJson?JSON.parse(yieldJson) as YieldNoticeV2:null,contract=job.offer!.task.contract;
    if(record?.receipt)job.settlement=record.receipt;if(notice)job.yieldNotice=notice;
    job.restartable=contract.sideEffectPolicy==='PURE'&&contract.interruptibility==='CANCEL_RESTART'&&record?.resourcesSettled===true&&record.receipt?.resourcesSettled===true&&record.receipt.attemptId===id&&record.receipt.state===job.state&&notice?.kind==='RESTART'&&notice.attemptId===id;
   }}finally{rows.close();}
  }jobs.push(job);
 }});return JSON.stringify(jobs);}
 async attachInput(peer:CoordinatorPeer,id:string,source:CoordinatorArtifact):Promise<void>{await this.database.transaction(async(tx:CoordinatorTransaction):Promise<void>=>{const job=await this.owned(tx,peer,id);if(job.state!=='WAITING_INPUT'||source.groupId!==peer.groupId||source.ownerPrincipalId!==peer.principalId||source.ref.contentHash!==job.input.ref.contentHash||source.bytes!==job.input.bytes)throw Error('INPUT_SCOPE');job.input=source;await this.save(tx,id,job);});}
 async startJob(peer:CoordinatorPeer,id:string):Promise<Object>{await this.database.transaction(async(tx:CoordinatorTransaction):Promise<void>=>{
  const job=await this.owned(tx,peer,id);if(job.state!=='WAITING_INPUT')return;if(job.deadlineAt<=Date.now())throw Error('BUDGET_EXHAUSTED');if(!job.originLocal&&!await this.artifacts.available(tx,job.input))throw Error('INPUT_NOT_UPLOADED');
  await this.choose(tx,job,id);await this.enqueueJob(tx,job,id);
 });void this.channel.pump().catch(()=>{});return {jobId:id} as JobAck;}
 private async enqueueJob(tx:CoordinatorTransaction,job:NativeJob,id:string):Promise<void>{
  const offer=job.offer!,nodeId=JSON.stringify([id,offer.task.nodeId]),peer=job.owner;
  await tx.executeSql('INSERT INTO Workflow (id,groupId,planRevision,state) VALUES (?,?,1,?)',[id,peer.groupId,'ACTIVE']);
  await tx.executeSql('INSERT INTO Node (id,workflowId,currentAttemptId,state) VALUES (?,?,?,?)',[nodeId,id,id,'OFFERED']);
  await tx.executeSql('INSERT INTO Attempt (id,groupId,workflowId,nodeId,executionDigest,state,holderInstanceId,taskJson,offerJson) VALUES (?,?,?,?,?,?,?,?,?)',[id,peer.groupId,id,nodeId,digest(offer),'OFFERED',job.holder,JSON.stringify(offer.task),JSON.stringify(offer)]);
  await this.channel.enqueue(tx,peer.groupId,id,'DispatchOffer',offer,job.traceId);job.state='OFFERED';job.offeredAt=Date.now();await this.save(tx,id,job);
 }
 async status(peer:CoordinatorPeer,id:string):Promise<Object>{let result:Object=new Object();await this.database.transaction(async(tx:CoordinatorTransaction):Promise<void>=>{const job=await this.owned(tx,peer,id);result={jobId:id,state:job.state,targetId:job.offer?.target.targetId??'',deviceId:job.offer?.target.deviceId??'',traceId:job.traceId,outputTicket:job.state==='SUCCEEDED'&&job.output&&await this.artifacts.available(tx,job.output)?await this.artifacts.issue(tx,job.output,peer,'READ'):null} as SdkStatus;});return result;}
 async cancel(peer:CoordinatorPeer,id:string):Promise<Object>{let state='';await this.database.transaction(async(tx:CoordinatorTransaction):Promise<void>=>{const job=await this.owned(tx,peer,id);if(job.state==='WAITING_INPUT')job.state='CANCELLED';else if(['OFFERED','ACCEPTED','RUNNING'].includes(job.state))job.state='CANCEL_REQUESTED';state=job.state;await this.save(tx,id,job);});return {jobId:id,state} as JobAck;}
 async received(peer:CoordinatorPeer,id:string,body:Object):Promise<Object>{await this.database.transaction(async(tx:CoordinatorTransaction):Promise<void>=>{const job=await this.owned(tx,peer,id),received=body as ResultReceived;if(job.state!=='SUCCEEDED'||!job.output||!exact(body,['ref','bytes'],['sourceInterval'])||received.bytes!==job.output.bytes||canonical(received.ref)!==canonical(job.output.ref))throw Error('RESULT_ACK_INVALID');});return {acknowledged:true} as ResultAck;}
 async execution(peer:CoordinatorPeer,id:string,action:string,body:Object):Promise<Object>{let result:Object=new Object();await this.database.transaction(async(tx:CoordinatorTransaction):Promise<void>=>{
  const job=await this.executionJob(tx,peer,id),offer=job.offer!;
  if(action==='control'){result={cancel:job.state==='CANCEL_REQUESTED'||offer.task.coordinatorEpoch!==this.epoch,settled:!['OFFERED','ACCEPTED','RUNNING','CANCEL_REQUESTED'].includes(job.state)} as ExecutionControl;return;}
  if(!['OFFERED','ACCEPTED','RUNNING'].includes(job.state)||job.deadlineAt<=Date.now()||offer.task.coordinatorEpoch!==this.epoch)throw Error('EXECUTION_EXPIRED');
  if(action==='authorize'){const evidence=await this.qualification.evidence(tx,peer,offer.target.targetId);if(evidence.admission.state!=='ACTIVE'||canonical(evidence.executor.target)!==canonical(offer.target))throw Error('CAPABILITY_NOT_QUALIFIED');result={offer,snapshotVersion:(JSON.parse(job.decision) as NativeDecision).snapshotVersion,inputTicket:await this.artifacts.issue(tx,job.input,peer,'READ'),qualification:evidence} as Authorization;return;}
  if(action==='input'){result={ticket:await this.artifacts.issue(tx,job.input,peer,'READ')} as TicketResponse;return;}
  const out=body as OutputRequest;if(action!=='output'||!exact(body,['bytes','contentHash','schemaId'])||!Number.isSafeInteger(out.bytes)||out.bytes<1||out.bytes>8388608||!/^[a-f0-9]{64}$/.test(out.contentHash)||!offer.task.contract.outputSchemas.includes(out.schemaId))throw Error('OUTPUT_INVALID');
  const output:CoordinatorArtifact={groupId:peer.groupId,ownerPrincipalId:job.owner.principalId,ref:{artifactId:'out-'+id,contentVersion:1,contentHash:out.contentHash,schemaId:out.schemaId,schemaVersion:1},bytes:out.bytes,expiresAt:job.input.expiresAt};if(job.output&&canonical(job.output)!==canonical(output))throw Error('OUTPUT_CONFLICT');job.output=output;await this.save(tx,id,job);result={ticket:await this.artifacts.issue(tx,output,peer,'WRITE'),delivery:'RELAY'} as TicketResponse;
 });return result;}
 private validateRecord(job:NativeJob,record:AttemptRecordV2):void{const o=job.offer!,t=o.task;if(record.attemptId!==t.attemptId||record.groupId!==t.groupId||record.holderInstanceId!==job.holder||record.principalId!==t.app.principalId||record.appInstanceId!==t.app.appInstanceId||record.executionDigest!==digest(o)||record.coordinatorEpoch!==t.coordinatorEpoch||record.planRevision!==t.planRevision||record.allotmentId!==o.allotmentId||record.allotmentVersion!==o.allotmentVersion||record.fence.deviceId!==o.target.deviceId||record.fence.holderInstanceId!==job.holder||record.businessIdempotencyKey!==t.businessIdempotencyKey)throw Error('ADMISSION_CONFLICT');}
 private async admission(tx:CoordinatorTransaction,peer:CoordinatorPeer,reply:AdmissionReplyV2):Promise<void>{const job=await this.executionJob(tx,peer,reply.attemptId);if(reply.holderInstanceId!==peer.holderInstanceId)throw Error('ADMISSION_SCOPE');
  const rows=await tx.querySql('SELECT recordJson,rejectionJson FROM Attempt WHERE id=?',[reply.attemptId]);let previous='',rejection='';try{if(!rows.goToFirstRow())throw Error('ATTEMPT_UNKNOWN');previous=rows.getString(0);rejection=rows.getString(1);}finally{rows.close();}
  if(reply.status==='REJECTED'){if(previous||rejection&&canonical(JSON.parse(rejection) as Object)!==canonical(reply))throw Error('ADMISSION_CONFLICT');job.state='REJECTED';job.rejection=reply;await tx.executeSql("UPDATE Attempt SET state='REJECTED',rejectionJson=? WHERE id=?",[JSON.stringify(reply),reply.attemptId]);}
  else{const record=reply.record!;this.validateRecord(job,record);if(rejection||record.state!=='ACCEPTED'||record.resourcesSettled||record.receipt!==null)throw Error('ADMISSION_CONFLICT');if(previous){const old=JSON.parse(previous) as AttemptRecordV2;if(canonical(old.fence)!==canonical(record.fence)||old.leaseId!==record.leaseId)throw Error('ADMISSION_CONFLICT');return;}job.state=job.state==='CANCEL_REQUESTED'?job.state:'ACCEPTED';job.acceptedAt=Date.now();await tx.executeSql("UPDATE Attempt SET state='ACCEPTED',recordJson=? WHERE id=?",[JSON.stringify(record),reply.attemptId]);}
  await this.save(tx,reply.attemptId,job);this.wake();
 }
 private async settle(tx:CoordinatorTransaction,job:NativeJob,record:AttemptRecordV2,receipt:ExecutionReceiptV2):Promise<void>{
  this.validateRecord(job,record);const offer=job.offer!;
  if(!receipt.resourcesSettled||receipt.attemptId!==record.attemptId||receipt.coordinatorEpoch!==record.coordinatorEpoch||receipt.planRevision!==record.planRevision||canonical(receipt.fence)!==canonical(record.fence)||canonical(receipt.actualTarget)!==canonical(offer.target)||!offer.allowedConfigs.some(c=>c.id===receipt.actualConfiguration))throw Error('RECEIPT_CONFLICT');
  if(record.receipt&&canonical(record.receipt)!==canonical(receipt))throw Error('RECEIPT_CONFLICT');
  if(receipt.state==='SUCCEEDED'&&(!job.output||receipt.outputs.length!==1||canonical(receipt.outputs[0])!==canonical(job.output.ref)||!await this.artifacts.available(tx,job.output)))throw Error('OUTPUT_NOT_UPLOADED');
  record.receipt=receipt;record.resourcesSettled=true;record.state=receipt.state;job.state=receipt.state;job.settledAt=Date.now();this.historyDirty=true;
  await tx.executeSql('UPDATE Attempt SET state=?,recordJson=? WHERE id=?',[receipt.state,JSON.stringify(record),record.attemptId]);
  await tx.executeSql('INSERT OR IGNORE INTO Receipt (id,attemptId,recordJson,committed) VALUES (?,?,?,?)',[record.attemptId,record.attemptId,JSON.stringify(receipt),receipt.state==='SUCCEEDED'?1:0]);
  await tx.executeSql('UPDATE Node SET state=? WHERE currentAttemptId=?',[receipt.state==='SUCCEEDED'?'COMMITTED':receipt.state,record.attemptId]);await this.save(tx,record.attemptId,job);this.wake();
 }
 private async receipt(tx:CoordinatorTransaction,peer:CoordinatorPeer,report:ExecutionReportV2):Promise<void>{const job=await this.executionJob(tx,peer,report.receipt.attemptId),rows=await tx.querySql('SELECT recordJson FROM Attempt WHERE id=?',[report.receipt.attemptId]);let record:AttemptRecordV2;try{if(!rows.goToFirstRow()||!rows.getString(0))throw Error('ADMISSION_REQUIRED');record=JSON.parse(rows.getString(0)) as AttemptRecordV2;}finally{rows.close();}if(report.allotmentId!==record.allotmentId||report.allotmentVersion!==record.allotmentVersion||report.leaseId!==record.leaseId)throw Error('RECEIPT_SCOPE');await this.settle(tx,job,record,report.receipt);}
 private async trace(tx:CoordinatorTransaction,peer:CoordinatorPeer,batch:TraceBatch):Promise<void>{this.historyDirty=true;for(const span of batch.spans){const job=await this.executionJob(tx,peer,span.attemptId);if(span.targetId!==job.offer!.target.targetId||span.workflowId!==job.offer!.task.workflowId||span.nodeId!==job.offer!.task.nodeId)throw Error('TRACE_SCOPE');const key=JSON.stringify([peer.groupId,peer.holderInstanceId,span.spanId]),old=await tx.querySql('SELECT metadataJson FROM TraceSpan WHERE id=?',[key]);try{if(old.goToFirstRow()&&canonical(JSON.parse(old.getString(0)) as Object)!==canonical(span))throw Error('TRACE_CONFLICT');}finally{old.close();}await tx.executeSql('INSERT OR IGNORE INTO TraceSpan (id,groupId,revision,metadataJson) VALUES (?,?,1,?)',[key,peer.groupId,JSON.stringify(span)]);}}
 private async recover(tx:CoordinatorTransaction,peer:CoordinatorPeer):Promise<void>{const rows=await tx.querySql("SELECT id,recordJson FROM Attempt WHERE groupId=? AND holderInstanceId=? AND state!='REJECTED'",[peer.groupId,peer.holderInstanceId]),ids:string[]=[];try{while(rows.goToNextRow()){const raw=rows.getString(1);if(!raw||!(JSON.parse(raw) as AttemptRecordV2).resourcesSettled)ids.push(rows.getString(0));}}finally{rows.close();}for(const id of ids){await tx.executeSql('UPDATE Outbox SET superseded=1 WHERE attemptId=? AND acked=0',[id]);await this.channel.enqueue(tx,peer.groupId,id,'AttemptStatusQuery',{groupId:peer.groupId,attemptId:id,holderInstanceId:peer.holderInstanceId,coordinatorEpoch:this.epoch} as AttemptStatusQueryV2,id);}}
 private async recovered(tx:CoordinatorTransaction,peer:CoordinatorPeer,reply:AttemptStatusReplyV2):Promise<void>{const job=await this.executionJob(tx,peer,reply.attemptId);if(reply.record===null){
  const rows=await tx.querySql('SELECT recordJson FROM Attempt WHERE id=?',[reply.attemptId]);let admitted=false;try{admitted=rows.goToFirstRow()&&!!rows.getString(0);}finally{rows.close();}
  // No durable admission existed: redeliver the SAME immutable attempt after reconnect.
  // The holder's ledger deduplicates it; never invent a replacement for a missing admitted record.
  if(job.state==='OFFERED'&&!admitted&&job.deadlineAt>Date.now()&&job.offer!.task.coordinatorEpoch===this.epoch){
   await tx.executeSql('UPDATE Outbox SET superseded=1 WHERE attemptId=? AND acked=0',[reply.attemptId]);
   await this.channel.enqueue(tx,peer.groupId,reply.attemptId,'DispatchOffer',job.offer!,job.traceId);return;
  }
  // Keep the admission fence in sync with CpuJob. A stale OFFERED row would
  // reject every future allotment renewal even after recovery has completed.
  await tx.executeSql("UPDATE Attempt SET state='HOLDER_RECORD_MISSING' WHERE id=?",[reply.attemptId]);
  job.state='HOLDER_RECORD_MISSING';await this.save(tx,reply.attemptId,job);this.wake();return;
 }this.validateRecord(job,reply.record);if(reply.record.resourcesSettled&&reply.record.receipt){await this.settle(tx,job,reply.record,reply.record.receipt);}else{await tx.executeSql('UPDATE Attempt SET state=?,recordJson=? WHERE id=?',[reply.record.state,JSON.stringify(reply.record),reply.attemptId]);job.state=reply.record.state;await this.save(tx,reply.attemptId,job);}}
}

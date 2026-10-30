import { canonical } from './cost';
import { AttemptRecordV2, ExecutionReceiptV2, equalFenceV2, validExecutionReceiptV2 } from './protocol-v2';
import { AllotmentGrantV2, DispatchOfferV2, ResourceAmountV2, validAllotmentGrantV2, validDispatchOfferV2, validResourceVectorV2 } from './resources-v2';

export interface LedgerEntryV2 {
  offer:DispatchOfferV2; record:AttemptRecordV2; resources:ResourceAmountV2[];
  deadline:number; cancelRequested:boolean;
}
export interface LedgerStateV2 {
  version:1; groupId:string; deviceId:string; holderInstanceId:string; appInstanceId:string|null;
  ledgerEpoch:number; counter:number; settlementSeq:number; grant:AllotmentGrantV2|null;
  onlineUntil:number; request:{id:string;started:number}|null; entries:LedgerEntryV2[];
}
export interface LedgerAdmissionV2 {
  now:number; coordinatorEpoch:number; online:boolean; ownerIdle:boolean;
  admissionLimit:ResourceAmountV2[]; executionDigest:string; leaseId:string;
}
const copy=<T>(v:T):T=>JSON.parse(JSON.stringify(v)) as T;
const safe=(n:number)=>Number.isSafeInteger(n)&&n>=0;
export function vectorSumV2(...vectors:ResourceAmountV2[][]):ResourceAmountV2[]{
  const values=new Map<string,number>();
  for(const vector of vectors){
    if(!validResourceVectorV2(vector))throw Error('RESOURCE_VECTOR_INVALID');
    for(const r of vector){const amount=(values.get(r.resourcePoolId)??0)+r.amount;if(!safe(amount))throw Error('RESOURCE_OVERFLOW');values.set(r.resourcePoolId,amount);}
  }
  return [...values].map(([resourcePoolId,amount])=>({resourcePoolId,amount}));
}
export function vectorFitsV2(demand:ResourceAmountV2[],limit:ResourceAmountV2[]):boolean {
  return demand.every(r=>r.amount<=(limit.find(l=>l.resourcePoolId===r.resourcePoolId)?.amount??0));
}
export function occupiedV2(state:LedgerStateV2):ResourceAmountV2[]{return vectorSumV2(...state.entries.filter(e=>!e.record.resourcesSettled).map(e=>e.resources));}
export function newLedgerV2(identity:Pick<LedgerStateV2,'groupId'|'deviceId'|'holderInstanceId'|'appInstanceId'>):LedgerStateV2{
  if(![identity.groupId,identity.deviceId,identity.holderInstanceId,...identity.appInstanceId===null?[]:[identity.appInstanceId]].every(v=>/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v)))throw Error('IDENTITY_INVALID');
  return {...identity,version:1,ledgerEpoch:1,counter:0,settlementSeq:0,grant:null,onlineUntil:0,request:null,entries:[]};
}
/** Recovery never infers engine death. Old fences remain attached to their original attempts. */
export function recoverLedgerV2(state:LedgerStateV2):LedgerStateV2{
  const next=copy(state);next.ledgerEpoch++;if(!safe(next.ledgerEpoch))throw Error('EPOCH_EXHAUSTED');next.counter=0;next.onlineUntil=0;next.request=null;
  for(const e of next.entries)if(!e.record.resourcesSettled){
    if(e.record.state==='ACCEPTED'){
      // RUNNING is durably committed before any engine call. ACCEPTED is therefore a local never-started proof.
      e.record.state='CANCELLED_SETTLED';e.record.resourcesSettled=true;next.settlementSeq++;
      e.record.receipt={attemptId:e.record.attemptId,coordinatorEpoch:e.record.coordinatorEpoch,planRevision:e.record.planRevision,
        fence:copy(e.record.fence),state:'CANCELLED_SETTLED',resourcesSettled:true,outputs:[],actualTarget:copy(e.offer.target),
        actualConfiguration:e.offer.allowedConfigs[0].id,errorCode:'RECOVERED_BEFORE_START'};
    }else{e.record.state='SIDE_EFFECT_UNKNOWN';e.record.receipt=null;}
    e.cancelRequested=true;
  }
  return next;
}
export function requestGrantV2(state:LedgerStateV2,id:string,now:number):LedgerStateV2{
  if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(id)||!Number.isFinite(now)||now<0)throw Error('REQUEST_INVALID');
  const next=copy(state);next.request={id,started:now};return next;
}
/** Signature verification belongs to the platform adapter; the boolean must never come from a peer. */
export function installGrantV2(state:LedgerStateV2,grant:AllotmentGrantV2,verified:boolean,now:number):LedgerStateV2{
  if(!Number.isFinite(now)||now<0)throw Error('CLOCK_INVALID');
  if(!verified||!validAllotmentGrantV2(grant)||grant.groupId!==state.groupId||grant.deviceId!==state.deviceId||grant.holderInstanceId!==state.holderInstanceId||grant.appInstanceId!==state.appInstanceId||grant.ledgerEpoch!==state.ledgerEpoch)throw Error('GRANT_UNAUTHORIZED');
  if(!state.request||state.request.id!==grant.leaseRequestId||now<state.request.started||now>=state.request.started+grant.leaseMs)throw Error('GRANT_EXPIRED_OR_REPLAYED');
  if(state.grant&&(grant.allotmentId!==state.grant.allotmentId||grant.version<=state.grant.version||grant.coordinatorEpoch<state.grant.coordinatorEpoch))throw Error('GRANT_VERSION');
  if(grant.appInstanceId===null&&grant.base.some(r=>r.amount>0))throw Error('AGENT_BASE_FORBIDDEN');
  vectorSumV2(grant.base,grant.extra);
  const next=copy(state);next.grant=copy(grant);next.onlineUntil=state.request.started+grant.leaseMs;next.request=null;return next;
}
export function admitV2(state:LedgerStateV2,offer:DispatchOfferV2,context:LedgerAdmissionV2):{state:LedgerStateV2;entry:LedgerEntryV2;existing:boolean}{
  if(!validDispatchOfferV2(offer)||!validResourceVectorV2(context.admissionLimit)||!Number.isFinite(context.now)||context.now<0||!safe(context.coordinatorEpoch)||!context.coordinatorEpoch||!/^[a-f0-9]{64}$/.test(context.executionDigest)||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(context.leaseId))throw Error('ADMISSION_INVALID');
  const task=offer.task;
  if(task.groupId!==state.groupId||offer.target.deviceId!==state.deviceId||state.appInstanceId!==null&&task.app.appInstanceId!==state.appInstanceId||task.privacy==='LOCAL_ONLY'&&task.originDeviceId!==state.deviceId)throw Error('TASK_UNAUTHORIZED');
  const old=state.entries.find(e=>e.record.attemptId===task.attemptId);
  if(old){if(old.record.executionDigest!==context.executionDigest||canonical(old.offer)!==canonical(offer))throw Error('ATTEMPT_CONFLICT');return {state,entry:copy(old),existing:true};}
  const grant=state.grant;
  if(!grant||grant.allotmentId!==offer.allotmentId||grant.version!==offer.allotmentVersion||task.coordinatorEpoch!==context.coordinatorEpoch||context.online&&grant.coordinatorEpoch!==context.coordinatorEpoch)throw Error('ALLOTMENT_MISMATCH');
  if(!context.ownerIdle)throw Error('OWNER_ACTIVE');
  if(offer.dependencies.some(d=>!d.committed||d.planRevision!==task.planRevision))throw Error('DEPENDENCY_UNCOMMITTED');
  const online=context.online&&context.now<state.onlineUntil&&grant.ledgerEpoch===state.ledgerEpoch;
  if(!online&&(state.appInstanceId===null||task.priority!=='ORIGIN_INTERACTIVE'))throw Error('OFFLINE_REMOTE_FORBIDDEN');
  const quota=online?vectorSumV2(grant.base,grant.extra):grant.base;
  const occupied=vectorSumV2(occupiedV2(state),offer.resources);
  // A draining pool blocks consumers of that pool, not independent resource queues.
  const required=occupied.filter(r=>offer.resources.some(d=>d.resourcePoolId===r.resourcePoolId&&d.amount>0));
  if(!vectorFitsV2(required,quota)||!vectorFitsV2(required,context.admissionLimit))throw Error('RESOURCE_UNAVAILABLE');
  const next=copy(state);next.counter++;if(!safe(next.counter))throw Error('FENCE_EXHAUSTED');
  const record:AttemptRecordV2={groupId:task.groupId,principalId:task.app.principalId,appInstanceId:task.app.appInstanceId,attemptId:task.attemptId,
    holderInstanceId:state.holderInstanceId,ledgerEpoch:state.ledgerEpoch,planRevision:task.planRevision,coordinatorEpoch:task.coordinatorEpoch,
    executionDigest:context.executionDigest,allotmentId:grant.allotmentId,allotmentVersion:grant.version,leaseId:context.leaseId,
    fence:{deviceId:state.deviceId,holderInstanceId:state.holderInstanceId,ledgerEpoch:state.ledgerEpoch,counter:next.counter},businessIdempotencyKey:task.businessIdempotencyKey,state:'ACCEPTED',resourcesSettled:false,receipt:null};
  const entry:LedgerEntryV2={offer:copy(offer),record,resources:copy(offer.resources),deadline:context.now+Math.min(offer.leaseMs,task.budget.remainingMs),cancelRequested:false};
  next.entries.push(entry);next.settlementSeq++;return {state:next,entry:copy(entry),existing:false};
}
export function startAttemptV2(state:LedgerStateV2,attemptId:string,now:number):LedgerStateV2{
  if(!Number.isFinite(now)||now<0)throw Error('CLOCK_INVALID');
  const next=copy(state),entry=next.entries.find(e=>e.record.attemptId===attemptId);
  if(!entry||entry.record.state!=='ACCEPTED'||entry.cancelRequested||now>=entry.deadline)throw Error('ATTEMPT_NOT_STARTABLE');
  entry.record.state='RUNNING';return next;
}
/** Cancel, revocation and timeouts request engine termination but never release a resource. */
export function cancelAttemptV2(state:LedgerStateV2,attemptId:string):LedgerStateV2{
  const next=copy(state),entry=next.entries.find(e=>e.record.attemptId===attemptId);if(!entry)throw Error('ATTEMPT_UNKNOWN');entry.cancelRequested=true;return next;
}
export function settleAttemptV2(state:LedgerStateV2,receipt:ExecutionReceiptV2):LedgerStateV2{
  if(!validExecutionReceiptV2(receipt)||!receipt.resourcesSettled||receipt.state==='SIDE_EFFECT_UNKNOWN')throw Error('SETTLEMENT_INVALID');
  const next=copy(state),entry=next.entries.find(e=>e.record.attemptId===receipt.attemptId);
  if(!entry||!equalFenceV2(entry.record.fence,receipt.fence)||entry.record.coordinatorEpoch!==receipt.coordinatorEpoch||entry.record.planRevision!==receipt.planRevision||canonical(entry.offer.target)!==canonical(receipt.actualTarget)||!entry.offer.allowedConfigs.some(c=>c.id===receipt.actualConfiguration))throw Error('SETTLEMENT_MISMATCH');
  if(entry.record.resourcesSettled){if(canonical(entry.record.receipt)!==canonical(receipt))throw Error('SETTLEMENT_CONFLICT');return next;}
  entry.record.state=receipt.state;entry.record.resourcesSettled=true;entry.record.receipt=copy(receipt);next.settlementSeq++;return next;
}
export function ledgerPoolsV2(state:LedgerStateV2,limits:ResourceAmountV2[]){
  const occupied=occupiedV2(state);
  return vectorSumV2(limits,occupied).map(r=>{const used=occupied.find(x=>x.resourcePoolId===r.resourcePoolId)?.amount??0,limit=limits.find(x=>x.resourcePoolId===r.resourcePoolId)?.amount??0;return {resourcePoolId:r.resourcePoolId,admissionLimit:limit,occupied:used,draining:used>limit};});
}

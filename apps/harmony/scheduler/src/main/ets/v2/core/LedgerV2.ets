import { canonical } from './CanonicalV2';
import { WorkModelV2, AttemptRecordV2, ExecutionReceiptV2, equalFenceV2, validExecutionReceiptV2 } from '../protocol/SchedulingProtocolV2';
import { InFlightV2, NumericSampleV2, AllotmentGrantV2, DispatchOfferV2, ResourceAmountV2, validAllotmentGrantV2, validDispatchOfferV2, validResourceVectorV2 } from '../protocol/ResourcesV2';

export interface LedgerIdentityV2 { groupId:string;deviceId:string;holderInstanceId:string;appInstanceId:string|null; }
export interface GrantRequestV2 { id:string;started:number; }
export interface LedgerAdmissionResultV2 { state:LedgerStateV2;entry:LedgerEntryV2;existing:boolean; }
export interface LedgerPoolStateV2 { resourcePoolId:string;admissionLimit:number;occupied:number;draining:boolean; }
// Invalid business parameters retain exact identity so a timing sample cannot leak into a valid bucket.
function timingConfiguration(parameters:string,model?:WorkModelV2):string {
  if(!model)return 'size-only-v1';
  try{
    const input=JSON.parse(parameters) as Record<string,Object|null>;
    const values:Record<string,Object|null>={};
    for(const rule of model.parameters){
      const value=input[rule.name];
      if(rule.bucketWidth!==undefined)values[rule.name]=typeof value==='number'&&Number.isFinite(value)?Math.floor(value/rule.bucketWidth):null;
      else if(value===undefined||value===null)values[rule.name]=null;
      else if(typeof value==='boolean'||typeof value==='number'||(typeof value==='string'&&value.length<=128))values[rule.name]=value;
      else return 'invalid:'+parameters;
    }
    return canonical(values);
  }catch{return 'invalid:'+parameters;}
}
interface RunStart {at:number;inputBucket:string;startup:string;}
interface SettledTiming {duration:number;at:number;}
/** Process-local evidence. Recovered entries retain occupancy, never an old monotonic origin. */
export class RunTimings {
  private starts=new Map<string,RunStart>();
  private settled=new Map<string,SettledTiming[]>();
  start(id:string,now:number,inputBytes?:number,startup:'COLD'|'WARM'|'UNKNOWN'='UNKNOWN'):void{
    const inputBucket=inputBytes!==undefined&&Number.isSafeInteger(inputBytes)&&inputBytes>0?String(Math.floor(Math.log2(inputBytes))):'';
    this.starts.set(id,{at:now,inputBucket,startup});
  }
  private key(e:LedgerEntryV2,start:RunStart):string{
    const o=e.offer;
    return [o.task.app.appInstanceId,canonical(o.target),canonical(o.task.contract),start.startup,start.inputBucket,canonical(o.task.inputs.map(r=>[r.schemaId,r.schemaVersion.toString(),start.inputBucket&&start.startup!=='UNKNOWN'?'':r.contentHash])),
      timingConfiguration(o.task.parameters,o.task.contract.workModel),canonical(o.resources),canonical(o.allowedConfigs),canonical(o.transferPlan.map(h=>[h.from,h.to,h.via])),o.task.resultDestination].map(v=>canonical(v)).join('|');
  }
  finish(e:LedgerEntryV2,now:number):void{
    const start=this.starts.get(e.record.attemptId);this.starts.delete(e.record.attemptId);
    if(start===undefined||now<=start.at||e.record.state!=='SUCCEEDED'||!e.record.resourcesSettled||e.offer.allowedConfigs.length!==1)return;
    const key=this.key(e,start),history=(this.settled.get(key)??[]).filter(t=>now-t.at<60000).slice(-31);this.settled.delete(key);
    if(this.settled.size>=128)this.settled.delete(Array.from(this.settled.keys())[0]);
    history.push({duration:now-start.at,at:now});this.settled.set(key,history);
  }
  sample(entries:LedgerEntryV2[],now:number,sampledAt:number,domain:string):InFlightV2[]|undefined{
    const live=entries.filter(e=>!e.record.resourcesSettled);
    if(live.length>32||live.some(e=>!['ACCEPTED','RUNNING'].includes(e.record.state)))return undefined;
    const source=domain==='REAL'?'MEASURED':'SIMULATED';
    return live.map((e:LedgerEntryV2):InFlightV2=>{
      const start=this.starts.get(e.record.attemptId),elapsed=start===undefined?null:Math.max(0,now-start.at);
      const history=start===undefined||e.cancelRequested?[]:(this.settled.get(this.key(e,start))??[]).filter(t=>now>=t.at&&now-t.at<60000);
      const durations=history.map(t=>t.duration).sort((a,b)=>a-b);
      const residuals=elapsed===null?[]:durations.filter(d=>d>elapsed).map(d=>d-elapsed);
      const remaining=residuals.length?residuals[Math.ceil(residuals.length/2)-1]:null;
      const ttl=history.length?Math.min(15000,history[0].at+60000-now):15000;
      const elapsedSample:NumericSampleV2={value:elapsed,source:elapsed===null?'UNKNOWN':source,sampledAt,ttlMs:15000,unit:'ms'};
      const forecast:NumericSampleV2={value:remaining,source:remaining===null?'UNKNOWN':'PRIOR',sampledAt,ttlMs:remaining===null?15000:ttl,unit:'ms'};
      const fact:InFlightV2={attemptId:e.record.attemptId,targetId:e.offer.target.targetId,state:e.record.state,resources:e.resources,elapsed:elapsedSample,remaining:forecast};
      if(durations.length)fact.history={samples:durations.length,survivors:residuals.length,p90TotalMs:durations[Math.ceil(durations.length*.9)-1],
        p90RemainingMs:residuals.length?residuals[Math.ceil(residuals.length*.9)-1]:null};
      return fact;
    });
  }
}
export interface LedgerEntryV2 {
  offer:DispatchOfferV2; record:AttemptRecordV2; resources:ResourceAmountV2[];
  deadline:number; cancelRequested:boolean;
}
export interface LedgerStateV2 {
  version:number; groupId:string; deviceId:string; holderInstanceId:string; appInstanceId:string|null;
  ledgerEpoch:number; counter:number; settlementSeq:number; grant:AllotmentGrantV2|null;
  onlineUntil:number; request:GrantRequestV2|null; entries:LedgerEntryV2[];
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
  const result:ResourceAmountV2[]=[];
  values.forEach((amount:number,resourcePoolId:string)=>{result.push({resourcePoolId,amount});});return result;
}
export function vectorFitsV2(demand:ResourceAmountV2[],limit:ResourceAmountV2[]):boolean {
  return demand.every(r=>r.amount<=(limit.find(l=>l.resourcePoolId===r.resourcePoolId)?.amount??0));
}
export function occupiedV2(state:LedgerStateV2):ResourceAmountV2[]{return vectorSumV2(...state.entries.filter(e=>!e.record.resourcesSettled).map(e=>e.resources));}
export function newLedgerV2(identity:LedgerIdentityV2):LedgerStateV2{
  if(![identity.groupId,identity.deviceId,identity.holderInstanceId,...identity.appInstanceId===null?[]:[identity.appInstanceId]].every(v=>/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v)))throw Error('IDENTITY_INVALID');
  return {groupId:identity.groupId,deviceId:identity.deviceId,holderInstanceId:identity.holderInstanceId,appInstanceId:identity.appInstanceId,version:1,ledgerEpoch:1,counter:0,settlementSeq:0,grant:null,onlineUntil:0,request:null,entries:[]};
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
export function admitV2(state:LedgerStateV2,offer:DispatchOfferV2,context:LedgerAdmissionV2):LedgerAdmissionResultV2{
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
  // Revision 6.1: retained base capacity is not permission for new offline v2 work.
  if(!online)throw Error('COORDINATOR_OFFLINE');
  const quota=vectorSumV2(grant.base,grant.extra);
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
export function ledgerPoolsV2(state:LedgerStateV2,limits:ResourceAmountV2[]):LedgerPoolStateV2[]{
  const occupied=occupiedV2(state);
  return vectorSumV2(limits,occupied).map((r:ResourceAmountV2):LedgerPoolStateV2=>{const used=occupied.find(x=>x.resourcePoolId===r.resourcePoolId)?.amount??0,limit=limits.find(x=>x.resourcePoolId===r.resourcePoolId)?.amount??0;return {resourcePoolId:r.resourcePoolId,admissionLimit:limit,occupied:used,draining:used>limit};});
}

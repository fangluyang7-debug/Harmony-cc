import { TargetV2, TaskContractV2, TaskInstanceV2, AttemptRecordV2, ExecutionReceiptV2, ArtifactRefV2,
  validTargetV2, validTaskContractV2, validTaskInstanceV2, validAttemptRecordV2, validExecutionReceiptV2, validArtifactRefV2 } from './protocol-v2';

export interface NumericSampleV2 { value:number|null; source:string; sampledAt:number; ttlMs:number; unit:string; }
export interface StateSampleV2 { value:string|null; source:string; sampledAt:number; ttlMs:number; unit:string; }
export interface ResourceAmountV2 { resourcePoolId:string; amount:number; }
export interface PoolV2 {
  resourcePoolId:string; kind:string; exclusive:boolean; total:NumericSampleV2; ownerReserved:number; contributionLimit:number;
  admissionLimit:NumericSampleV2; occupied:NumericSampleV2; draining:boolean; drainMs:NumericSampleV2;
}
export interface ModelManifestV2 { modelId:string; version:string; weightsHash:string; preprocessVersion:string; embeddingKind:string; dimension:number; dtype:string; normalization:string; }
export interface ExecutionConfigV2 { id:string; threads:number; batchSize:number; quality:string; }
export interface ExecutorV2 {
  target:TargetV2; contract:TaskContractV2; model:ModelManifestV2|null; resources:ResourceAmountV2[]; configurations:ExecutionConfigV2[];
  compute:NumericSampleV2; queue:NumericSampleV2; cold:NumericSampleV2; publish:NumericSampleV2; uncertainty:NumericSampleV2;
}
export interface LinkV2 {from:string;to:string;networkEpoch:string;via:string|null;fixedMs:NumericSampleV2;bytesPerSecond:NumericSampleV2;metered:boolean;}
export interface CreditV2 {priority:string;slots:number;}
export interface DeviceProfileV2 {
  deviceId:string;deviceInstanceId:string;holderInstanceId:string;ledgerEpoch:number;sequence:number;domain:string;
  ownerActivity:StateSampleV2;foreground:StateSampleV2;charging:StateSampleV2;powerSave:StateSampleV2;
  battery:NumericSampleV2;temperature:NumericSampleV2;pools:PoolV2[];executors:ExecutorV2[];links:LinkV2[];credits:CreditV2[];
}
export interface AllotmentGrantV2 {
  allotmentId:string;groupId:string;deviceId:string;appInstanceId:string|null;holderInstanceId:string;ledgerEpoch:number;coordinatorEpoch:number;
  version:number;base:ResourceAmountV2[];extra:ResourceAmountV2[];leaseRequestId:string;leaseMs:number;signature:string;
}
export interface AllotmentAckV2 {
  allotmentId:string;holderInstanceId:string;ledgerEpoch:number;coordinatorEpoch:number;version:number;
  persisted:boolean;settlementSeq:number;occupied:ResourceAmountV2[];
}
export interface TransferHopV2 {ref:ArtifactRefV2;from:string;to:string;via:string|null;}
export interface DependencyV2 {nodeId:string;planRevision:number;committed:boolean;}
export interface DispatchOfferV2 {
  task:TaskInstanceV2;target:TargetV2;resources:ResourceAmountV2[];allowedConfigs:ExecutionConfigV2[];
  allotmentId:string;allotmentVersion:number;leaseMs:number;transferPlan:TransferHopV2[];dependencies:DependencyV2[];reasonCode:string;
}
export interface AdmissionReplyV2 {attemptId:string;holderInstanceId:string;status:string;reasonCode:string|null;record:AttemptRecordV2|null;wait:NumericSampleV2;}
export interface ExecutionReportV2 {receipt:ExecutionReceiptV2;allotmentId:string;allotmentVersion:number;leaseId:string;actualModel:ModelManifestV2|null;timings:NumericSampleV2[];}
export interface YieldNoticeV2 {attemptId:string;kind:string;releaseMs:NumericSampleV2;checkpoint:ArtifactRefV2|null;reasonCode:string;}
export interface AttemptStatusReplyV2 {attemptId:string;record:AttemptRecordV2|null;}
export interface CapabilityPackV2 {packId:string;contract:TaskContractV2;executorIds:string[];model:ModelManifestV2|null;suiteId:string;qualityThreshold:number;resourceLimit:ResourceAmountV2[];}
/** Coordinator-owned evidence; a device advertisement cannot promote itself. */
export interface CapabilityAdmissionV2 {
  groupId:string;holderInstanceId:string;targetId:string;identity:string;domain:string;revision:number;
  state:string;reasonCode:string;quality:NumericSampleV2;
}

function exact(v:Object,keys:string[]):boolean{return v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&Object.keys(v).every((k:string)=>keys.includes(k));}
function id(v:string):boolean{return typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);}
function integer(v:number,min=0):boolean{return Number.isSafeInteger(v)&&v>=min;}
function nonnegative(v:number):boolean{return typeof v==='number'&&Number.isFinite(v)&&v>=0;}
function unique(values:string[]):boolean{return values.every((v:string)=>id(v))&&new Set(values).size===values.length;}
export function validNumericSampleV2(v:NumericSampleV2):boolean{
  return exact(v,['value','source','sampledAt','ttlMs','unit'])&&(v.value===null||nonnegative(v.value))&&
    ['MEASURED','PRIOR','UNKNOWN','SIMULATED'].includes(v.source)&&nonnegative(v.sampledAt)&&nonnegative(v.ttlMs)&&v.ttlMs>0&&id(v.unit)&&
    (v.source==='UNKNOWN'?v.value===null:v.value!==null);
}
export function validStateSampleV2(v:StateSampleV2):boolean{
  return exact(v,['value','source','sampledAt','ttlMs','unit'])&&(v.value===null||id(v.value))&&
    ['MEASURED','PRIOR','UNKNOWN','SIMULATED'].includes(v.source)&&nonnegative(v.sampledAt)&&nonnegative(v.ttlMs)&&v.ttlMs>0&&v.unit==='state'&&
    (v.source==='UNKNOWN'?v.value===null:v.value!==null);
}
export function sampleUsableV2(v:NumericSampleV2|StateSampleV2,now:number,domain:string):boolean{
  return nonnegative(now)&&v.value!==null&&v.sampledAt<=now&&now-v.sampledAt<=v.ttlMs&&
    (domain==='SIMULATED'?v.source==='SIMULATED'||v.source==='PRIOR':domain==='REAL'&&['MEASURED','PRIOR'].includes(v.source));
}
export function validResourceAmountV2(v:ResourceAmountV2):boolean{return exact(v,['resourcePoolId','amount'])&&id(v.resourcePoolId)&&integer(v.amount);}
export function validResourceVectorV2(v:ResourceAmountV2[]):boolean{return Array.isArray(v)&&v.length<=32&&v.every((a:ResourceAmountV2)=>validResourceAmountV2(a))&&unique(v.map((a:ResourceAmountV2)=>a.resourcePoolId));}
export function validPoolV2(v:PoolV2):boolean{
  if(!exact(v,['resourcePoolId','kind','exclusive','total','ownerReserved','contributionLimit','admissionLimit','occupied','draining','drainMs'])||!id(v.resourcePoolId)||!['CPU_SLOTS','RAM_BYTES','GPU_SLOTS','VRAM_BYTES','TRANSFER_SLOTS'].includes(v.kind)||typeof v.exclusive!=='boolean'||!integer(v.ownerReserved)||!integer(v.contributionLimit)||typeof v.draining!=='boolean')return false;
  const unit=v.kind.endsWith('_BYTES')?'bytes':'slots';
  if(![v.total,v.admissionLimit,v.occupied].every((s:NumericSampleV2)=>validNumericSampleV2(s)&&s.unit===unit&&(s.value===null||integer(s.value)))||!validNumericSampleV2(v.drainMs)||v.drainMs.unit!=='ms')return false;
  return (v.total.value===null||v.ownerReserved+v.contributionLimit<=v.total.value)&&(!v.exclusive||v.total.value===null||v.total.value<=1)&&
    (v.admissionLimit.value===null||v.occupied.value===null||v.draining===(v.occupied.value>v.admissionLimit.value));
}
export function validModelManifestV2(v:ModelManifestV2):boolean{return exact(v,['modelId','version','weightsHash','preprocessVersion','embeddingKind','dimension','dtype','normalization'])&&[v.modelId,v.version,v.preprocessVersion,v.embeddingKind,v.dtype,v.normalization].every((s:string)=>id(s))&&typeof v.weightsHash==='string'&&/^[a-f0-9]{64}$/.test(v.weightsHash)&&integer(v.dimension,1);}
export function sameModelV2(a:ModelManifestV2|null,b:ModelManifestV2|null):boolean{return a===null||b===null?a===b:validModelManifestV2(a)&&validModelManifestV2(b)&&a.modelId===b.modelId&&a.version===b.version&&a.weightsHash===b.weightsHash&&a.preprocessVersion===b.preprocessVersion&&a.embeddingKind===b.embeddingKind&&a.dimension===b.dimension&&a.dtype===b.dtype&&a.normalization===b.normalization;}
export function validExecutionConfigV2(v:ExecutionConfigV2):boolean{return exact(v,['id','threads','batchSize','quality'])&&id(v.id)&&integer(v.threads,1)&&v.threads<=256&&integer(v.batchSize,1)&&v.batchSize<=1024&&id(v.quality);}
export function validExecutorV2(v:ExecutorV2):boolean{
  return exact(v,['target','contract','model','resources','configurations','compute','queue','cold','publish','uncertainty'])&&validTargetV2(v.target)&&validTaskContractV2(v.contract)&&
    (v.model===null||validModelManifestV2(v.model))&&validResourceVectorV2(v.resources)&&v.resources.length>0&&v.resources.every((r:ResourceAmountV2)=>v.target.resourcePoolIds.includes(r.resourcePoolId))&&
    Array.isArray(v.configurations)&&v.configurations.length>0&&v.configurations.length<=64&&v.configurations.every((c:ExecutionConfigV2)=>validExecutionConfigV2(c))&&unique(v.configurations.map((c:ExecutionConfigV2)=>c.id))&&
    [v.compute,v.queue,v.cold,v.publish,v.uncertainty].every((s:NumericSampleV2)=>validNumericSampleV2(s)&&s.unit==='ms');
}
export function validLinkV2(v:LinkV2):boolean{return exact(v,['from','to','networkEpoch','via','fixedMs','bytesPerSecond','metered'])&&[v.from,v.to,v.networkEpoch].every((s:string)=>id(s))&&v.from!==v.to&&(v.via===null||id(v.via))&&typeof v.metered==='boolean'&&validNumericSampleV2(v.fixedMs)&&v.fixedMs.unit==='ms'&&validNumericSampleV2(v.bytesPerSecond)&&v.bytesPerSecond.unit==='bytes_per_second'&&(v.bytesPerSecond.value===null||v.bytesPerSecond.value>0);}
export function validCreditV2(v:CreditV2):boolean{return exact(v,['priority','slots'])&&['ORIGIN_INTERACTIVE','REMOTE_INTERACTIVE','REMOTE_BATCH'].includes(v.priority)&&integer(v.slots)&&v.slots<=1024;}
export function validDeviceProfileV2(v:DeviceProfileV2):boolean{
  return exact(v,['deviceId','deviceInstanceId','holderInstanceId','ledgerEpoch','sequence','domain','ownerActivity','foreground','charging','powerSave','battery','temperature','pools','executors','links','credits'])&&
    [v.deviceId,v.deviceInstanceId,v.holderInstanceId].every((s:string)=>id(s))&&integer(v.ledgerEpoch,1)&&integer(v.sequence,1)&&['REAL','SIMULATED'].includes(v.domain)&&
    [v.ownerActivity,v.foreground,v.charging,v.powerSave].every((s:StateSampleV2)=>validStateSampleV2(s))&&
    (v.ownerActivity.value===null||['IDLE','ACTIVE','UNKNOWN'].includes(v.ownerActivity.value))&&(v.foreground.value===null||['FOREGROUND','BACKGROUND'].includes(v.foreground.value))&&
    (v.charging.value===null||['CHARGING','NOT_CHARGING'].includes(v.charging.value))&&(v.powerSave.value===null||['ON','OFF'].includes(v.powerSave.value))&&
    validNumericSampleV2(v.battery)&&v.battery.unit==='percent'&&(v.battery.value===null||v.battery.value<=100)&&validNumericSampleV2(v.temperature)&&v.temperature.unit==='level'&&
    Array.isArray(v.pools)&&v.pools.length>0&&v.pools.length<=32&&v.pools.every((p:PoolV2)=>validPoolV2(p))&&unique(v.pools.map((p:PoolV2)=>p.resourcePoolId))&&
    Array.isArray(v.executors)&&v.executors.length<=64&&v.executors.every((e:ExecutorV2)=>validExecutorV2(e)&&e.target.deviceId===v.deviceId&&e.resources.every((r:ResourceAmountV2)=>v.pools.some((p:PoolV2)=>p.resourcePoolId===r.resourcePoolId)))&&unique(v.executors.map((e:ExecutorV2)=>e.target.targetId))&&
    Array.isArray(v.links)&&v.links.length<=128&&v.links.every((l:LinkV2)=>validLinkV2(l))&&Array.isArray(v.credits)&&v.credits.length===3&&v.credits.every((c:CreditV2)=>validCreditV2(c))&&unique(v.credits.map((c:CreditV2)=>c.priority));
}
export function validAllotmentGrantV2(v:AllotmentGrantV2):boolean{return exact(v,['allotmentId','groupId','deviceId','appInstanceId','holderInstanceId','ledgerEpoch','coordinatorEpoch','version','base','extra','leaseRequestId','leaseMs','signature'])&&[v.allotmentId,v.groupId,v.deviceId,v.holderInstanceId,v.leaseRequestId].every((s:string)=>id(s))&&(v.appInstanceId===null||id(v.appInstanceId))&&[v.ledgerEpoch,v.coordinatorEpoch,v.version].every((n:number)=>integer(n,1))&&validResourceVectorV2(v.base)&&validResourceVectorV2(v.extra)&&(v.appInstanceId!==null||v.base.every((a:ResourceAmountV2)=>a.amount===0))&&nonnegative(v.leaseMs)&&v.leaseMs>0&&v.leaseMs<=300000&&typeof v.signature==='string'&&/^[A-Za-z0-9+/=]{32,2048}$/.test(v.signature);}
export function validAllotmentAckV2(v:AllotmentAckV2):boolean{return exact(v,['allotmentId','holderInstanceId','ledgerEpoch','coordinatorEpoch','version','persisted','settlementSeq','occupied'])&&[v.allotmentId,v.holderInstanceId].every((s:string)=>id(s))&&[v.ledgerEpoch,v.coordinatorEpoch,v.version].every((n:number)=>integer(n,1))&&typeof v.persisted==='boolean'&&integer(v.settlementSeq)&&validResourceVectorV2(v.occupied);}
export function validTransferHopV2(v:TransferHopV2):boolean{return exact(v,['ref','from','to','via'])&&validArtifactRefV2(v.ref)&&id(v.from)&&id(v.to)&&(v.via===null||id(v.via));}
export function validDependencyV2(v:DependencyV2):boolean{return exact(v,['nodeId','planRevision','committed'])&&id(v.nodeId)&&integer(v.planRevision,1)&&typeof v.committed==='boolean';}
export function validDispatchOfferV2(v:DispatchOfferV2):boolean{
  return exact(v,['task','target','resources','allowedConfigs','allotmentId','allotmentVersion','leaseMs','transferPlan','dependencies','reasonCode'])&&validTaskInstanceV2(v.task)&&validTargetV2(v.target)&&v.task.allowedTargetIds.includes(v.target.targetId)&&
    validResourceVectorV2(v.resources)&&v.resources.length>0&&v.resources.every((r:ResourceAmountV2)=>v.target.resourcePoolIds.includes(r.resourcePoolId))&&
    Array.isArray(v.allowedConfigs)&&v.allowedConfigs.length>0&&v.allowedConfigs.length<=64&&v.allowedConfigs.every((c:ExecutionConfigV2)=>validExecutionConfigV2(c)&&v.task.allowedConfigurations.includes(c.id))&&unique(v.allowedConfigs.map((c:ExecutionConfigV2)=>c.id))&&
    id(v.allotmentId)&&integer(v.allotmentVersion,1)&&nonnegative(v.leaseMs)&&v.leaseMs>0&&v.leaseMs<=v.task.budget.remainingMs&&
    Array.isArray(v.transferPlan)&&v.transferPlan.length<=256&&v.transferPlan.every((h:TransferHopV2)=>validTransferHopV2(h)&&h.to===v.target.deviceId)&&Array.isArray(v.dependencies)&&v.dependencies.length<=64&&v.dependencies.every((d:DependencyV2)=>validDependencyV2(d))&&unique(v.dependencies.map((d:DependencyV2)=>d.nodeId))&&id(v.reasonCode);
}
export function validAdmissionReplyV2(v:AdmissionReplyV2):boolean{return exact(v,['attemptId','holderInstanceId','status','reasonCode','record','wait'])&&id(v.attemptId)&&id(v.holderInstanceId)&&['ACCEPTED','REJECTED'].includes(v.status)&&(v.reasonCode===null||id(v.reasonCode))&&validNumericSampleV2(v.wait)&&v.wait.unit==='ms'&&(v.status==='ACCEPTED'?validAttemptRecordV2(v.record!)&&v.record!.attemptId===v.attemptId&&v.record!.holderInstanceId===v.holderInstanceId:v.record===null&&v.reasonCode!==null);}
export function validExecutionReportV2(v:ExecutionReportV2):boolean{return exact(v,['receipt','allotmentId','allotmentVersion','leaseId','actualModel','timings'])&&validExecutionReceiptV2(v.receipt)&&id(v.allotmentId)&&integer(v.allotmentVersion,1)&&id(v.leaseId)&&(v.actualModel===null||validModelManifestV2(v.actualModel))&&Array.isArray(v.timings)&&v.timings.length<=32&&v.timings.every((s:NumericSampleV2)=>validNumericSampleV2(s)&&s.unit==='ms');}
export function validYieldNoticeV2(v:YieldNoticeV2):boolean{return exact(v,['attemptId','kind','releaseMs','checkpoint','reasonCode'])&&id(v.attemptId)&&['CHECKPOINT','RESTART','DRAINING'].includes(v.kind)&&validNumericSampleV2(v.releaseMs)&&v.releaseMs.unit==='ms'&&(v.checkpoint===null||validArtifactRefV2(v.checkpoint))&&(v.kind!=='CHECKPOINT'||v.checkpoint!==null)&&id(v.reasonCode);}
export function validAttemptStatusReplyV2(v:AttemptStatusReplyV2):boolean{return exact(v,['attemptId','record'])&&id(v.attemptId)&&(v.record===null||validAttemptRecordV2(v.record)&&v.record.attemptId===v.attemptId);}
export function validCapabilityPackV2(v:CapabilityPackV2):boolean{return exact(v,['packId','contract','executorIds','model','suiteId','qualityThreshold','resourceLimit'])&&id(v.packId)&&validTaskContractV2(v.contract)&&Array.isArray(v.executorIds)&&v.executorIds.length>0&&v.executorIds.length<=64&&unique(v.executorIds)&&(v.model===null||validModelManifestV2(v.model))&&id(v.suiteId)&&nonnegative(v.qualityThreshold)&&v.qualityThreshold<=1&&validResourceVectorV2(v.resourceLimit)&&v.resourceLimit.length>0;}
export function validCapabilityAdmissionV2(v:CapabilityAdmissionV2):boolean{
  return exact(v,['groupId','holderInstanceId','targetId','identity','domain','revision','state','reasonCode','quality'])&&
    [v.groupId,v.holderInstanceId,v.targetId,v.reasonCode].every((s:string)=>id(s))&&
    typeof v.identity==='string'&&/^[a-f0-9]{64}$/.test(v.identity)&&['REAL','SIMULATED'].includes(v.domain)&&integer(v.revision,1)&&
    ['DISCOVERED','VALIDATING','CALIBRATING','CANARY','ACTIVE','WAITING_AUTH','WAITING_MODEL','WAITING_RESOURCE','WAITING_WINDOW','SUSPENDED'].includes(v.state)&&
    validNumericSampleV2(v.quality)&&v.quality.unit==='score'&&(v.quality.value===null||v.quality.value<=1)&&
    (v.domain==='REAL'?['MEASURED','UNKNOWN'].includes(v.quality.source):['SIMULATED','UNKNOWN'].includes(v.quality.source))&&
    (!['CANARY','ACTIVE'].includes(v.state)||v.quality.value!==null);
}

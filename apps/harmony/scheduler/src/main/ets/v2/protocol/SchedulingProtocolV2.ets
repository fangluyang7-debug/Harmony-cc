/** T1 wire types. Times are milliseconds; bytes and revisions are safe integers. */
export interface ExtensionV2 { namespace: string; version: number; payload: string; required: boolean; }
export interface VersionHelloV2 { versions: number[]; extensions: ExtensionV2[]; }
export interface MessageEnvelopeV2 {
  protocolVersion: number; messageId: string; type: string; groupId: string;
  senderInstanceId: string; coordinatorEpoch: number; seq: number;
  ackOf: string | null; traceId: string; payload: string; extensions: ExtensionV2[];
}
export interface AppIdentityV2 { groupId: string; principalId: string; appId: string; appInstanceId: string; allowedContracts: string[]; }
export interface ArtifactRefV2 { artifactId: string; contentVersion: number; contentHash: string; schemaId: string; schemaVersion: number; }
export interface ArtifactGrantV2 { ref: ArtifactRefV2; groupId: string; ownerPrincipalId: string; ownerAppId: string; allowedAppInstanceIds: string[]; operations: string[]; expiresAt: number; }
export interface TaskContractV2 {
  contractId: string; version: number; capability: string; inputSchemas: string[]; outputSchemas: string[];
  sideEffectPolicy: string; interruptibility: string; maxNonPreemptibleMs: number | null;
}
export interface BudgetV2 { remainingMs: number; deadlineAt: number; }
export interface TargetV2 { targetId: string; deviceId: string; executorId: string; executorVersion: string; backend: string; resourcePoolIds: string[]; stableExecutionId: string; }
export interface TaskInstanceV2 {
  groupId: string; sessionId: string | null; originDeviceId: string; resultDestination: string;
  workflowId: string; nodeId: string; attemptId: string; coordinatorEpoch: number; planRevision: number;
  app: AppIdentityV2; contract: TaskContractV2; budget: BudgetV2; inputs: ArtifactRefV2[];
  allowedTargetIds: string[]; qualityTarget: string; privacy: string; priority: string;
  parameters: string; allowedConfigurations: string[]; businessIdempotencyKey: string | null;
}
export interface WorkflowNodeV2 { task: TaskInstanceV2; dependsOn: string[]; }
export interface WorkflowV2 { workflowId: string; outputContract: string; qualityTarget: string; nodes: WorkflowNodeV2[]; }
export interface AlternativesV2 { alternativesId: string; outputContract: string; qualityTarget: string; alternatives: WorkflowV2[]; }
export interface FenceV2 { deviceId: string; holderInstanceId: string; ledgerEpoch: number; counter: number; }
export interface ExecutionReceiptV2 {
  attemptId: string; coordinatorEpoch: number; planRevision: number; fence: FenceV2;
  state: string; resourcesSettled: boolean; outputs: ArtifactRefV2[]; actualTarget: TargetV2;
  actualConfiguration: string; errorCode: string | null;
}
export interface AttemptRecordV2 {
  groupId: string; principalId: string; appInstanceId: string; attemptId: string;
  holderInstanceId: string; ledgerEpoch: number; planRevision: number; coordinatorEpoch: number;
  executionDigest: string; allotmentId: string; allotmentVersion: number; leaseId: string; fence: FenceV2;
  businessIdempotencyKey: string | null; state: string; resourcesSettled: boolean; receipt: ExecutionReceiptV2 | null;
}
export interface AttemptStatusQueryV2 { groupId: string; attemptId: string; holderInstanceId: string; coordinatorEpoch: number; }
export interface ProtocolErrorV2 { version: number; code: string; retryable: boolean; messageId: string | null; }
export interface TraceSpanV2 {
  traceId: string; spanId: string; parentSpanId: string | null; dependsOn: string[]; transferId: string | null;
  workflowId: string; nodeId: string; attemptId: string; targetId: string; deviceInstanceId: string;
  phase: string; durationMs: number; snapshotVersion: number; predictedMs: number | null; reasonCode: string | null;
  startMono: number; endMono: number; clockDomainId: string; measurementScope: string; authoritativeSide: string;
}

function objectV2(value: Object): boolean { return value!==null && typeof value==='object' && !Array.isArray(value); }
function exactV2(value: Object, names: string[]): boolean {
  if(!objectV2(value))return false;
  const keys=Object.keys(value);
  return keys.length===names.length&&keys.every((key:string)=>names.indexOf(key)>=0);
}
function idV2(value: string): boolean { return typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value); }
function integerV2(value: number, minimum: number): boolean { return Number.isSafeInteger(value)&&value>=minimum; }
function timeV2(value: number): boolean { return typeof value==='number'&&Number.isFinite(value)&&value>=0; }
function idsV2(value: string[], maximum: number): boolean { return Array.isArray(value)&&value.length<=maximum&&value.every((id:string)=>idV2(id))&&new Set(value).size===value.length; }
function nullableIdV2(value: string | null): boolean { return value===null||idV2(value); }
function hashV2(value: string): boolean { return typeof value==='string'&&/^[a-f0-9]{64}$/.test(value); }
function textV2(value: string): boolean { return typeof value==='string'&&value.length>0&&value.length<=65536; }
export function validExtensionV2(e: ExtensionV2): boolean {
  return exactV2(e,['namespace','version','payload','required'])&&idV2(e.namespace)&&integerV2(e.version,1)&&textV2(e.payload)&&typeof e.required==='boolean';
}
export function validVersionHelloV2(v: VersionHelloV2): boolean {
  return exactV2(v,['versions','extensions'])&&Array.isArray(v.versions)&&v.versions.length>0&&v.versions.length<=16&&
    new Set(v.versions).size===v.versions.length&&v.versions.every((n:number)=>integerV2(n,1))&&
    Array.isArray(v.extensions)&&v.extensions.length<=16&&v.extensions.every((e:ExtensionV2)=>validExtensionV2(e))&&new Set(v.extensions.map((e:ExtensionV2)=>e.namespace+':'+e.version)).size===v.extensions.length;
}
export function negotiateVersionV2(local: VersionHelloV2, remote: VersionHelloV2): number | null {
  if(!validVersionHelloV2(local)||!validVersionHelloV2(remote))return null;
  if(remote.extensions.some((e:ExtensionV2)=>e.required&&!local.extensions.some((s:ExtensionV2)=>s.namespace===e.namespace&&s.version===e.version))||
     local.extensions.some((e:ExtensionV2)=>e.required&&!remote.extensions.some((s:ExtensionV2)=>s.namespace===e.namespace&&s.version===e.version)))return null;
  const common=local.versions.filter((n:number)=>remote.versions.indexOf(n)>=0);
  return common.length?Math.max(...common):null;
}
export function validMessageEnvelopeV2(v: MessageEnvelopeV2, supportedExtensions: ExtensionV2[]): boolean {
  return exactV2(v,['protocolVersion','messageId','type','groupId','senderInstanceId','coordinatorEpoch','seq','ackOf','traceId','payload','extensions'])&&
    v.protocolVersion===2&&[v.messageId,v.type,v.groupId,v.senderInstanceId,v.traceId].every((s:string)=>idV2(s))&&
    integerV2(v.coordinatorEpoch,1)&&integerV2(v.seq,1)&&nullableIdV2(v.ackOf)&&textV2(v.payload)&&
    Array.isArray(v.extensions)&&v.extensions.length<=16&&v.extensions.every((e:ExtensionV2)=>validExtensionV2(e)&&(!e.required||supportedExtensions.some((s:ExtensionV2)=>s.namespace===e.namespace&&s.version===e.version)));
}
export function validAppIdentityV2(v: AppIdentityV2): boolean {
  return exactV2(v,['groupId','principalId','appId','appInstanceId','allowedContracts'])&&[v.groupId,v.principalId,v.appId,v.appInstanceId].every((s:string)=>idV2(s))&&idsV2(v.allowedContracts,64);
}
export function validArtifactRefV2(v: ArtifactRefV2): boolean {
  return exactV2(v,['artifactId','contentVersion','contentHash','schemaId','schemaVersion'])&&idV2(v.artifactId)&&idV2(v.schemaId)&&integerV2(v.contentVersion,1)&&integerV2(v.schemaVersion,1)&&hashV2(v.contentHash);
}
export function validArtifactGrantV2(v: ArtifactGrantV2): boolean {
  return exactV2(v,['ref','groupId','ownerPrincipalId','ownerAppId','allowedAppInstanceIds','operations','expiresAt'])&&validArtifactRefV2(v.ref)&&
    [v.groupId,v.ownerPrincipalId,v.ownerAppId].every((s:string)=>idV2(s))&&idsV2(v.allowedAppInstanceIds,64)&&idsV2(v.operations,2)&&v.operations.length>0&&v.operations.every((s:string)=>s==='READ'||s==='WRITE')&&timeV2(v.expiresAt);
}
/** caller identity must be supplied by the authenticated adapter, never the request body. */
export function allowsArtifactV2(grant: ArtifactGrantV2, caller: AppIdentityV2, operation: string, now: number): boolean {
  return validArtifactGrantV2(grant)&&validAppIdentityV2(caller)&&timeV2(now)&&grant.expiresAt>now&&grant.groupId===caller.groupId&&
    grant.allowedAppInstanceIds.indexOf(caller.appInstanceId)>=0&&grant.operations.indexOf(operation)>=0;
}
export function validTaskContractV2(v: TaskContractV2): boolean {
  return exactV2(v,['contractId','version','capability','inputSchemas','outputSchemas','sideEffectPolicy','interruptibility','maxNonPreemptibleMs'])&&
    idV2(v.contractId)&&integerV2(v.version,1)&&idV2(v.capability)&&idsV2(v.inputSchemas,64)&&idsV2(v.outputSchemas,64)&&v.outputSchemas.length>0&&
    ['PURE','IDEMPOTENT_WRITE','TRANSACTIONAL','NO_REPLAY'].indexOf(v.sideEffectPolicy)>=0&&['CHECKPOINT','CANCEL_RESTART','NON_INTERRUPTIBLE'].indexOf(v.interruptibility)>=0&&
    (v.maxNonPreemptibleMs===null||timeV2(v.maxNonPreemptibleMs));
}
export function validBudgetV2(v: BudgetV2): boolean { return exactV2(v,['remainingMs','deadlineAt'])&&timeV2(v.remainingMs)&&v.remainingMs>0&&timeV2(v.deadlineAt)&&v.deadlineAt>0; }
export function validTargetV2(v: TargetV2): boolean {
  return exactV2(v,['targetId','deviceId','executorId','executorVersion','backend','resourcePoolIds','stableExecutionId'])&&
    [v.targetId,v.deviceId,v.executorId,v.executorVersion,v.backend,v.stableExecutionId].every((s:string)=>idV2(s))&&idsV2(v.resourcePoolIds,32)&&v.resourcePoolIds.length>0;
}
export function validTaskInstanceV2(v: TaskInstanceV2): boolean {
  return exactV2(v,['groupId','sessionId','originDeviceId','resultDestination','workflowId','nodeId','attemptId','coordinatorEpoch','planRevision','app','contract','budget','inputs','allowedTargetIds','qualityTarget','privacy','priority','parameters','allowedConfigurations','businessIdempotencyKey'])&&
    [v.groupId,v.originDeviceId,v.resultDestination,v.workflowId,v.nodeId,v.attemptId,v.qualityTarget].every((s:string)=>idV2(s))&&nullableIdV2(v.sessionId)&&
    integerV2(v.coordinatorEpoch,1)&&integerV2(v.planRevision,1)&&validAppIdentityV2(v.app)&&v.app.groupId===v.groupId&&validTaskContractV2(v.contract)&&
    v.app.allowedContracts.indexOf(v.contract.contractId)>=0&&validBudgetV2(v.budget)&&Array.isArray(v.inputs)&&v.inputs.length<=256&&v.inputs.every((r:ArtifactRefV2)=>validArtifactRefV2(r))&&
    idsV2(v.allowedTargetIds,64)&&v.allowedTargetIds.length>0&&['LOCAL_ONLY','AUTHORIZED_REMOTE'].indexOf(v.privacy)>=0&&
    ['ORIGIN_INTERACTIVE','REMOTE_INTERACTIVE','REMOTE_BATCH'].indexOf(v.priority)>=0&&textV2(v.parameters)&&idsV2(v.allowedConfigurations,64)&&v.allowedConfigurations.length>0&&
    nullableIdV2(v.businessIdempotencyKey)&&(v.contract.sideEffectPolicy!=='IDEMPOTENT_WRITE'||v.businessIdempotencyKey!==null);
}
export function validWorkflowV2(v: WorkflowV2): boolean {
  if(!exactV2(v,['workflowId','outputContract','qualityTarget','nodes'])||![v.workflowId,v.outputContract,v.qualityTarget].every((s:string)=>idV2(s))||!Array.isArray(v.nodes)||v.nodes.length<1||v.nodes.length>64)return false;
  const seen:string[]=[];
  const attempts:string[]=[];
  for(const n of v.nodes){
    if(!exactV2(n,['task','dependsOn'])||!validTaskInstanceV2(n.task)||n.task.workflowId!==v.workflowId||!idsV2(n.dependsOn,64)||n.dependsOn.some((id:string)=>seen.indexOf(id)<0)||seen.indexOf(n.task.nodeId)>=0)return false;
    const first=v.nodes[0].task;
    if(attempts.indexOf(n.task.attemptId)>=0||n.task.groupId!==first.groupId||n.task.app.principalId!==first.app.principalId||n.task.app.appInstanceId!==first.app.appInstanceId||n.task.originDeviceId!==first.originDeviceId||n.task.resultDestination!==first.resultDestination)return false;
    seen.push(n.task.nodeId);attempts.push(n.task.attemptId);
  }
  const finalTask=v.nodes[v.nodes.length-1].task;
  return finalTask.contract.outputSchemas.indexOf(v.outputContract)>=0&&finalTask.qualityTarget===v.qualityTarget;
}
export function validWorkflowNodeV2(v: WorkflowNodeV2): boolean {
  return exactV2(v,['task','dependsOn'])&&validTaskInstanceV2(v.task)&&idsV2(v.dependsOn,64)&&v.dependsOn.indexOf(v.task.nodeId)<0;
}
export function validAlternativesV2(v: AlternativesV2): boolean {
  return exactV2(v,['alternativesId','outputContract','qualityTarget','alternatives'])&&[v.alternativesId,v.outputContract,v.qualityTarget].every((s:string)=>idV2(s))&&Array.isArray(v.alternatives)&&v.alternatives.length>0&&v.alternatives.length<=8&&
    v.alternatives.every((w:WorkflowV2)=>validWorkflowV2(w)&&w.outputContract===v.outputContract&&w.qualityTarget===v.qualityTarget)&&new Set(v.alternatives.map((w:WorkflowV2)=>w.workflowId)).size===v.alternatives.length;
}
export function validFenceV2(v: FenceV2): boolean { return exactV2(v,['deviceId','holderInstanceId','ledgerEpoch','counter'])&&idV2(v.deviceId)&&idV2(v.holderInstanceId)&&integerV2(v.ledgerEpoch,1)&&integerV2(v.counter,1); }
export function equalFenceV2(a: FenceV2,b: FenceV2): boolean { return validFenceV2(a)&&validFenceV2(b)&&a.deviceId===b.deviceId&&a.holderInstanceId===b.holderInstanceId&&a.ledgerEpoch===b.ledgerEpoch&&a.counter===b.counter; }
export function validExecutionReceiptV2(v: ExecutionReceiptV2): boolean {
  return exactV2(v,['attemptId','coordinatorEpoch','planRevision','fence','state','resourcesSettled','outputs','actualTarget','actualConfiguration','errorCode'])&&
    idV2(v.attemptId)&&integerV2(v.coordinatorEpoch,1)&&integerV2(v.planRevision,1)&&validFenceV2(v.fence)&&
    ['SUCCEEDED','FAILED','CANCELLED_SETTLED','YIELDED','SIDE_EFFECT_UNKNOWN'].indexOf(v.state)>=0&&typeof v.resourcesSettled==='boolean'&&
    (v.state!=='CANCELLED_SETTLED'||v.resourcesSettled)&&Array.isArray(v.outputs)&&v.outputs.length<=256&&v.outputs.every((r:ArtifactRefV2)=>validArtifactRefV2(r))&&
    validTargetV2(v.actualTarget)&&v.fence.deviceId===v.actualTarget.deviceId&&idV2(v.actualConfiguration)&&nullableIdV2(v.errorCode);
}
export function validAttemptRecordV2(v: AttemptRecordV2): boolean {
  return exactV2(v,['groupId','principalId','appInstanceId','attemptId','holderInstanceId','ledgerEpoch','planRevision','coordinatorEpoch','executionDigest','allotmentId','allotmentVersion','leaseId','fence','businessIdempotencyKey','state','resourcesSettled','receipt'])&&
    [v.groupId,v.principalId,v.appInstanceId,v.attemptId,v.holderInstanceId,v.allotmentId,v.leaseId].every((s:string)=>idV2(s))&&
    [v.ledgerEpoch,v.planRevision,v.coordinatorEpoch,v.allotmentVersion].every((n:number)=>integerV2(n,1))&&hashV2(v.executionDigest)&&validFenceV2(v.fence)&&
    v.fence.holderInstanceId===v.holderInstanceId&&v.fence.ledgerEpoch===v.ledgerEpoch&&nullableIdV2(v.businessIdempotencyKey)&&
    ['ACCEPTED','RUNNING','SUCCEEDED','FAILED','CANCELLED_SETTLED','YIELDED','SIDE_EFFECT_UNKNOWN'].indexOf(v.state)>=0&&typeof v.resourcesSettled==='boolean'&&
    (v.state!=='CANCELLED_SETTLED'||v.resourcesSettled)&&
    (v.receipt===null||validExecutionReceiptV2(v.receipt)&&v.receipt.attemptId===v.attemptId&&v.receipt.state===v.state&&v.receipt.resourcesSettled===v.resourcesSettled&&v.receipt.coordinatorEpoch===v.coordinatorEpoch&&v.receipt.planRevision===v.planRevision&&equalFenceV2(v.receipt.fence,v.fence));
}
/** Admission is persistent upstream; this is only the final submission guard. */
export function mayCommitReceiptV2(record: AttemptRecordV2, receipt: ExecutionReceiptV2, currentEpoch: number, currentRevision: number): boolean {
  return validAttemptRecordV2(record)&&validExecutionReceiptV2(receipt)&&record.attemptId===receipt.attemptId&&record.planRevision===currentRevision&&receipt.planRevision===currentRevision&&
    record.coordinatorEpoch===currentEpoch&&receipt.coordinatorEpoch===currentEpoch&&equalFenceV2(record.fence,receipt.fence)&&receipt.state==='SUCCEEDED';
}
export function validAttemptStatusQueryV2(v: AttemptStatusQueryV2): boolean { return exactV2(v,['groupId','attemptId','holderInstanceId','coordinatorEpoch'])&&[v.groupId,v.attemptId,v.holderInstanceId].every((s:string)=>idV2(s))&&integerV2(v.coordinatorEpoch,1); }
export function validProtocolErrorV2(v: ProtocolErrorV2): boolean { return exactV2(v,['version','code','retryable','messageId'])&&v.version===2&&idV2(v.code)&&typeof v.retryable==='boolean'&&nullableIdV2(v.messageId); }
export function validTraceSpanV2(v: TraceSpanV2): boolean {
  return exactV2(v,['traceId','spanId','parentSpanId','dependsOn','transferId','workflowId','nodeId','attemptId','targetId','deviceInstanceId','phase','durationMs','snapshotVersion','predictedMs','reasonCode','startMono','endMono','clockDomainId','measurementScope','authoritativeSide'])&&
    [v.traceId,v.spanId,v.workflowId,v.nodeId,v.attemptId,v.targetId,v.deviceInstanceId,v.clockDomainId].every((s:string)=>idV2(s))&&nullableIdV2(v.parentSpanId)&&nullableIdV2(v.transferId)&&idsV2(v.dependsOn,64)&&v.dependsOn.indexOf(v.spanId)<0&&v.parentSpanId!==v.spanId&&
    ['PLAN','OFFER','ADMIT','QUEUE','TRANSFER_SEND','TRANSFER_RECV','LOAD','EXECUTE','PUBLISH','DELIVER','YIELD','RETRY'].indexOf(v.phase)>=0&&
    timeV2(v.startMono)&&timeV2(v.endMono)&&v.endMono>=v.startMono&&timeV2(v.durationMs)&&Math.abs(v.durationMs-(v.endMono-v.startMono))<0.001&&
    integerV2(v.snapshotVersion,1)&&(v.predictedMs===null||timeV2(v.predictedMs))&&nullableIdV2(v.reasonCode)&&
    ['LOCAL_INTERVAL','FULL_TRANSFER','PARTIAL_TRANSFER'].indexOf(v.measurementScope)>=0&&['SELF','SENDER','RECEIVER'].indexOf(v.authoritativeSide)>=0&&
    (!v.phase.startsWith('TRANSFER_')||v.transferId!==null);
}

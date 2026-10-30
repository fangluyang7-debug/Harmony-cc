import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '../generated/client';
import {
  AttemptRecordV2, ExecutionReceiptV2, MessageEnvelopeV2, TaskInstanceV2,
  canonical, validAttemptRecordV2, validExecutionReceiptV2, validMessageEnvelopeV2,
  validTaskInstanceV2, mayCommitReceiptV2, protocolId, recoveryAction, RecoveryAction, DispatchOfferV2, validDispatchOfferV2,
  AttemptStatusReplyV2, validAttemptStatusReplyV2
} from '@harmony/scheduler-core';

export function executionDigest(task:TaskInstanceV2):string {
  return createHash('sha256').update(canonical({inputs:task.inputs,contract:task.contract,parameters:task.parameters,
    allowedTargetIds:task.allowedTargetIds,allowedConfigurations:task.allowedConfigurations})).digest('hex');
}
/** All methods are internal control-plane operations; HTTP adapters must authenticate first. */
export class CoordinatorStore {
  constructor(readonly db:PrismaClient,readonly senderInstanceId:string){}
  async persistOffer(offer:DispatchOfferV2,holderInstanceId:string,message:MessageEnvelopeV2):Promise<'CREATED'|'EXISTING'> {
    if(!validDispatchOfferV2(offer))throw new Error('ATTEMPT_INVALID');
    const task=offer.task;
    if(!validTaskInstanceV2(task)||!protocolId(holderInstanceId)||!validMessageEnvelopeV2(message,[])||
      message.type!=='DispatchOffer'||message.groupId!==task.groupId||message.senderInstanceId!==this.senderInstanceId||message.coordinatorEpoch!==task.coordinatorEpoch||
      message.payload!==JSON.stringify(offer))throw new Error('ATTEMPT_INVALID');
    return this.db.$transaction(async tx=>{
      const digest=executionDigest(task);
      const existing=await tx.attempt.findUnique({where:{id:task.attemptId}});
      if(existing){
        const previous=JSON.parse(existing.taskJson) as TaskInstanceV2;
        if(existing.offerJson===null||canonical(JSON.parse(existing.offerJson))!==canonical(offer)||existing.groupId!==task.groupId||existing.executionDigest!==digest||existing.holderInstanceId!==holderInstanceId||
          previous.app.principalId!==task.app.principalId||previous.app.appInstanceId!==task.app.appInstanceId||existing.workflowId!==task.workflowId||existing.nodeId!==JSON.stringify([task.workflowId,task.nodeId]))throw new Error('ATTEMPT_CONFLICT');
        return 'EXISTING';
      }
      const workflow=await tx.workflow.findUnique({where:{id:task.workflowId}});
      if(workflow&&(workflow.groupId!==task.groupId||workflow.planRevision!==task.planRevision))throw new Error('WORKFLOW_CONFLICT');
      await tx.workflow.upsert({where:{id:task.workflowId},create:{id:task.workflowId,groupId:task.groupId,planRevision:task.planRevision,state:'ACTIVE'},update:{}});
      const nodeId=JSON.stringify([task.workflowId,task.nodeId]);
      const node=await tx.node.findUnique({where:{id:nodeId}});
      if(node?.currentAttemptId)throw new Error('NODE_HAS_CURRENT_ATTEMPT');
      await tx.node.upsert({where:{id:nodeId},create:{id:nodeId,workflowId:task.workflowId,currentAttemptId:task.attemptId,state:'OFFERED'},update:{currentAttemptId:task.attemptId,state:'OFFERED'}});
      await tx.attempt.create({data:{id:task.attemptId,groupId:task.groupId,workflowId:task.workflowId,nodeId,holderInstanceId,executionDigest:digest,state:'OFFERED',recordJson:null,taskJson:JSON.stringify(task),offerJson:JSON.stringify(offer)}});
      const sequence=await tx.dispatchSequence.upsert({where:{id:this.senderInstanceId},create:{id:this.senderInstanceId,value:1},update:{value:{increment:1}}});
      await tx.outbox.create({data:{id:message.messageId,sequence:sequence.value,groupId:task.groupId,attemptId:task.attemptId,kind:message.type,epoch:message.coordinatorEpoch,messageJson:JSON.stringify({...message,seq:sequence.value})}});
      return 'CREATED';
    });
  }
  /** Called only after the authenticated holder's persisted admission reply. */
  async recordAdmission(record:AttemptRecordV2):Promise<void>{
    if(!validAttemptRecordV2(record)||record.state!=='ACCEPTED'||record.resourcesSettled||record.receipt!==null)throw new Error('ADMISSION_INVALID');
    await this.db.$transaction(async tx=>{
      const row=await tx.attempt.findUnique({where:{id:record.attemptId}});
      if(!row)throw new Error('ATTEMPT_UNKNOWN');
      const task=JSON.parse(row.taskJson) as TaskInstanceV2;
      const offer=row.offerJson===null?null:JSON.parse(row.offerJson) as DispatchOfferV2;
      if(offer&&(offer.allotmentId!==record.allotmentId||offer.allotmentVersion!==record.allotmentVersion||offer.target.deviceId!==record.fence.deviceId))throw new Error('ADMISSION_CONFLICT');
      if(row.groupId!==record.groupId||row.holderInstanceId!==record.holderInstanceId||row.executionDigest!==record.executionDigest||task.app.principalId!==record.principalId||task.app.appInstanceId!==record.appInstanceId||task.coordinatorEpoch!==record.coordinatorEpoch||task.planRevision!==record.planRevision||task.businessIdempotencyKey!==record.businessIdempotencyKey)throw new Error('ADMISSION_CONFLICT');
      if(row.recordJson!==null){
        const previous=JSON.parse(row.recordJson) as AttemptRecordV2;
        if(canonical(previous.fence)!==canonical(record.fence)||previous.leaseId!==record.leaseId||previous.allotmentId!==record.allotmentId||previous.allotmentVersion!==record.allotmentVersion)throw new Error('ADMISSION_CONFLICT');
        return;
      }
      await tx.attempt.update({where:{id:row.id},data:{state:'ACCEPTED',recordJson:JSON.stringify(record)}});
      await tx.node.update({where:{id:row.nodeId},data:{state:'ACCEPTED'}});
    });
  }
  /** Recovery replaces unacknowledged offers with status queries, never new attempts. */
  async recover(epoch:number):Promise<void>{
    if(!Number.isSafeInteger(epoch)||epoch<1)throw new Error('EPOCH_INVALID');
    await this.db.$transaction(async tx=>{
      await tx.outbox.updateMany({where:{acked:false,epoch:{not:epoch}},data:{superseded:true}});
      const attempts=await tx.attempt.findMany();
      for(const row of attempts){
        const record=row.recordJson===null?null:JSON.parse(row.recordJson) as AttemptRecordV2;
        if(record!==null&&!validAttemptRecordV2(record))throw new Error('RECOVERY_RECORD_CORRUPT');
        if(record?.resourcesSettled&&!['ACCEPTED','RUNNING','SIDE_EFFECT_UNKNOWN'].includes(record.state))continue;
        await tx.outbox.updateMany({where:{attemptId:row.id,acked:false,kind:'DispatchOffer'},data:{superseded:true}});
        const id=`status:${epoch}:${row.id}`;
        if(await tx.outbox.findUnique({where:{id}}))continue;
        const sequence=await tx.dispatchSequence.upsert({where:{id:this.senderInstanceId},create:{id:this.senderInstanceId,value:1},update:{value:{increment:1}}});
        const message:MessageEnvelopeV2={protocolVersion:2,messageId:id,type:'AttemptStatusQuery',groupId:row.groupId,senderInstanceId:this.senderInstanceId,
          coordinatorEpoch:epoch,seq:sequence.value,ackOf:null,traceId:row.id,payload:JSON.stringify({groupId:row.groupId,attemptId:row.id,holderInstanceId:row.holderInstanceId,coordinatorEpoch:epoch}),extensions:[]};
        // UUID keeps arbitrarily long attempt IDs inside the wire identifier limit.
        message.messageId=randomUUID();
        await tx.outbox.create({data:{id,sequence:sequence.value,groupId:row.groupId,attemptId:row.id,kind:message.type,epoch,messageJson:JSON.stringify(message)}});
      }
    });
  }
  /** Triggered by connection/retry events. Sent is not ACKed: retry remains at least once. */
  async flush(send:(message:MessageEnvelopeV2)=>Promise<void>):Promise<number>{
    const messages=await this.db.outbox.findMany({where:{acked:false,superseded:false},orderBy:{sequence:'asc'}});
    let count=0;
    for(const row of messages){
      const message=JSON.parse(row.messageJson) as MessageEnvelopeV2;
      if(!validMessageEnvelopeV2(message,[]))throw new Error('OUTBOX_CORRUPT');
      await send(message);
      await this.db.outbox.update({where:{id:row.id},data:{deliveryCount:{increment:1}}});count++;
    }
    return count;
  }
  async acknowledge(groupId:string,messageId:string):Promise<void>{
    // Wire IDs can differ from recovery outbox idempotency keys.
    const rows=await this.db.outbox.findMany({where:{groupId}});
    const row=rows.find(r=>(JSON.parse(r.messageJson) as MessageEnvelopeV2).messageId===messageId);
    if(!row)throw new Error('ACK_UNKNOWN');
    await this.db.outbox.update({where:{id:row.id},data:{acked:true}});
  }
  async reconciliationAction(groupId:string,attemptId:string):Promise<RecoveryAction>{
    const row=await this.db.attempt.findUnique({where:{id:attemptId}});
    if(!row||row.groupId!==groupId)throw new Error('AUTHORIZATION_DENIED');
    if(row.state==='HOLDER_RECORD_MISSING')return 'MANUAL_RECONCILIATION';
    const task=JSON.parse(row.taskJson) as TaskInstanceV2;
    if(row.recordJson===null)return 'QUERY_HOLDER';
    const receipt=await this.db.receipt.findUnique({where:{id:attemptId}});
    if(!receipt)return recoveryAction(task.contract.sideEffectPolicy,row.state,false);
    const evidence=JSON.parse(receipt.recordJson) as ExecutionReceiptV2;
    const record=JSON.parse(row.recordJson) as AttemptRecordV2;
    if(canonical(record.fence)!==canonical(evidence.fence))return 'MANUAL_RECONCILIATION';
    return recoveryAction(task.contract.sideEffectPolicy,evidence.state,evidence.resourcesSettled);
  }
  /** Explicit recovery session request; never replays an offer or allocates another attempt. */
  async requestStatus(groupId:string,holderInstanceId:string,epoch:number):Promise<void>{
    if(!protocolId(groupId)||!protocolId(holderInstanceId)||!Number.isSafeInteger(epoch)||epoch<1)throw Error('RECOVERY_INVALID');
    await this.db.$transaction(async tx=>{
      for(const row of await tx.attempt.findMany({where:{groupId,holderInstanceId}})){
        const record=row.recordJson===null?null:JSON.parse(row.recordJson) as AttemptRecordV2;
        if(record?.resourcesSettled)continue;
        await tx.outbox.updateMany({where:{attemptId:row.id,kind:'DispatchOffer',acked:false},data:{superseded:true}});
        if(await tx.outbox.findFirst({where:{attemptId:row.id,kind:'AttemptStatusQuery',epoch,acked:false,superseded:false}}))continue;
        const sequence=await tx.dispatchSequence.upsert({where:{id:this.senderInstanceId},create:{id:this.senderInstanceId,value:1},update:{value:{increment:1}}});
        const id=randomUUID(),message:MessageEnvelopeV2={protocolVersion:2,messageId:id,type:'AttemptStatusQuery',groupId,senderInstanceId:this.senderInstanceId,
          coordinatorEpoch:epoch,seq:sequence.value,ackOf:null,traceId:row.id,extensions:[],payload:JSON.stringify({groupId,attemptId:row.id,holderInstanceId,coordinatorEpoch:epoch})};
        await tx.outbox.create({data:{id,sequence:sequence.value,groupId,attemptId:row.id,kind:message.type,epoch,messageJson:JSON.stringify(message)}});
      }
    });
  }
  /** Status is reconciliation evidence, never authorization to commit an old result or reclaim an allotment. */
  async reconcileStatus(groupId:string,holderInstanceId:string,deviceId:string,queryId:string,reply:AttemptStatusReplyV2,epoch:number):Promise<void>{
    if(!validAttemptStatusReplyV2(reply)||!protocolId(queryId))throw Error('STATUS_INVALID');
    await this.db.$transaction(async tx=>{
      const queries=await tx.outbox.findMany({where:{groupId,attemptId:reply.attemptId,kind:'AttemptStatusQuery',epoch,superseded:false}});
      const query=queries.find(q=>JSON.parse(q.messageJson).messageId===queryId);
      const row=await tx.attempt.findUnique({where:{id:reply.attemptId}});
      if(!query||!row||row.groupId!==groupId||row.holderInstanceId!==holderInstanceId)throw Error('STATUS_UNAUTHORIZED');
      const offer=row.offerJson?JSON.parse(row.offerJson) as DispatchOfferV2:null,task=JSON.parse(row.taskJson) as TaskInstanceV2;
      if(offer&&offer.target.deviceId!==deviceId)throw Error('STATUS_UNAUTHORIZED');
      const old=row.recordJson?JSON.parse(row.recordJson) as AttemptRecordV2:null,record=reply.record;
      if(record===null){
        if(old)throw Error('STATUS_RECORD_LOST');
        await tx.attempt.update({where:{id:row.id},data:{state:'HOLDER_RECORD_MISSING'}});
      }else{
        if(record.groupId!==groupId||record.holderInstanceId!==holderInstanceId||record.fence.deviceId!==deviceId||record.executionDigest!==row.executionDigest||
          record.principalId!==task.app.principalId||record.appInstanceId!==task.app.appInstanceId||record.businessIdempotencyKey!==task.businessIdempotencyKey||
          record.coordinatorEpoch!==task.coordinatorEpoch||record.planRevision!==task.planRevision||
          offer&&(record.allotmentId!==offer.allotmentId||record.allotmentVersion!==offer.allotmentVersion))throw Error('STATUS_IDENTITY_MISMATCH');
        const identity=(r:AttemptRecordV2)=>{const {state,receipt,resourcesSettled,...identity}=r;return identity;};
        if(old&&canonical(identity(old))!==canonical(identity(record)))throw Error('STATUS_FENCE_MISMATCH');
        if(old?.resourcesSettled&&canonical(old)!==canonical(record))throw Error('STATUS_TERMINAL_CONFLICT');
        if(['ACCEPTED','RUNNING'].includes(record.state)&&(record.resourcesSettled||record.receipt!==null)||
          record.state==='SIDE_EFFECT_UNKNOWN'&&record.resourcesSettled||
          !['ACCEPTED','RUNNING','SIDE_EFFECT_UNKNOWN'].includes(record.state)&&!record.receipt)throw Error('STATUS_STATE_INVALID');
        if(record.receipt){
          const receipt=record.receipt;
          if(!task.allowedTargetIds.includes(receipt.actualTarget.targetId)||!task.allowedConfigurations.includes(receipt.actualConfiguration)||
            offer&&(canonical(receipt.actualTarget)!==canonical(offer.target)||!offer.allowedConfigs.some(c=>c.id===receipt.actualConfiguration)))throw Error('EXECUTION_SCOPE_MISMATCH');
          const previous=await tx.receipt.findUnique({where:{id:row.id}});
          if(previous){
            const oldReceipt=JSON.parse(previous.recordJson) as ExecutionReceiptV2;
            const result=(r:ExecutionReceiptV2)=>{const {resourcesSettled,...result}=r;return result;};
            if(canonical(result(oldReceipt))!==canonical(result(receipt))||oldReceipt.resourcesSettled&&!receipt.resourcesSettled)throw Error('RECEIPT_CONFLICT');
          }
          await tx.receipt.upsert({where:{id:row.id},create:{id:row.id,attemptId:row.id,recordJson:JSON.stringify(receipt),committed:false},update:{recordJson:JSON.stringify(receipt)}});
        }
        await tx.attempt.update({where:{id:row.id},data:{state:record.state,recordJson:JSON.stringify(record)}});
      }
      await tx.outbox.update({where:{id:query.id},data:{acked:true}});
    });
  }
  async receive(groupId:string,holderInstanceId:string,receipt:ExecutionReceiptV2,currentEpoch:number):Promise<'COMMITTED'|'RECONCILE'> {
    if(!validExecutionReceiptV2(receipt))throw new Error('RECEIPT_INVALID');
    return this.db.$transaction(async tx=>{
      const row=await tx.attempt.findUnique({where:{id:receipt.attemptId}});
      if(!row||row.groupId!==groupId)throw new Error('AUTHORIZATION_DENIED');
      const record=row.recordJson===null?null:JSON.parse(row.recordJson) as AttemptRecordV2;
      if(row.holderInstanceId!==holderInstanceId)throw new Error('AUTHORIZATION_DENIED');
      const committed=await tx.receipt.findUnique({where:{id:receipt.attemptId}});
      if(committed?.committed){
        if(canonical(JSON.parse(committed.recordJson))!==canonical(receipt))throw new Error('RECEIPT_CONFLICT');
        return 'COMMITTED';
      }
      const task=JSON.parse(row.taskJson) as TaskInstanceV2;
      if(!validTaskInstanceV2(task)||!task.allowedTargetIds.includes(receipt.actualTarget.targetId)||!task.allowedConfigurations.includes(receipt.actualConfiguration))throw new Error('EXECUTION_SCOPE_MISMATCH');
      const offer=row.offerJson===null?null:JSON.parse(row.offerJson) as DispatchOfferV2;
      if(offer&&(canonical(offer.target)!==canonical(receipt.actualTarget)||!offer.allowedConfigs.some(c=>c.id===receipt.actualConfiguration)))throw new Error('EXECUTION_SCOPE_MISMATCH');
      const workflow=await tx.workflow.findUniqueOrThrow({where:{id:row.workflowId}}),node=await tx.node.findUniqueOrThrow({where:{id:row.nodeId}});
      if(!record||workflow.state!=='ACTIVE'||node.currentAttemptId!==row.id||!mayCommitReceiptV2(record,receipt,currentEpoch,workflow.planRevision)){
        // Preserve evidence for reconciliation; an old epoch is not a new execution grant.
        await tx.receipt.upsert({where:{id:receipt.attemptId},create:{id:receipt.attemptId,attemptId:row.id,recordJson:JSON.stringify(receipt),committed:false},update:{}});
        return 'RECONCILE';
      }
      await tx.receipt.upsert({where:{id:receipt.attemptId},create:{id:receipt.attemptId,attemptId:row.id,recordJson:JSON.stringify(receipt),committed:true},update:{committed:true,recordJson:JSON.stringify(receipt)}});
      await tx.attempt.update({where:{id:row.id},data:{state:receipt.state,recordJson:JSON.stringify({...record,state:receipt.state,resourcesSettled:receipt.resourcesSettled,receipt})}});
      await tx.node.update({where:{id:row.nodeId},data:{state:'COMMITTED'}});
      await tx.outbox.updateMany({where:{attemptId:row.id},data:{acked:true}});
      return 'COMMITTED';
    });
  }
}

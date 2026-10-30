import { createHash, randomUUID } from 'node:crypto';
import { canonical, MessageEnvelopeV2, validMessageEnvelopeV2, protocolId, validAttemptStatusQueryV2, AttemptRecordV2, validDispatchOfferV2 } from '@harmony/scheduler-core';

export interface ChannelJournal {
  coordinatorId:string|null;epoch:number;sequence:number;receivedSequence:number;
  inbox:{id:string;digest:string}[];outbox:MessageEnvelopeV2[];
  dispatches?:{messageId:string;attemptId:string;rejected?:boolean}[];
}
export const newChannelJournal=():ChannelJournal=>({coordinatorId:null,epoch:0,sequence:0,receivedSequence:0,inbox:[],outbox:[]});
const copy=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
export function validateJournal(j:ChannelJournal,groupId:string,holderInstanceId:string){
  if(!j||![j.epoch,j.sequence,j.receivedSequence].every(n=>Number.isSafeInteger(n)&&n>=0)||
    (j.coordinatorId===null?j.epoch!==0:!protocolId(j.coordinatorId)||j.epoch<1)||
    !Array.isArray(j.inbox)||j.inbox.length>4096||j.inbox.some(e=>!protocolId(e.id)||!/^[a-f0-9]{64}$/.test(e.digest))||
    new Set(j.inbox.map(e=>e.id)).size!==j.inbox.length||!Array.isArray(j.outbox)||j.outbox.length>64||
    j.outbox.some(m=>!validMessageEnvelopeV2(m,[])||m.groupId!==groupId||m.senderInstanceId!==holderInstanceId||m.coordinatorEpoch!==j.epoch||
      !['RecoveryRequest','AttemptStatusReply','Ack','AdmissionReply','ExecutionReceipt','TraceBatch'].includes(m.type)||m.seq>j.sequence)||
    new Set(j.outbox.map(m=>m.messageId)).size!==j.outbox.length||j.outbox.some((m,i)=>i>0&&m.seq<=j.outbox[i-1].seq))throw Error('CHANNEL_JOURNAL_CORRUPT');
  if(Buffer.byteLength(JSON.stringify(j.outbox))>1048576)throw Error('CHANNEL_BACKPRESSURE');
  if(j.dispatches!==undefined&&(!Array.isArray(j.dispatches)||j.dispatches.length>4096||j.dispatches.some(d=>!protocolId(d.messageId)||!protocolId(d.attemptId))))throw Error('CHANNEL_JOURNAL_CORRUPT');
}
/** Persist only when admission or rejection is durable; queued offers are not acknowledged prematurely. */
export function receiveDispatch(j:ChannelJournal,m:MessageEnvelopeV2,groupId:string,deviceId:string):ChannelJournal{
  const offer=JSON.parse(m.payload);
  if(!validMessageEnvelopeV2(m,[])||m.type!=='DispatchOffer'||m.senderInstanceId!==j.coordinatorId||m.coordinatorEpoch!==j.epoch||m.groupId!==groupId||m.ackOf!==null||
    !validDispatchOfferV2(offer)||offer.task.groupId!==groupId||offer.task.coordinatorEpoch!==j.epoch||offer.target.deviceId!==deviceId)throw Error('DISPATCH_UNAUTHORIZED');
  const next=copy(j),digest=createHash('sha256').update(canonical(m)).digest('hex'),old=next.inbox.find(e=>e.id===m.messageId);
  if(old){if(old.digest!==digest)throw Error('DISPATCH_MESSAGE_CONFLICT');}
  else{
    // Multiple resource queues can admit in a different order. The immutable attempt ledger is the replay boundary.
    next.inbox.push({id:m.messageId,digest});next.receivedSequence=Math.max(next.receivedSequence,m.seq);
    (next.dispatches??=[]).push({messageId:m.messageId,attemptId:offer.task.attemptId});
  }
  return next;
}
export function bindJournal(j:ChannelJournal,coordinatorId:string,epoch:number):ChannelJournal{
  if(!protocolId(coordinatorId)||!Number.isSafeInteger(epoch)||epoch<1||j.coordinatorId!==null&&j.coordinatorId!==coordinatorId||epoch<j.epoch)throw Error('COORDINATOR_BINDING_MISMATCH');
  const next=copy(j);
  // Supersede replies to old epoch queries. The durable ledger retains every attempt/receipt for fresh queries.
  if(epoch!==next.epoch)next.outbox=[];
  next.coordinatorId=coordinatorId;next.epoch=epoch;return next;
}
export function journalMessage(j:ChannelJournal,groupId:string,holderInstanceId:string,type:string,payload:unknown,ackOf:string|null=null):MessageEnvelopeV2{
  if(j.coordinatorId===null||!Number.isSafeInteger(++j.sequence))throw Error('CHANNEL_NOT_BOUND');
  const m:MessageEnvelopeV2={protocolVersion:2,messageId:randomUUID(),type,groupId,senderInstanceId:holderInstanceId,coordinatorEpoch:j.epoch,
    seq:j.sequence,ackOf,traceId:randomUUID(),payload:JSON.stringify(payload),extensions:[]};
  if(!validMessageEnvelopeV2(m,[]))throw Error('CHANNEL_MESSAGE_INVALID');return m;
}
export function answerQuery(j:ChannelJournal,m:MessageEnvelopeV2,groupId:string,holderInstanceId:string,record:AttemptRecordV2|null):ChannelJournal{
  if(!validMessageEnvelopeV2(m,[])||m.type!=='AttemptStatusQuery'||m.senderInstanceId!==j.coordinatorId||m.coordinatorEpoch!==j.epoch||m.groupId!==groupId||m.ackOf!==null)throw Error('STATUS_QUERY_UNAUTHORIZED');
  const query=JSON.parse(m.payload);
  if(!validAttemptStatusQueryV2(query)||query.groupId!==groupId||query.holderInstanceId!==holderInstanceId||query.coordinatorEpoch!==j.epoch||record&&record.attemptId!==query.attemptId)throw Error('STATUS_QUERY_UNAUTHORIZED');
  const next=copy(j),digest=createHash('sha256').update(canonical(m)).digest('hex'),old=next.inbox.find(e=>e.id===m.messageId);
  if(old){if(old.digest!==digest)throw Error('QUERY_MESSAGE_CONFLICT');}
  else{
    if(m.seq<=next.receivedSequence)throw Error('QUERY_SEQUENCE_REORDERED');
    next.inbox.push({id:m.messageId,digest});next.receivedSequence=m.seq;
    next.outbox.push(journalMessage(next,groupId,holderInstanceId,'AttemptStatusReply',{attemptId:query.attemptId,record},m.messageId));
  }
  if(!next.outbox.some(p=>p.type==='Ack'&&p.ackOf===m.messageId))next.outbox.push(journalMessage(next,groupId,holderInstanceId,'Ack',{messageId:m.messageId},m.messageId));
  validateJournal(next,groupId,holderInstanceId);return next;
}

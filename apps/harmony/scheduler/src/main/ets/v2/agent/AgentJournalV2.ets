import { MessageEnvelopeV2, validMessageEnvelopeV2, AttemptRecordV2, AttemptStatusQueryV2, validAttemptStatusQueryV2 } from '../protocol/SchedulingProtocolV2';
import { DispatchOfferV2, validDispatchOfferV2, AttemptStatusReplyV2 } from '../protocol/ResourcesV2';
import { canonical } from '../core/CanonicalV2';
const protocolId=(value:string):boolean=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
export interface InboxV2 { id:string;digest:string; }
export interface AgentJournalV2 { coordinatorId:string|null;epoch:number;sequence:number;receivedSequence:number;inbox:InboxV2[];outbox:MessageEnvelopeV2[]; }
export interface AgentMessageFactoryV2 { id():string;digest(text:string):string; }
export function newAgentJournalV2():AgentJournalV2 {return {coordinatorId:null,epoch:0,sequence:0,receivedSequence:0,inbox:[],outbox:[]};}
export function validateAgentJournalV2(j:AgentJournalV2,group:string,holder:string):void {
 if(!j||![j.epoch,j.sequence,j.receivedSequence].every(n=>Number.isSafeInteger(n)&&n>=0)||
  (j.coordinatorId===null?j.epoch!==0:!protocolId(j.coordinatorId)||j.epoch<1)||
  !Array.isArray(j.inbox)||j.inbox.length>4096||j.inbox.some(e=>!protocolId(e.id)||!/^[a-f0-9]{64}$/.test(e.digest))||new Set(j.inbox.map(e=>e.id)).size!==j.inbox.length||
  !Array.isArray(j.outbox)||j.outbox.length>64||j.outbox.some((m,i)=>!validMessageEnvelopeV2(m,[])||m.groupId!==group||m.senderInstanceId!==holder||m.coordinatorEpoch!==j.epoch||m.seq>j.sequence||i>0&&m.seq<=j.outbox[i-1].seq)||new Set(j.outbox.map(m=>m.messageId)).size!==j.outbox.length)throw Error('CHANNEL_JOURNAL_CORRUPT');
 if(JSON.stringify(j.outbox).length>1048576)throw Error('CHANNEL_BACKPRESSURE');
}
export function bindAgentJournalV2(j:AgentJournalV2,id:string,epoch:number):AgentJournalV2 {
 if(!protocolId(id)||!Number.isSafeInteger(epoch)||epoch<1||j.coordinatorId!==null&&j.coordinatorId!==id||epoch<j.epoch)throw Error('COORDINATOR_BINDING_MISMATCH');
 const next=JSON.parse(JSON.stringify(j)) as AgentJournalV2;if(epoch!==next.epoch)next.outbox=[];next.coordinatorId=id;next.epoch=epoch;return next;
}
export function agentMessageV2(j:AgentJournalV2,group:string,holder:string,type:string,payload:Object,factory:AgentMessageFactoryV2,ackOf:string|null=null):MessageEnvelopeV2 {
 if(j.coordinatorId===null||!Number.isSafeInteger(++j.sequence))throw Error('CHANNEL_NOT_BOUND');
 const m:MessageEnvelopeV2={protocolVersion:2,messageId:factory.id(),type,groupId:group,senderInstanceId:holder,coordinatorEpoch:j.epoch,seq:j.sequence,ackOf,traceId:factory.id(),payload:JSON.stringify(payload),extensions:[]};
 if(!validMessageEnvelopeV2(m,[]))throw Error('CHANNEL_MESSAGE_INVALID');return m;
}
export function receiveAgentMessageV2(j:AgentJournalV2,m:MessageEnvelopeV2,group:string,factory:AgentMessageFactoryV2):boolean {
 if(!validMessageEnvelopeV2(m,[])||m.groupId!==group||m.senderInstanceId!==j.coordinatorId||m.coordinatorEpoch!==j.epoch||m.ackOf!==null)throw Error('SERVER_MESSAGE_INVALID');
 const digest=factory.digest(canonical(m)),old=j.inbox.find(e=>e.id===m.messageId);
 if(old){if(old.digest!==digest)throw Error('MESSAGE_CONFLICT');return false;}
 j.inbox.push({id:m.messageId,digest});j.receivedSequence=Math.max(j.receivedSequence,m.seq);return true;
}
export function validateAgentOfferV2(m:MessageEnvelopeV2,device:string):DispatchOfferV2 {
 const offer=JSON.parse(m.payload) as DispatchOfferV2;
 if(m.type!=='DispatchOffer'||!validDispatchOfferV2(offer)||offer.task.groupId!==m.groupId||offer.task.coordinatorEpoch!==m.coordinatorEpoch||offer.target.deviceId!==device)throw Error('DISPATCH_UNAUTHORIZED');return offer;
}
export function statusPayloadV2(m:MessageEnvelopeV2,group:string,holder:string,records:AttemptRecordV2[]):AttemptStatusReplyV2 {
 const q=JSON.parse(m.payload) as AttemptStatusQueryV2;
 if(m.type!=='AttemptStatusQuery'||!validAttemptStatusQueryV2(q)||q.groupId!==group||q.holderInstanceId!==holder||q.coordinatorEpoch!==m.coordinatorEpoch)throw Error('STATUS_QUERY_UNAUTHORIZED');
 return {attemptId:q.attemptId,record:records.find(e=>e.attemptId===q.attemptId)??null};
}

import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:net';
import { createHash, createHmac, verify, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { canonical, LedgerStateV2, LedgerAdmissionV2, DispatchOfferV2, AllotmentGrantV2, ExecutionReceiptV2,
  newLedgerV2, recoverLedgerV2, requestGrantV2, installGrantV2, admitV2, startAttemptV2, cancelAttemptV2, settleAttemptV2,
  occupiedV2, validAttemptRecordV2, validDispatchOfferV2, validAllotmentGrantV2, validResourceVectorV2, MessageEnvelopeV2, validTraceSpanV2, TraceSpanV2 } from '@harmony/scheduler-core';
import { ChannelJournal, newChannelJournal, validateJournal, bindJournal, journalMessage, answerQuery, receiveDispatch } from './channel-journal';
import { DeviceProfileV2, validDeviceProfileV2 } from '@harmony/scheduler-core';

type Identity=Pick<LedgerStateV2,'groupId'|'deviceId'|'holderInstanceId'|'appInstanceId'>;
const clone=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
export function grantSigningText(grant:AllotmentGrantV2):string {const {signature,...unsigned}=grant;return canonical(unsigned);}
export function verifyGrant(grant:AllotmentGrantV2,certificate:string):boolean {
  try{return validAllotmentGrantV2(grant)&&verify('sha256',Buffer.from(grantSigningText(grant)),certificate,Buffer.from(grant.signature,'base64'));}catch{return false;}
}
export function taskDigest(offer:DispatchOfferV2):string {
  const task=offer.task;
  return hash({inputs:task.inputs,contract:task.contract,parameters:task.parameters,allowedTargetIds:task.allowedTargetIds,allowedConfigurations:task.allowedConfigurations});
}
/** A corrupt snapshot cannot be replaced with an empty ledger. Operator reconciliation is required. */
function validateState(s:LedgerStateV2,identity:Identity):void {
  if(!s||s.version!==1||Object.keys(identity).some(k=>s[k as keyof Identity]!==identity[k as keyof Identity])||
    ![s.ledgerEpoch,s.counter,s.settlementSeq].every(n=>Number.isSafeInteger(n)&&n>=0)||s.ledgerEpoch<1||!Array.isArray(s.entries)||
    s.grant!==null&&!validAllotmentGrantV2(s.grant)||s.entries.some(e=>!validAttemptRecordV2(e.record)||!validDispatchOfferV2(e.offer)||!validResourceVectorV2(e.resources)||
      e.record.groupId!==s.groupId||e.record.holderInstanceId!==s.holderInstanceId||e.record.fence.deviceId!==s.deviceId||e.record.attemptId!==e.offer.task.attemptId||e.record.executionDigest!==taskDigest(e.offer)||canonical(e.resources)!==canonical(e.offer.resources))||
    new Set(s.entries.map(e=>e.record.attemptId)).size!==s.entries.length)throw Error('LEDGER_CORRUPT');
  occupiedV2(s);
}
/** All quota, fence, attempt and settlement changes commit through this single snapshot. */
export class DurableLedger {
  private poisoned=false;private closed=false;
  private constructor(private readonly directory:string,private state:LedgerStateV2,private readonly certificate:string,
    private readonly unlock:()=>Promise<void>,private readonly clock:()=>number,private channel:ChannelJournal){}
  static async open(directory:string,identity:Identity,certificate:string,clock:()=>number=()=>performance.now()):Promise<DurableLedger>{
    fs.mkdirSync(directory,{recursive:true});const real=fs.realpathSync(directory),normalized=process.platform==='win32'?real.toLowerCase():real;
    const port=30000+createHash('sha256').update(normalized).digest().readUInt32BE(0)%30000;
    const server=createServer(socket=>socket.destroy());
    const endpoint=process.platform==='win32'?{path:'\\\\.\\pipe\\harmony-ledger-'+createHash('sha256').update(normalized).digest('hex'),exclusive:true}:{host:'127.0.0.1',port,exclusive:true};
    await new Promise<void>((resolve,reject)=>{server.once('error',()=>reject(Error('LEDGER_SINGLE_WRITER')));server.listen(endpoint,resolve);});
    const unlock=()=>new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
    try{
      const filename=path.join(real,'ledger.json'),marker=path.join(real,'ledger.initialized');let state=newLedgerV2(identity),channel=newChannelJournal();
      if(fs.existsSync(filename)){
        const envelope=JSON.parse(fs.readFileSync(filename,'utf8'));
        if(envelope.sha256!==hash(envelope.format===2?{format:2,state:envelope.state,channel:envelope.channel}:envelope.state))throw Error('LEDGER_CHECKSUM');
        if(envelope.format!==undefined&&envelope.format!==2)throw Error('LEDGER_FORMAT');
        if(envelope.format===2){channel=envelope.channel;validateJournal(channel,identity.groupId,identity.holderInstanceId);}
        validateState(envelope.state,identity);state=recoverLedgerV2(envelope.state);
        if(state.grant&&!verifyGrant(state.grant,certificate))throw Error('LEDGER_GRANT_SIGNATURE');
      }else if(fs.existsSync(marker)||fs.readdirSync(real).some(name=>name.startsWith('ledger-')&&name.endsWith('.tmp')))throw Error('LEDGER_INITIAL_COMMIT_UNCERTAIN');
      if(!fs.existsSync(marker)){const fd=fs.openSync(marker,'wx',0o600);try{fs.writeFileSync(fd,hash(identity));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
      const ledger=new DurableLedger(real,state,certificate,unlock,clock,channel);ledger.commit(state);return ledger;
    }catch(error){await unlock();throw error;}
  }
  private guard(){if(this.closed||this.poisoned)throw Error('LEDGER_UNAVAILABLE');}
  private commit(next:LedgerStateV2,channel:ChannelJournal=this.channel){
    this.guard();const temporary=path.join(this.directory,'ledger-'+randomUUID()+'.tmp');
    validateJournal(channel,next.groupId,next.holderInstanceId);
    let phase='OPEN';
    try{
      const fd=fs.openSync(temporary,'wx',0o600);
      const body={format:2,state:next,channel};
      try{phase='WRITE';fs.writeFileSync(fd,JSON.stringify({...body,sha256:hash(body)}));phase='SYNC';fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      phase='RENAME';
      for(let retry=0;;retry++){
        try{fs.renameSync(temporary,path.join(this.directory,'ledger.json'));break;}
        catch(error){
          const code=(error as NodeJS.ErrnoException).code;
          if(process.platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(code??'')||retry>=5)throw error;
          // Retry only replacement of the same fully synced snapshot; never unlink the old ledger.
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10*(retry+1));
        }
      }
      phase='DIRECTORY_SYNC';
      if(process.platform!=='win32'){const directoryFd=fs.openSync(this.directory,'r');try{fs.fsyncSync(directoryFd);}finally{fs.closeSync(directoryFd);}}
      this.state=clone(next);this.channel=clone(channel);
    }catch(error){
      this.poisoned=true;
      const code=(error as NodeJS.ErrnoException)?.code;
      // Keep diagnostic stage and OS error, without exposing paths or persisted content.
      throw Error('LEDGER_COMMIT_'+phase+':'+(typeof code==='string'&&/^[A-Z_]+$/.test(code)?code:'UNKNOWN'));
    }
  }
  snapshot():LedgerStateV2{this.guard();return clone(this.state);}
  requestGrant(id:string){this.commit(requestGrantV2(this.state,id,this.clock()));return {leaseRequestId:id,ledgerEpoch:this.state.ledgerEpoch};}
  installGrant(grant:AllotmentGrantV2){this.commit(installGrantV2(this.state,grant,verifyGrant(grant,this.certificate),this.clock()));}
  admit(offer:DispatchOfferV2,context:Omit<LedgerAdmissionV2,'now'|'executionDigest'|'leaseId'>,message?:MessageEnvelopeV2){
    if(this.channel.dispatches?.some(d=>d.attemptId===offer.task.attemptId&&d.rejected))throw Error('DISPATCH_PREVIOUSLY_REJECTED');
    this.guard();const result=admitV2(this.state,offer,{...context,now:this.clock(),executionDigest:taskDigest(offer),leaseId:randomUUID()});
    if(message){
      if(canonical(JSON.parse(message.payload))!==canonical(offer))throw Error('DISPATCH_OFFER_CONFLICT');
      const channel=receiveDispatch(this.channel,message,this.state.groupId,this.state.deviceId);
      const record={...result.entry.record,state:'ACCEPTED',resourcesSettled:false,receipt:null};
      if(!channel.outbox.some(m=>m.type==='AdmissionReply'&&m.ackOf===message.messageId))channel.outbox.push(journalMessage(channel,this.state.groupId,this.state.holderInstanceId,'AdmissionReply',
        {attemptId:record.attemptId,holderInstanceId:record.holderInstanceId,status:'ACCEPTED',reasonCode:null,record,wait:{value:null,source:'UNKNOWN',sampledAt:0,ttlMs:1,unit:'ms'}},message.messageId));
      if(!channel.outbox.some(m=>m.type==='Ack'&&m.ackOf===message.messageId))channel.outbox.push(journalMessage(channel,this.state.groupId,this.state.holderInstanceId,'Ack',{messageId:message.messageId},message.messageId));
      if(result.entry.record.receipt)this.addReport(channel,result.state,result.entry.record.receipt);
      this.commit(result.state,channel);
    }else if(!result.existing)this.commit(result.state);return result.entry;
  }
  rejectDispatch(message:MessageEnvelopeV2,reasonCode:string){
    const offer=JSON.parse(message.payload);if(this.status(offer.task.attemptId))throw Error('DISPATCH_ALREADY_ADMITTED');
    const channel=receiveDispatch(this.channel,message,this.state.groupId,this.state.deviceId);
    channel.dispatches!.find(d=>d.messageId===message.messageId)!.rejected=true;
    if(!channel.outbox.some(m=>m.type==='AdmissionReply'&&m.ackOf===message.messageId))channel.outbox.push(journalMessage(channel,this.state.groupId,this.state.holderInstanceId,'AdmissionReply',
      {attemptId:offer.task.attemptId,holderInstanceId:this.state.holderInstanceId,status:'REJECTED',reasonCode,record:null,wait:{value:null,source:'UNKNOWN',sampledAt:0,ttlMs:1,unit:'ms'}},message.messageId));
    if(!channel.outbox.some(m=>m.type==='Ack'&&m.ackOf===message.messageId))channel.outbox.push(journalMessage(channel,this.state.groupId,this.state.holderInstanceId,'Ack',{messageId:message.messageId},message.messageId));
    this.commit(this.state,channel);
  }
  private addReport(channel:ChannelJournal,state:LedgerStateV2,receipt:ExecutionReceiptV2){
    if(channel.outbox.some(m=>m.type==='ExecutionReceipt'&&JSON.parse(m.payload).receipt.attemptId===receipt.attemptId))return;
    const record=state.entries.find(e=>e.record.attemptId===receipt.attemptId)!.record;
    channel.outbox.push(journalMessage(channel,state.groupId,state.holderInstanceId,'ExecutionReceipt',{receipt,allotmentId:record.allotmentId,allotmentVersion:record.allotmentVersion,leaseId:record.leaseId,actualModel:null,timings:[]}));
  }
  queueTrace(spans:TraceSpanV2[]){
    if(this.channel.outbox.length>=32)throw Error('TRACE_BACKPRESSURE');
    if(spans.length<1||spans.length>128||!spans.every(validTraceSpanV2))throw Error('TRACE_INVALID');
    const channel=clone(this.channel);channel.outbox.push(journalMessage(channel,this.state.groupId,this.state.holderInstanceId,'TraceBatch',{spans}));this.commit(this.state,channel);
  }
  /** Must return successfully BEFORE the adapter calls its engine; a crash in between never retries. */
  begin(attemptId:string){this.commit(startAttemptV2(this.state,attemptId,this.clock()));return clone(this.state.entries.find(e=>e.record.attemptId===attemptId)!);}
  cancel(attemptId:string){this.commit(cancelAttemptV2(this.state,attemptId));}
  expire(){for(const e of this.state.entries)if(!e.record.resourcesSettled&&this.clock()>=e.deadline&&!e.cancelRequested)this.cancel(e.record.attemptId);}
  /** Only a locally confirmed engine settlement may invoke this method, never a network timeout. */
  settle(receipt:ExecutionReceiptV2,delivery:'BUSINESS'|'EVALUATION'='BUSINESS'){
    const next=settleAttemptV2(this.state,receipt),channel=clone(this.channel);
    // Reference evaluation results use the durable permit-report protocol. A
    // successful reference is not a missing business dispatch to reconcile.
    if(delivery==='BUSINESS'&&next.settlementSeq!==this.state.settlementSeq&&channel.coordinatorId!==null){
      if(receipt.coordinatorEpoch===channel.epoch&&channel.dispatches?.some(d=>d.attemptId===receipt.attemptId))this.addReport(channel,next,receipt);
      else if(!channel.outbox.some(m=>m.type==='RecoveryRequest'))channel.outbox.push(journalMessage(channel,next.groupId,next.holderInstanceId,'RecoveryRequest',{}));
    }
    this.commit(next,channel);
  }
  status(attemptId:string){this.guard();return clone(this.state.entries.find(e=>e.record.attemptId===attemptId)?.record??null);}
  receipts(){this.guard();return clone(this.state.entries.flatMap(e=>e.record.receipt?[e.record.receipt]:[]));}
  bindChannel(coordinatorId:string,epoch:number){this.commit(this.state,bindJournal(this.channel,coordinatorId,epoch));}
  channelHello(){
    const next=clone(this.channel),message=journalMessage(next,this.state.groupId,this.state.holderInstanceId,'Hello',{versions:[2],extensions:[]});
    this.commit(this.state,next);return message;
  }
  requestRecovery(force=false){
    this.guard();
    if(!force&&this.channel.outbox.some(m=>m.type==='RecoveryRequest'))return;
    const next=clone(this.channel);next.outbox.push(journalMessage(next,this.state.groupId,this.state.holderInstanceId,'RecoveryRequest',{}));this.commit(this.state,next);
  }
  answerStatus(message:MessageEnvelopeV2){
    this.guard();const payload=JSON.parse(message.payload);
    const record=this.status(payload.attemptId);
    this.commit(this.state,answerQuery(this.channel,message,this.state.groupId,this.state.holderInstanceId,record));
  }
  pendingMessages(){this.guard();return clone(this.channel.outbox);}
  queueProfile(input:Omit<DeviceProfileV2,'sequence'>){
    this.guard();
    if(this.channel.outbox.some(m=>m.type==='DeviceProfile'))throw Error('PROFILE_PENDING');
    const next=clone(this.channel),profile={...clone(input),sequence:next.sequence+1};
    if(!validDeviceProfileV2(profile)||profile.deviceId!==this.state.deviceId||profile.holderInstanceId!==this.state.holderInstanceId||profile.ledgerEpoch!==this.state.ledgerEpoch)throw Error('PROFILE_IDENTITY_INVALID');
    const message=journalMessage(next,this.state.groupId,this.state.holderInstanceId,'DeviceProfile',profile);
    next.outbox.push(message);this.commit(this.state,next);return message;
  }
  acknowledgeMessage(id:string){
    const next=clone(this.channel);next.outbox=next.outbox.filter(m=>m.messageId!==id);this.commit(this.state,next);
  }
  sentMessage(id:string){if(this.channel.outbox.some(m=>m.messageId===id&&m.type==='Ack'))this.acknowledgeMessage(id);}
  acknowledgement(token:string){
    this.guard();const g=this.state.grant;if(!g)throw Error('ALLOTMENT_UNKNOWN');
    const ack={allotmentId:g.allotmentId,holderInstanceId:this.state.holderInstanceId,ledgerEpoch:g.ledgerEpoch,coordinatorEpoch:g.coordinatorEpoch,version:g.version,persisted:true,settlementSeq:this.state.settlementSeq,occupied:occupiedV2(this.state)};
    const tokenHash=createHash('sha256').update(token).digest();
    return {ack,signature:createHmac('sha256',tokenHash).update(canonical(ack)).digest('base64')};
  }
  async close(){if(!this.closed){this.closed=true;await this.unlock();}}
}

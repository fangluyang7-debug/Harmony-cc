import { Server } from 'node:https';
import { createHash, randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { PrismaClient } from '../generated/client';
import { canonical, MessageEnvelopeV2, validMessageEnvelopeV2, validVersionHelloV2, negotiateVersionV2,
  validAdmissionReplyV2, validExecutionReportV2, validAttemptStatusReplyV2, protocolId,validYieldNoticeV2,validProtocolErrorV2, AppIdentityV2 } from '@harmony/scheduler-core';
import { CoordinatorStore } from './store';

export interface Peer { groupId:string; holderInstanceId:string; deviceId:string; principalId:string; credentialId:string; app?:AppIdentityV2; }
export interface ChannelHandler { validate:(payload:any)=>boolean; handle:(peer:Peer,payload:any,message:MessageEnvelopeV2)=>Promise<void>; }
interface Session { socket:WebSocket; token:string; peer:Peer; hello:boolean; work:Promise<void>; queued:number; inFlight:Set<string>; }
const exact=(v:any,keys:string[])=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');

/** Bounded, event-driven control transport. Handlers must be durable and idempotent. */
export class ControlChannel {
  private readonly wss=new WebSocketServer({noServer:true,maxPayload:262144,perMessageDeflate:false});
  private readonly sessions=new Set<Session>();
  private readonly handlers=new Map<string,ChannelHandler>();
  private readonly upgrade:(request:any,socket:any,head:Buffer)=>void;
  constructor(private readonly server:Server,private readonly db:PrismaClient,private readonly store:CoordinatorStore,
    private readonly ready:()=>boolean,private readonly epoch:()=>number,private readonly authenticate:(token:string)=>Promise<Peer>,
    readonly limits={queuedMessages:64,bufferedBytes:1048576,inFlight:64},private readonly changed:(groupId:string)=>void=()=>{}){
    this.register('Hello',{validate:p=>validVersionHelloV2(p)&&negotiateVersionV2({versions:[2],extensions:[]},p)===2,handle:async()=>{}});
    this.register('RecoveryRequest',{validate:p=>exact(p,[]),handle:async peer=>store.requestStatus(peer.groupId,peer.holderInstanceId,epoch())});
    this.register('ProtocolError',{validate:validProtocolErrorV2,handle:async(peer,p)=>{
      const rows=await db.outbox.findMany({where:{groupId:peer.groupId,kind:'DispatchOffer'}}),row=rows.find(r=>JSON.parse(r.messageJson).messageId===p.messageId);
      const attempt=row?await db.attempt.findUnique({where:{id:row.attemptId}}):null;
      if(!attempt||attempt.holderInstanceId!==peer.holderInstanceId)throw Error('ERROR_SCOPE');
      console.warn('AGENT_PROTOCOL_ERROR '+p.code);
    }});
    this.register('YieldNotice',{validate:validYieldNoticeV2,handle:async(peer,p)=>{
      const row=await db.attempt.findUnique({where:{id:p.attemptId}}),offer=row?.offerJson?JSON.parse(row.offerJson):null;
      if(!row||row.groupId!==peer.groupId||row.holderInstanceId!==peer.holderInstanceId||offer?.target.deviceId!==peer.deviceId||!row.recordJson)throw Error('YIELD_SCOPE');
      await db.attempt.update({where:{id:row.id},data:{yieldJson:JSON.stringify({notice:p,receivedAt:Date.now()})}});this.changed(peer.groupId);
    }});
    this.register('AttemptStatusReply',{validate:validAttemptStatusReplyV2,handle:async(peer,p,message)=>{
      if(message.ackOf===null)throw Error('STATUS_QUERY_REQUIRED');
      await store.reconcileStatus(peer.groupId,peer.holderInstanceId,peer.deviceId,message.ackOf,p,epoch());
    }});
    this.register('Ack',{validate:p=>exact(p,['messageId'])&&protocolId(p.messageId),handle:async(peer,p)=>{
      const rows=await db.outbox.findMany({where:{groupId:peer.groupId}});
      const row=rows.find(r=>(JSON.parse(r.messageJson) as MessageEnvelopeV2).messageId===p.messageId);
      const attempt=row?await db.attempt.findUnique({where:{id:row.attemptId}}):null;
      if(!attempt||attempt.holderInstanceId!==peer.holderInstanceId)throw Error('ACK_UNAUTHORIZED');
      await store.acknowledge(peer.groupId,p.messageId);
    }});
    this.register('AdmissionReply',{validate:validAdmissionReplyV2,handle:async(peer,p,message)=>{
      if(p.holderInstanceId!==peer.holderInstanceId)throw Error('ADMISSION_UNAUTHORIZED');
      if(p.status==='REJECTED'){
        await db.$transaction(async tx=>{
          const row=await tx.attempt.findUnique({where:{id:p.attemptId}});
          if(!row||row.groupId!==peer.groupId||row.holderInstanceId!==peer.holderInstanceId)throw Error('ADMISSION_UNAUTHORIZED');
          if(row.recordJson!==null)throw Error('ADMISSION_CONFLICT');
          if(row.rejectionJson){if(canonical(JSON.parse(row.rejectionJson).reply)!==canonical(p))throw Error('ADMISSION_CONFLICT');return;}
          await tx.attempt.update({where:{id:row.id},data:{state:'REJECTED',rejectionJson:JSON.stringify({reply:p,receivedAt:Date.now(),messageId:message.messageId,traceId:message.traceId})}});
          await tx.node.update({where:{id:row.nodeId},data:{state:'REJECTED'}});
        });return;
      }
      const record=p.record;
      if(record.groupId!==peer.groupId||record.fence.deviceId!==peer.deviceId)throw Error('ADMISSION_UNAUTHORIZED');
      await store.recordAdmission(record);
    }});
    this.register('ExecutionReceipt',{validate:validExecutionReportV2,handle:async(peer,p)=>{
      const receipt=p.receipt;
      if(receipt.fence.holderInstanceId!==peer.holderInstanceId||receipt.fence.deviceId!==peer.deviceId)throw Error('RECEIPT_UNAUTHORIZED');
      const row=await db.attempt.findUnique({where:{id:receipt.attemptId}}),record=row?.recordJson?JSON.parse(row.recordJson):null;
      if(!record||record.allotmentId!==p.allotmentId||record.allotmentVersion!==p.allotmentVersion||record.leaseId!==p.leaseId)throw Error('RECEIPT_LEASE_MISMATCH');
      await store.receive(peer.groupId,peer.holderInstanceId,receipt,epoch());
    }});
    this.upgrade=(request,socket,head)=>{
      void (async()=>{
        if(request.url!=='/v2/channel'||!ready())throw Error('UNAVAILABLE');
        const auth=request.headers.authorization;
        if(typeof auth!=='string'||!auth.startsWith('Bearer '))throw Error('UNAUTHORIZED');
        const token=auth.slice(7),peer=await authenticate(token);
        this.wss.handleUpgrade(request,socket,head,ws=>this.connected(ws,peer,token));
      })().catch(()=>{socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');socket.destroy();});
    };
    server.on('upgrade',this.upgrade);
  }
  register(type:string,handler:ChannelHandler){if(this.handlers.has(type))throw Error('HANDLER_EXISTS');this.handlers.set(type,handler);}
  private connected(socket:WebSocket,peer:Peer,token:string){
    for(const old of this.sessions)if(old.peer.groupId===peer.groupId&&old.peer.holderInstanceId===peer.holderInstanceId)old.socket.close(1008,'REPLACED');
    const session:Session={socket,peer,token,hello:false,work:Promise.resolve(),queued:0,inFlight:new Set()};this.sessions.add(session);
    const timer=setTimeout(()=>{if(!session.hello)socket.close(1008,'HELLO_TIMEOUT');},10000);timer.unref();
    socket.on('close',()=>{clearTimeout(timer);this.sessions.delete(session);});socket.on('error',()=>{});
    socket.on('message',(bytes,binary)=>{
      if(binary){socket.close(1008,'TEXT_REQUIRED');return;}
      if(session.queued>=this.limits.queuedMessages){socket.close(1013,'BACKPRESSURE');return;}
      session.queued++;
      session.work=session.work.then(()=>this.receive(session,bytes.toString())).catch(error=>{
        const code=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'CONTROL_INTERNAL_ERROR';
        console.warn('CONTROL_MESSAGE_REJECTED '+code);socket.close(1008,code);
      }).finally(()=>{session.queued--;});
    });
  }
  private async receive(s:Session,text:string){
    if(s.socket.readyState!==WebSocket.OPEN)return;
    const current=await this.authenticate(s.token);
    if(current.credentialId!==s.peer.credentialId)throw Error('CREDENTIAL_CHANGED');
    const m=JSON.parse(text) as MessageEnvelopeV2;
    if(!validMessageEnvelopeV2(m,[])||m.groupId!==s.peer.groupId||m.senderInstanceId!==s.peer.holderInstanceId)throw Error('ENVELOPE_INVALID');
    if(m.coordinatorEpoch!==this.epoch()&&m.type!=='ExecutionReceipt')throw Error('STALE_EPOCH');
    if(!s.hello&&m.type!=='Hello')throw Error('HELLO_REQUIRED');
    const handler=this.handlers.get(m.type),payload=JSON.parse(m.payload);
    if(!handler||!handler.validate(payload)||m.type==='Ack'&&m.ackOf!==payload.messageId||m.type==='ExecutionReceipt'&&m.coordinatorEpoch!==payload.receipt.coordinatorEpoch)throw Error('PAYLOAD_INVALID');
    const id=JSON.stringify([m.groupId,m.senderInstanceId,m.messageId]),scope=JSON.stringify([m.groupId,m.senderInstanceId]);
    const digest=createHash('sha256').update(canonical(m)).digest('hex');
    const duplicate=await this.db.$transaction(async tx=>{
      const existing=await tx.channelInbox.findUnique({where:{id}});
      if(existing){if(existing.digest!==digest)throw Error('MESSAGE_CONFLICT');return existing.done;}
      const cursor=await tx.channelCursor.findUnique({where:{id:scope}});
      // Hello is connection negotiation, not a durable business-stream watermark. A reconnect may precede older unsent outbox entries.
      if(m.type!=='Hello'&&cursor&&m.seq<=cursor.sequence)throw Error('SEQUENCE_REORDERED');
      await tx.channelInbox.create({data:{id,digest,done:false}});
      if(m.type!=='Hello')await tx.channelCursor.upsert({where:{id:scope},create:{id:scope,sequence:m.seq},update:{sequence:m.seq}});
      return false;
    });
    if(!duplicate){await handler.handle(s.peer,payload,m);await this.db.channelInbox.update({where:{id},data:{done:true}});if(!['Hello','Ack','TraceBatch'].includes(m.type))this.changed(s.peer.groupId);}
    if(m.type==='Hello')s.hello=true;
    if(m.type==='Ack')s.inFlight.delete(payload.messageId);
    await this.pump(s);
    if(m.type==='Ack')return; // No ACK-of-ACK loop.
    const seq=await this.db.dispatchSequence.upsert({where:{id:this.store.senderInstanceId},create:{id:this.store.senderInstanceId,value:1},update:{value:{increment:1}}});
    await this.send(s,{protocolVersion:2,messageId:randomUUID(),type:'Ack',groupId:s.peer.groupId,senderInstanceId:this.store.senderInstanceId,
      coordinatorEpoch:this.epoch(),seq:seq.value,ackOf:m.messageId,traceId:m.traceId,payload:JSON.stringify({messageId:m.messageId}),extensions:[]});
  }
  private async send(s:Session,message:MessageEnvelopeV2){
    await this.authenticate(s.token);
    const text=JSON.stringify(message);
    if(s.socket.bufferedAmount+Buffer.byteLength(text)>this.limits.bufferedBytes){s.socket.close(1013,'BACKPRESSURE');throw Error('BACKPRESSURE');}
    await new Promise<void>((resolve,reject)=>s.socket.send(text,error=>error?reject(error):resolve()));
  }
  private async pump(s:Session){
    if(!s.hello||s.socket.readyState!==WebSocket.OPEN)return;
    const attempts=await this.db.attempt.findMany({where:{groupId:s.peer.groupId,holderInstanceId:s.peer.holderInstanceId},select:{id:true}});
    const rows=await this.db.outbox.findMany({where:{groupId:s.peer.groupId,attemptId:{in:attempts.map(a=>a.id)},acked:false,superseded:false},orderBy:{sequence:'asc'},take:this.limits.inFlight});
    for(const row of rows){
      const message=JSON.parse(row.messageJson) as MessageEnvelopeV2;
      if(s.inFlight.has(message.messageId))continue;
      if(message.coordinatorEpoch!==this.epoch())continue;
      await this.send(s,message);s.inFlight.add(message.messageId);
      await this.db.outbox.update({where:{id:row.id},data:{deliveryCount:{increment:1}}});
    }
  }
  async flush(){await Promise.all([...this.sessions].map(s=>s.work=s.work.then(()=>this.pump(s)).catch(()=>{s.socket.close(1008,'DELIVERY_REJECTED');})));}
  /** A wake-up hint, not an execution command. Durable evaluation records are reconciled on reconnect. */
  async evaluationChanged(groupId:string,holderInstanceId:string){
    const seq=await this.db.dispatchSequence.upsert({where:{id:this.store.senderInstanceId},create:{id:this.store.senderInstanceId,value:1},update:{value:{increment:1}}});
    await Promise.all([...this.sessions].filter(s=>s.hello&&s.peer.groupId===groupId&&s.peer.holderInstanceId===holderInstanceId).map(async s=>{
      try{await this.send(s,{protocolVersion:2,messageId:randomUUID(),type:'EvaluationChanged',groupId,senderInstanceId:this.store.senderInstanceId,
        coordinatorEpoch:this.epoch(),seq:seq.value,ackOf:null,traceId:randomUUID(),payload:'{}',extensions:[]});}
      catch{s.socket.terminate();}
    }));
  }
  revoke(credentialId:string){for(const s of this.sessions)if(s.peer.credentialId===credentialId)s.socket.close(1008,'CREDENTIAL_REVOKED');}
  async close(){this.server.off('upgrade',this.upgrade);for(const s of this.sessions)s.socket.terminate();await Promise.allSettled([...this.sessions].map(s=>s.work));await new Promise<void>(r=>this.wss.close(()=>r()));}
}

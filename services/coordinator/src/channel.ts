import {ControlHeartbeat} from './control-heartbeat';
import {settleBatchCharge} from './batch-ready';
import { Server } from 'node:https';
import { createHash, randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { Prisma,PrismaClient } from '../generated/client';
import { canonical, MessageEnvelopeV2, validMessageEnvelopeV2, validVersionHelloV2, negotiateVersionV2,
  validAdmissionReplyV2, validExecutionReportV2, validAttemptStatusReplyV2, protocolId,validYieldNoticeV2,validProtocolErrorV2, AppIdentityV2 } from '@harmony/scheduler-core';
import { CoordinatorStore } from './store';
import { outboxByWireId } from './outbox-lookup';

export interface Peer { groupId:string; holderInstanceId:string; deviceId:string; principalId:string; credentialId:string; app?:AppIdentityV2; }
export interface ChannelHandler { validate:(payload:any)=>boolean; handle:(peer:Peer,payload:any,message:MessageEnvelopeV2)=>Promise<void>; }
interface Session { heartbeat:ControlHeartbeat; recovered:boolean; outstandingQueries:Set<string>;busy:Set<string>;profileInstance?:string;profileEpoch?:number;lastProfileStamp?:number; socket:WebSocket; token:string; peer:Peer; hello:boolean; work:Promise<void>; queued:number; inFlight:Set<string>; }
const exact=(v:any,keys:string[])=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');

/** Bounded, event-driven control transport. Handlers must be durable and idempotent. */
export class ControlChannel {
  onUnstarted?:(tx:Prisma.TransactionClient,id:string)=>Promise<void>;
  onUnavailable?:(peer:Peer)=>void;
  private readonly wss=new WebSocketServer({noServer:true,maxPayload:262144,perMessageDeflate:false});
  private readonly sessions=new Set<Session>();
  // A disconnected session can still be committing a handler. Drain it before closing the database.
  private readonly pending=new Set<Promise<void>>();
  private closing=false;
  private flushing:Promise<void>|undefined;
  private readonly handlers=new Map<string,ChannelHandler>();
  private readonly upgrade:(request:any,socket:any,head:Buffer)=>void;
  onSettlement?:(peer:Peer)=>void;
  constructor(private readonly server:Server,private readonly db:PrismaClient,private readonly store:CoordinatorStore,
    private readonly ready:()=>boolean,private readonly epoch:()=>number,private readonly authenticate:(token:string)=>Promise<Peer>,
    readonly limits={queuedMessages:64,bufferedBytes:1048576,inFlight:64},private readonly changed:(groupId:string)=>void=()=>{},private readonly onError:(error:unknown)=>void=()=>{}){
    this.register('Hello',{validate:p=>validVersionHelloV2(p)&&negotiateVersionV2({versions:[2],extensions:[]},p)===2,handle:async()=>{}});
    this.register('RecoveryRequest',{validate:p=>exact(p,[]),handle:async peer=>store.requestStatus(peer.groupId,peer.holderInstanceId,epoch())});
    this.register('ProtocolError',{validate:validProtocolErrorV2,handle:async(peer,p)=>{
      const row=await outboxByWireId(db,peer.groupId,p.messageId,'DispatchOffer');
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
      const row=await outboxByWireId(db,peer.groupId,p.messageId);
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
          if(p.reasonCode==='QUEUE_STARVED_NOT_STARTED'){
            const offer=message.ackOf&&await tx.outbox.findUnique({where:{id:message.ackOf}});
            if(!offer||offer.kind!=='DispatchOffer'||offer.attemptId!==row.id||offer.epoch!==message.coordinatorEpoch)throw Error('ADMISSION_CONFLICT');
          }
          if(row.rejectionJson){if(canonical(JSON.parse(row.rejectionJson).reply)!==canonical(p))throw Error('ADMISSION_CONFLICT');return;}
          await tx.attempt.update({where:{id:row.id},data:{state:'REJECTED',rejectionJson:JSON.stringify({reply:p,receivedAt:Date.now(),messageId:message.messageId,traceId:message.traceId})}});
          await store.recordNodeFailure(tx,row.nodeId,row.id,'REJECTED');
          if(p.reasonCode==='QUEUE_STARVED_NOT_STARTED')await this.onUnstarted?.(tx,row.id);
          await settleBatchCharge(tx,row.id,0);
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
      await store.receive(peer.groupId,peer.holderInstanceId,receipt,epoch(),p.resourceHeldMs,p.overheadMs,p.startup);
      this.onSettlement?.(peer);
    }});
    this.upgrade=(request,socket,head)=>{
      void this.track((async()=>{
        if(this.closing||request.url!=='/v2/channel'||!ready())throw Error('UNAVAILABLE');
        const auth=request.headers.authorization;
        if(typeof auth!=='string'||!auth.startsWith('Bearer '))throw Error('UNAUTHORIZED');
        const token=auth.slice(7),peer=await authenticate(token);
        if(this.closing)throw Error('UNAVAILABLE');
        this.wss.handleUpgrade(request,socket,head,ws=>this.connected(ws,peer,token));
      })().catch(()=>{socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');socket.destroy();}));
    };
    server.on('upgrade',this.upgrade);
  }
  register(type:string,handler:ChannelHandler){if(this.handlers.has(type))throw Error('HANDLER_EXISTS');this.handlers.set(type,handler);}
  linkState(groupId:string,holderId:string,deviceInstance:string,ledgerEpoch:number){
    const s=[...this.sessions].find(s=>s.socket.readyState===WebSocket.OPEN&&s.peer.groupId===groupId&&s.peer.holderInstanceId===holderId);
    if(!s)return 'OFFLINE';
    if(s.heartbeat.suspect)return 'SUSPECT';
    if(!s.recovered||s.outstandingQueries.size||s.profileInstance!==deviceInstance||s.profileEpoch!==ledgerEpoch)return 'RECONCILING';
    return 'ONLINE';
  }
  private connected(socket:WebSocket,peer:Peer,token:string){
    for(const old of this.sessions)if(old.peer.groupId===peer.groupId&&old.peer.holderInstanceId===peer.holderInstanceId)old.socket.close(1008,'REPLACED');
    const session:Session={heartbeat:new ControlHeartbeat(randomUUID()),recovered:false,outstandingQueries:new Set(),busy:new Set(),socket,peer,token,hello:false,work:Promise.resolve(),queued:0,inFlight:new Set()};this.sessions.add(session);
    const timer=setTimeout(()=>{if(!session.hello)socket.close(1008,'HELLO_TIMEOUT');},10000);timer.unref();
    const probeTimer=setInterval(()=>{
      if(!session.hello||socket.readyState!==WebSocket.OPEN)return;
      const before=session.heartbeat.suspect;
      const probe=session.heartbeat.tick(performance.now(),session.busy.size>0||session.outstandingQueries.size>0);
      if(!probe)return;
      if(session.heartbeat.expired){socket.terminate();return;}
      if(before!==session.heartbeat.suspect){this.changed(peer.groupId);if(session.heartbeat.suspect)this.onUnavailable?.(peer);}
      socket.ping(probe);
    },250);probeTimer.unref();
    socket.on('pong',bytes=>{
      const suspect=session.heartbeat.suspect;
      if(session.heartbeat.reply(bytes.toString(),performance.now())&&suspect)socket.close(1012,'RECONCILE');
    });
    socket.on('close',()=>{clearInterval(probeTimer);clearTimeout(timer);this.sessions.delete(session);if(!this.closing){this.changed(peer.groupId);if(![...this.sessions].some(s=>s.peer.holderInstanceId===peer.holderInstanceId&&s.peer.groupId===peer.groupId&&s.socket.readyState===WebSocket.OPEN))this.onUnavailable?.(peer);}});socket.on('error',()=>{});
    socket.on('message',(bytes,binary)=>{
      if(this.closing)return;
      if(binary){socket.close(1008,'TEXT_REQUIRED');return;}
      if(session.queued>=this.limits.queuedMessages){socket.close(1013,'BACKPRESSURE');return;}
      session.queued++;
      session.work=this.track(session.work.then(()=>this.receive(session,bytes.toString())).catch(error=>{
        this.reject(session,error);
      }).finally(()=>{session.queued--;}));
    });
  }
  private track(work:Promise<void>):Promise<void>{
    this.pending.add(work);void work.then(()=>this.pending.delete(work),()=>this.pending.delete(work));return work;
  }
  private reject(s:Session,error:unknown){
    const code=error instanceof Error&&/^[A-Z][A-Z0-9_]{0,99}$/.test(error.message)?error.message:
      error instanceof SyntaxError?'CONTROL_INVALID_JSON':
      error instanceof Error&&error.name.startsWith('PrismaClient')?'CONTROL_STORAGE_ERROR':'CONTROL_INTERNAL_ERROR';
    this.onError(error);
    console.warn((code==='CONTROL_DISCONNECTED'?'CONTROL_TRANSPORT_INTERRUPTED ':'CONTROL_MESSAGE_REJECTED ')+code);
    s.socket.close(code==='CONTROL_DISCONNECTED'?1011:1008,code);
  }
  private async receive(s:Session,text:string){
    if(this.closing||s.socket.readyState!==WebSocket.OPEN)return;
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
    if(!duplicate&&m.type==='RecoveryRequest'){
      const queries=await this.db.outbox.findMany({where:{groupId:s.peer.groupId,kind:'AttemptStatusQuery',epoch:this.epoch(),acked:false,superseded:false}});
      const attempts=await this.db.attempt.findMany({where:{groupId:s.peer.groupId,holderInstanceId:s.peer.holderInstanceId},select:{id:true}});
      const owned=new Set(attempts.map(a=>a.id));
      for(const q of queries)if(owned.has(q.attemptId))s.outstandingQueries.add(JSON.parse(q.messageJson).messageId);
      s.recovered=true;
    }
    if(!duplicate&&m.type==='DeviceProfile'){s.profileInstance=payload.deviceInstanceId;s.profileEpoch=payload.ledgerEpoch;
      const stamp=payload.ownerActivity.sampledAt,age=Date.now()-stamp;
      if(!s.heartbeat.suspect&&age>=0&&age<=payload.ownerActivity.ttlMs&&stamp>(s.lastProfileStamp??-1)){
        s.lastProfileStamp=stamp;s.heartbeat.freshReport(performance.now());
      }
      if(payload.inFlight)s.busy=new Set(payload.inFlight.map((f:{attemptId:string})=>f.attemptId));}
    if(m.type==='AttemptStatusReply'&&m.ackOf)s.outstandingQueries.delete(m.ackOf);
    if(m.type==='AdmissionReply'&&payload.status==='ACCEPTED')s.busy.add(payload.attemptId);
    if(m.type==='ExecutionReceipt'&&payload.receipt.resourcesSettled)s.busy.delete(payload.receipt.attemptId);
    if(m.type==='Hello')s.hello=true;
    if(m.type==='Ack')s.inFlight.delete(payload.messageId);
    await this.pump(s);
    if(m.type==='Ack')return; // No ACK-of-ACK loop.
    const seq=await this.db.dispatchSequence.upsert({where:{id:this.store.senderInstanceId},create:{id:this.store.senderInstanceId,value:1},update:{value:{increment:1}}});
    await this.send(s,{protocolVersion:2,messageId:randomUUID(),type:'Ack',groupId:s.peer.groupId,senderInstanceId:this.store.senderInstanceId,
      coordinatorEpoch:this.epoch(),seq:seq.value,ackOf:m.messageId,traceId:m.traceId,payload:JSON.stringify({messageId:m.messageId}),extensions:[]});
  }
  private async send(s:Session,message:MessageEnvelopeV2){
    if(this.closing||s.socket.readyState!==WebSocket.OPEN)throw Error('CONTROL_DISCONNECTED');
    await this.authenticate(s.token);
    if(this.closing||s.socket.readyState!==WebSocket.OPEN)throw Error('CONTROL_DISCONNECTED');
    const text=JSON.stringify(message);
    if(s.socket.bufferedAmount+Buffer.byteLength(text)>this.limits.bufferedBytes){s.socket.close(1013,'BACKPRESSURE');throw Error('BACKPRESSURE');}
    await new Promise<void>((resolve,reject)=>s.socket.send(text,error=>error?reject(Error('CONTROL_DISCONNECTED')):resolve()));
  }
  private async pump(s:Session){
    if(!s.hello||s.socket.readyState!==WebSocket.OPEN)return;
    const attempts=await this.db.attempt.findMany({where:{groupId:s.peer.groupId,holderInstanceId:s.peer.holderInstanceId},select:{id:true}});
    const rows=await this.db.outbox.findMany({where:{groupId:s.peer.groupId,attemptId:{in:attempts.map(a=>a.id)},acked:false,superseded:false},orderBy:{sequence:'asc'},take:this.limits.inFlight});
    for(const row of rows){
      const message=JSON.parse(row.messageJson) as MessageEnvelopeV2;
      if(s.inFlight.has(message.messageId)||message.type==='DispatchOffer'&&s.heartbeat.suspect)continue;
      if(message.coordinatorEpoch!==this.epoch())continue;
      await this.send(s,message);s.inFlight.add(message.messageId);
      await this.db.outbox.update({where:{id:row.id},data:{deliveryCount:{increment:1}}});
    }
  }
  async flush(){
    if(this.closing)return;if(this.flushing)return this.flushing;
    const pending=Promise.all([...this.sessions].map(s=>s.work=this.track(s.work.then(()=>this.pump(s)).catch(error=>this.reject(s,error))))).then(()=>{});
    this.flushing=pending;
    try{await pending;}finally{if(this.flushing===pending)this.flushing=undefined;}
  }
  /** A wake-up hint, not an execution command. Durable evaluation records are reconciled on reconnect. */
  evaluationChanged(groupId:string,holderInstanceId:string){
    if(this.closing)return Promise.resolve();return this.track(this.notifyEvaluation(groupId,holderInstanceId));
  }
  private async notifyEvaluation(groupId:string,holderInstanceId:string){
    const seq=await this.db.dispatchSequence.upsert({where:{id:this.store.senderInstanceId},create:{id:this.store.senderInstanceId,value:1},update:{value:{increment:1}}});
    await Promise.all([...this.sessions].filter(s=>s.hello&&s.peer.groupId===groupId&&s.peer.holderInstanceId===holderInstanceId).map(async s=>{
      try{await this.send(s,{protocolVersion:2,messageId:randomUUID(),type:'EvaluationChanged',groupId,senderInstanceId:this.store.senderInstanceId,
        coordinatorEpoch:this.epoch(),seq:seq.value,ackOf:null,traceId:randomUUID(),payload:'{}',extensions:[]});}
      catch(error){this.reject(s,error);s.socket.terminate();}
    }));
  }
  revoke(credentialId:string){for(const s of this.sessions)if(s.peer.credentialId===credentialId)s.socket.close(1008,'CREDENTIAL_REVOKED');}
  async close(){this.closing=true;this.server.off('upgrade',this.upgrade);for(const s of this.sessions)s.socket.terminate();await Promise.allSettled([...this.pending]);await new Promise<void>(r=>this.wss.close(()=>r()));}
}

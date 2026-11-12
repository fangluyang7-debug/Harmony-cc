import { util } from '@kit.ArkTS';
import { CoordinatorDatabase, CoordinatorTransaction } from './CoordinatorDatabase';
import { CoordinatorCredentials, CoordinatorPeer } from './CoordinatorCredentials';
import { CoordinatorHttpRequest } from './CoordinatorHttpParser';
import { CoordinatorSocket } from './CoordinatorSocket';
import { ControlHeartbeat } from './CoordinatorHeartbeat';
import { MessageEnvelopeV2, VersionHelloV2, validMessageEnvelopeV2, validVersionHelloV2, negotiateVersionV2 } from '../protocol/SchedulingProtocolV2';
import { DeviceProfileV2, NumericSampleV2, StateSampleV2, validDeviceProfileV2 } from '../protocol/ResourcesV2';
import { canonical } from '../core/CanonicalV2';
import { hash, bytes, monotonic } from '../platform/NativeTransport';

interface ChannelSession {
 socket:CoordinatorSocket;peer:CoordinatorPeer;token:string;hello:boolean;recovered:boolean;
 profileInstance:string;profileEpoch:number;lastProfileStamp:number;busy:boolean;heartbeat:ControlHeartbeat;
 timer:number;helloTimer:number;
}
export interface CoordinatorMessageHandler {
 validate:(payload:Object)=>boolean;
 handle:(tx:CoordinatorTransaction,peer:CoordinatorPeer,payload:Object,message:MessageEnvelopeV2)=>Promise<void>;
}
interface AckPayload {messageId:string;}
/** Same envelope, durable inbox and session rules as the desktop ControlChannel. */
export class CoordinatorChannel {
 private database:CoordinatorDatabase;
 private credentials:CoordinatorCredentials;
 private coordinatorId:string;
 private epoch:number;
 private sessions:Set<ChannelSession>=new Set();
 private handlers:Map<string,CoordinatorMessageHandler>=new Map();
 private closing:boolean=false;
 constructor(database:CoordinatorDatabase,credentials:CoordinatorCredentials,coordinatorId:string,epoch:number){
  this.database=database;this.credentials=credentials;this.coordinatorId=coordinatorId;this.epoch=epoch;
  database.controlState=(group,holder,instance,ledger)=>this.linkState(group,holder,instance,ledger);
 }
 register(type:string,handler:CoordinatorMessageHandler):void{if(this.handlers.has(type))throw Error('HANDLER_EXISTS');this.handlers.set(type,handler);}
 linkState(group:string,holder:string,instance:string,ledger:number):string{
  const session=Array.from(this.sessions).find(s=>s.peer.groupId===group&&s.peer.holderInstanceId===holder&&s.socket.isOpen());
  if(!session)return 'OFFLINE';if(session.heartbeat.suspect)return 'SUSPECT';
  return session.recovered&&session.profileInstance===instance&&session.profileEpoch===ledger?'ONLINE':'RECONCILING';
 }
 async upgrade(request:CoordinatorHttpRequest,socket:CoordinatorSocket):Promise<void>{
  if(this.closing||!request.authorization.startsWith('Bearer '))throw Error('UNAUTHORIZED');
  const token=request.authorization.slice(7),peer=await this.credentials.authenticate(token);
  if(this.closing)throw Error('UNAVAILABLE');
  for(const old of this.sessions)if(old.peer.groupId===peer.groupId&&old.peer.holderInstanceId===peer.holderInstanceId)await old.socket.close(1008,'REPLACED');
  const session:ChannelSession={socket,peer,token,hello:false,recovered:false,profileInstance:'',profileEpoch:0,lastProfileStamp:-1,busy:false,heartbeat:new ControlHeartbeat(util.generateRandomUUID(true)),timer:-1,helloTimer:-1};
  this.sessions.add(session);
  socket.onText=value=>this.receive(session,value);
  socket.onClosed=()=>{clearInterval(session.timer);clearTimeout(session.helloTimer);this.sessions.delete(session);};
  socket.onPong=value=>{const suspect=session.heartbeat.suspect;if(session.heartbeat.reply(value,monotonic())&&suspect)void socket.close(1012,'RECONCILE');};
  session.helloTimer=setTimeout(()=>{if(!session.hello)void socket.close(1008,'HELLO_TIMEOUT');},10000);
  session.timer=setInterval(()=>{
   if(!session.hello||!socket.isOpen())return;
   const probe=session.heartbeat.tick(monotonic(),session.busy);
   if(!probe)return;if(session.heartbeat.expired){void socket.close(1012,'HEARTBEAT_TIMEOUT');return;}
   void socket.ping(probe).catch(()=>{socket.disconnected();});
  },250);
 }
 private async receive(session:ChannelSession,value:string):Promise<void>{
  if(this.closing||!session.socket.isOpen())throw Error('CONTROL_DISCONNECTED');
  const peer=await this.credentials.authenticate(session.token);
  if(peer.credentialId!==session.peer.credentialId)throw Error('CREDENTIAL_CHANGED');
  const m=JSON.parse(value) as MessageEnvelopeV2;
  if(!validMessageEnvelopeV2(m,[])||m.groupId!==peer.groupId||m.senderInstanceId!==peer.holderInstanceId)throw Error('ENVELOPE_INVALID');
  if(m.coordinatorEpoch!==this.epoch)throw Error('STALE_EPOCH');
  if(!session.hello&&m.type!=='Hello')throw Error('HELLO_REQUIRED');
  const payload=JSON.parse(m.payload) as Object,handler=this.handlers.get(m.type);
  if(m.type==='Hello'){
   if(!validVersionHelloV2(payload as VersionHelloV2)||negotiateVersionV2({versions:[2],extensions:[]},payload as VersionHelloV2)!==2)throw Error('VERSION_UNSUPPORTED');
  }else if(m.type==='RecoveryRequest'){
   if(payload===null||Array.isArray(payload)||Object.keys(payload).length!==0)throw Error('PAYLOAD_INVALID');
  }else if(m.type==='DeviceProfile'){
   if(!validDeviceProfileV2(payload as DeviceProfileV2))throw Error('PROFILE_INVALID');
  }else if(m.type==='Ack'){
   const ack=payload as AckPayload;if(payload===null||Object.keys(payload).join('|')!=='messageId'||ack.messageId!==m.ackOf)throw Error('ACK_INVALID');
  }else if(!handler||!handler.validate(payload))throw Error('PAYLOAD_INVALID');
  const id=JSON.stringify([m.groupId,m.senderInstanceId,m.messageId]),scope=JSON.stringify([m.groupId,m.senderInstanceId]),digest=hash(bytes(canonical(m)));
  let duplicate=false;
  await this.database.transaction(async(tx:CoordinatorTransaction):Promise<void>=>{
   const seen=await tx.querySql('SELECT digest,done FROM ChannelInbox WHERE id=?',[id]);let exists=false,done=false;
   try{if(seen.goToFirstRow()){exists=true;if(seen.getString(0)!==digest)throw Error('MESSAGE_CONFLICT');done=seen.getLong(1)!==0;}}finally{seen.close();}
   if(done){duplicate=true;return;}
   if(!exists){
    const cursor=await tx.querySql('SELECT sequence FROM ChannelCursor WHERE id=?',[scope]);
    try{if(m.type!=='Hello'&&cursor.goToFirstRow()&&m.seq<=cursor.getLong(0))throw Error('SEQUENCE_REORDERED');}finally{cursor.close();}
    await tx.executeSql('INSERT INTO ChannelInbox (id,digest,done) VALUES (?,?,0)',[id,digest]);
    if(m.type!=='Hello')await tx.executeSql('INSERT OR REPLACE INTO ChannelCursor (id,sequence) VALUES (?,?)',[scope,m.seq]);
   }
   if(m.type==='DeviceProfile')await this.profile(tx,peer,payload as DeviceProfileV2);
   else if(m.type==='RecoveryRequest'){
    // Until receipt recovery is registered, never claim that unsettled device work recovered.
    if(handler)await handler.handle(tx,peer,payload,m);
    else{const rows=await tx.querySql("SELECT recordJson FROM Attempt WHERE groupId=? AND holderInstanceId=? AND state!='REJECTED'",[peer.groupId,peer.holderInstanceId]);
     try{while(rows.goToNextRow()){const record=rows.getString(0);if(!record||!(JSON.parse(record) as Record<string,boolean>)['resourcesSettled'])throw Error('RECOVERY_PENDING');}}finally{rows.close();}}
   }else if(m.type==='Ack'){
    const rows=await tx.querySql('SELECT o.id,o.messageJson FROM Outbox o JOIN Attempt a ON a.id=o.attemptId WHERE o.groupId=? AND a.holderInstanceId=?',[peer.groupId,peer.holderInstanceId]);let match='';
    try{while(rows.goToNextRow())if((JSON.parse(rows.getString(1)) as MessageEnvelopeV2).messageId===(payload as AckPayload).messageId)match=rows.getString(0);}finally{rows.close();}
    if(!match)throw Error('ACK_UNAUTHORIZED');await tx.executeSql('UPDATE Outbox SET acked=1 WHERE id=?',[match]);
   }else if(m.type!=='Hello'&&handler)await handler.handle(tx,peer,payload,m);
   await tx.executeSql('UPDATE ChannelInbox SET done=1 WHERE id=?',[id]);
  });
  if(m.type==='Hello')session.hello=true;
  if(m.type==='RecoveryRequest')session.recovered=true;
  if(m.type==='DeviceProfile'&&!duplicate){
   const profile=payload as DeviceProfileV2;session.profileInstance=profile.deviceInstanceId;session.profileEpoch=profile.ledgerEpoch;
   const stamp=profile.ownerActivity.sampledAt,age=Date.now()-stamp;
   if(!session.heartbeat.suspect&&age>=0&&age<=profile.ownerActivity.ttlMs&&stamp>session.lastProfileStamp){session.lastProfileStamp=stamp;session.heartbeat.freshReport(monotonic());}
   session.busy=(profile.inFlight?.length??0)>0;
  }
  if(m.type==='Ack')return;
  let sequence=0;await this.database.transaction(async(tx:CoordinatorTransaction):Promise<void>=>{
   await tx.executeSql('INSERT OR IGNORE INTO DispatchSequence (id,value) VALUES (?,0)',[this.coordinatorId]);
   await tx.executeSql('UPDATE DispatchSequence SET value=value+1 WHERE id=?',[this.coordinatorId]);
   const rows=await tx.querySql('SELECT value FROM DispatchSequence WHERE id=?',[this.coordinatorId]);try{if(rows.goToFirstRow())sequence=rows.getLong(0);}finally{rows.close();}
  });
  const ack:MessageEnvelopeV2={protocolVersion:2,messageId:util.generateRandomUUID(true),type:'Ack',groupId:peer.groupId,senderInstanceId:this.coordinatorId,coordinatorEpoch:this.epoch,seq:sequence,ackOf:m.messageId,traceId:m.traceId,payload:JSON.stringify({messageId:m.messageId} as AckPayload),extensions:[]};
  if(!session.socket.isOpen())throw Error('CONTROL_DISCONNECTED');await session.socket.send(JSON.stringify(ack));
 }
 private async profile(tx:CoordinatorTransaction,peer:CoordinatorPeer,profile:DeviceProfileV2):Promise<void>{
  if(peer.app&&profile.executors.some(e=>!peer.app!.allowedContracts.includes(e.contract.contractId)))throw Error('APP_CONTRACT_FORBIDDEN');
  if(profile.deviceId!==peer.deviceId||profile.holderInstanceId!==peer.holderInstanceId||profile.domain!=='REAL')throw Error('PROFILE_BINDING_CHANGED');
  const now=Date.now(),states:StateSampleV2[]=[profile.ownerActivity,profile.foreground,profile.charging,profile.powerSave];
  const numbers:NumericSampleV2[]=[profile.battery,profile.temperature];
  for(const p of profile.pools)numbers.push(p.total,p.admissionLimit,p.occupied,p.drainMs);
  for(const e of profile.executors)numbers.push(e.compute,e.queue,e.cold,e.publish,e.uncertainty);
  for(const l of profile.links)numbers.push(l.fixedMs,l.bytesPerSecond);
  for(const q of profile.queued??[])numbers.push(q.elapsed);
  for(const f of profile.inFlight??[])numbers.push(f.elapsed,f.remaining);
  if(states.some(s=>s.sampledAt>now||s.source==='SIMULATED')||numbers.some(s=>s.sampledAt>now||s.source==='SIMULATED'))throw Error('PROFILE_EVIDENCE_DOMAIN');
  const key=JSON.stringify(['profile',peer.groupId,peer.holderInstanceId]),rows=await tx.querySql('SELECT metadataJson FROM DeviceInstance WHERE id=?',[key]);
  try{if(rows.goToFirstRow()){
   const old=JSON.parse(rows.getString(0)) as DeviceProfileV2;
   if(canonical(old)===canonical(profile))return;
   if(old.deviceId!==profile.deviceId)throw Error('PROFILE_BINDING_CHANGED');
   if(profile.ledgerEpoch<old.ledgerEpoch||profile.ledgerEpoch===old.ledgerEpoch&&(profile.sequence<=old.sequence||profile.deviceInstanceId!==old.deviceInstanceId))throw Error('PROFILE_REPLAY');
   if(profile.ledgerEpoch!==old.ledgerEpoch&&old.pools.some(p=>p.occupied.value===null||p.occupied.value>0))throw Error('PROFILE_RECOVERY_REQUIRED');
   if(old.pools.some(p=>!profile.pools.some(next=>next.resourcePoolId===p.resourcePoolId)&&(p.occupied.value===null||p.occupied.value>0)))throw Error('PROFILE_POOL_UNSETTLED');
  }}finally{rows.close();}
  const others=await tx.querySql('SELECT id,metadataJson FROM DeviceInstance WHERE groupId=?',[peer.groupId]);
  try{while(others.goToNextRow()){
   const id=others.getString(0);if(id===key||!id.startsWith('["profile",'))continue;
   const other=JSON.parse(others.getString(1)) as DeviceProfileV2;
   if(other.deviceInstanceId===profile.deviceInstanceId||other.executors.some(e=>profile.executors.some(x=>x.target.targetId===e.target.targetId)))throw Error('PROFILE_INSTANCE_COLLISION');
  }}finally{others.close();}
  await tx.executeSql('INSERT OR REPLACE INTO DeviceInstance (id,groupId,revision,metadataJson) VALUES (?,?,?,?)',[key,peer.groupId,profile.sequence,JSON.stringify(profile)]);
 }
 async close():Promise<void>{this.closing=true;for(const s of Array.from(this.sessions))await s.socket.close(4001,'COORDINATOR_SHUTDOWN').catch(()=>{});}
 revoke(id:string):void{for(const s of this.sessions)if(s.peer.credentialId===id)void s.socket.close(1008,'CREDENTIAL_REVOKED');}
}

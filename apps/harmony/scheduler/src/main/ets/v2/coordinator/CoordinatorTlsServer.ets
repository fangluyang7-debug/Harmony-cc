import { hilog } from '@kit.PerformanceAnalysisKit';
import { util } from '@kit.ArkTS';
import * as nativeTls from 'libharmony_coordinator_tls.so';
import { CoordinatorCertificate } from './CoordinatorCertificate';
import { CoordinatorHttpParser, CoordinatorHttpRequest } from './CoordinatorHttpParser';
import { CoordinatorSocket, CoordinatorWire, coordinatorWebSocketAccept } from './CoordinatorSocket';
export interface CoordinatorHttpResponse {status:number;body:string;binaryBody?:Uint8Array;contentType?:string;}
interface PendingWrite {clientId:number;resolve:()=>void;reject:(reason:Error)=>void;}
interface Session {remoteAddress:string;wire:CoordinatorWire;parser:CoordinatorHttpParser;channel:CoordinatorSocket|null;work:Promise<void>;queued:number;done:boolean;timer:number;}

/** TLS termination in the bundled byte-safe transport; HTTP/WS contracts stay unchanged. */
export class CoordinatorTlsServer {
 private running:boolean=false;
 private sessions:Map<number,Session>=new Map();
 private writes:Map<number,PendingWrite>=new Map();
 private sequence:number=0;
 private upgrade:((request:CoordinatorHttpRequest,connection:CoordinatorSocket)=>Promise<void>)|null=null;
 installChannel(upgrade:(request:CoordinatorHttpRequest,connection:CoordinatorSocket)=>Promise<void>):void{this.upgrade=upgrade;}
 async start(identity:CoordinatorCertificate,port:number,handle:(request:CoordinatorHttpRequest)=>Promise<CoordinatorHttpResponse>):Promise<void>{
  if(this.running)throw Error('COORDINATOR_ALREADY_LISTENING');
  nativeTls.start(identity.certificate,identity.privateKey,port,(event:nativeTls.TlsEvent)=>this.event(event,handle));this.running=true;
 }
 private send(clientId:number,data:string|ArrayBuffer):Promise<void>{
  if(!this.running||!this.sessions.has(clientId))return Promise.reject(Error('CONTROL_DISCONNECTED'));
  const payload=typeof data==='string'?new util.TextEncoder().encodeInto(data).buffer:data,id=++this.sequence;
  return new Promise<void>((resolve,reject)=>{
   this.writes.set(id,{clientId,resolve,reject});
   try{nativeTls.send(clientId,payload,id);}catch(e){this.writes.delete(id);reject(e as Error);}
  });
 }
 private disconnected(id:number):void{
  const session=this.sessions.get(id);if(session){session.done=true;clearTimeout(session.timer);session.channel?.disconnected();this.sessions.delete(id);}
  for(const entry of this.writes){if(entry[1].clientId===id){entry[1].reject(Error('CONTROL_DISCONNECTED'));this.writes.delete(entry[0]);}}
 }
 private event(event:nativeTls.TlsEvent,handle:(request:CoordinatorHttpRequest)=>Promise<CoordinatorHttpResponse>):void{
  if(event.type==='sent'||event.type==='sendError'){
   const pending=this.writes.get(event.requestId);if(pending){this.writes.delete(event.requestId);if(event.type==='sent')pending.resolve();else pending.reject(Error(event.error));}return;
  }
  if(event.type==='close'){this.disconnected(event.clientId);return;}
  if(!this.running)return;
  if(event.type==='connect'){
   const id=event.clientId,wire:CoordinatorWire={clientId:id,send:data=>this.send(id,data)};
   const session:Session={remoteAddress:event.remoteAddress,wire,parser:new CoordinatorHttpParser(),channel:null,work:Promise.resolve(),queued:0,done:false,timer:-1};
   session.timer=setTimeout(()=>{if(!session.channel){session.done=true;nativeTls.closeClient(id);}},15000);
   this.sessions.set(id,session);return;
  }
  if(event.type!=='data')return;
  const session=this.sessions.get(event.clientId);if(!session||session.done)return;
  if(session.queued>=64){session.done=true;nativeTls.closeClient(event.clientId);return;}
  session.queued++;
  session.work=session.work.then(async():Promise<void>=>{
   if(session.done)return;
   try{
    if(session.channel){await session.channel.receive(new Uint8Array(event.data));return;}
    const request=session.parser.push(new Uint8Array(event.data));if(request===null)return;clearTimeout(session.timer);
    request.remoteAddress=session.remoteAddress;
    if(request.webSocketKey!==undefined){
     if(request.path!=='/v2/channel'||this.upgrade===null)throw Error('CHANNEL_UNAVAILABLE');
     const connection=new CoordinatorSocket(session.wire);await this.upgrade(request,connection);session.channel=connection;
     await session.wire.send('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+coordinatorWebSocketAccept(request.webSocketKey)+'\r\n\r\n');return;
    }
    session.done=true;await this.reply(session.wire,await handle(request));nativeTls.closeClient(event.clientId);
   }catch(e){
    hilog.error(0x0001,'HarmonyCoordinator','CONTROL_FAILED %{public}s',(e as Error).message);session.done=true;
    if(session.channel)await session.channel.close(1008,'CONTROL_REJECTED').catch(()=>{});
    else await this.reply(session.wire,{status:400,body:'{"error":"REQUEST_REJECTED"}'}).catch(()=>{});
    nativeTls.closeClient(event.clientId);
   }
  }).finally(()=>{session.queued--;});
 }
 async close():Promise<void>{
  if(!this.running)return;this.running=false;nativeTls.stop();
  for(const id of Array.from(this.sessions.keys()))this.disconnected(id);
 }
 private async reply(client:CoordinatorWire,response:CoordinatorHttpResponse):Promise<void>{
  const payload=response.binaryBody??(response.body.length===0?new Uint8Array(0):new util.TextEncoder().encodeInto(response.body)),length=payload.length;
  const contentType=response.contentType??'application/json; charset=utf-8';if(/[\r\n]/.test(contentType))throw Error('HTTP_RESPONSE_INVALID');
  const header='HTTP/1.1 '+response.status+' '+(response.status===200?'OK':'Error')+'\r\nContent-Type: '+contentType+'\r\nDate: '+new Date().toUTCString()+'\r\nCache-Control: no-store\r\nContent-Length: '+length+'\r\nConnection: close\r\n\r\n';
  const head=new util.TextEncoder().encodeInto(header),wire=new Uint8Array(head.length+payload.length);wire.set(head);wire.set(payload,head.length);
  await client.send(wire.buffer);
 }
}

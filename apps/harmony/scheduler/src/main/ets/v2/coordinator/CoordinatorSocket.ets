import { util } from '@kit.ArkTS';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { CoordinatorWebSocketParser, coordinatorWsFrame } from './CoordinatorWebSocket';

export interface CoordinatorWire {clientId:number;send:(data:string|ArrayBuffer)=>Promise<void>;}

export function coordinatorWebSocketAccept(key:string):string{
 const digest=cryptoFramework.createMd('SHA1');
 digest.updateSync({data:new util.TextEncoder().encodeInto(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11')});
 return new util.Base64Helper().encodeToStringSync(digest.digestSync().data);
}
/** Framing adapter; authorization and durable messages belong to CoordinatorChannel. */
export class CoordinatorSocket {
 private client:CoordinatorWire;
 private parser:CoordinatorWebSocketParser=new CoordinatorWebSocketParser();
 private ended:boolean=false;
 private output:Promise<void>=Promise.resolve();
 private input:Promise<void>=Promise.resolve();
 private queued:number=0;
 private failed:boolean=false;
 onError:((error:Error)=>void)|null=null;
 private buffered:number=0;
 onText:((value:string)=>Promise<void>)|null=null;
 onPong:((value:string)=>void)|null=null;
 onClosed:(()=>void)|null=null;
 constructor(client:CoordinatorWire){this.client=client;}
 isOpen():boolean{return !this.ended;}
 async receive(data:Uint8Array):Promise<void>{
  if(this.ended)return;
  for(const frame of this.parser.push(data)){
   if(frame.opcode===8){await this.sendFrame(8,frame.payload);this.disconnected();return;}
   if(frame.opcode===9){await this.sendFrame(10,frame.payload);continue;}
   if(frame.opcode===10){if(this.onPong)this.onPong(util.TextDecoder.create('utf-8',{fatal:true}).decodeToString(frame.payload));continue;}
   if(frame.opcode!==1)throw Error('TEXT_REQUIRED');
   const value=util.TextDecoder.create('utf-8',{fatal:true}).decodeToString(frame.payload);
   if(this.queued>=64)throw Error('BACKPRESSURE');this.queued++;
   // Keep durable messages ordered, but never queue transport Pong behind database work.
   this.input=this.input.then(async():Promise<void>=>{if(!this.ended&&!this.failed&&this.onText)await this.onText(value);}).catch((e:Error)=>{
    this.failed=true;this.onError?.(e);void this.close(1008,'CONTROL_REJECTED').catch(()=>{this.disconnected();});
   }).finally(()=>{this.queued--;});
  }
 }
 private sendFrame(opcode:number,data:Uint8Array):Promise<void>{
  if(this.ended)return Promise.reject(Error('CONTROL_DISCONNECTED'));
  const frame=coordinatorWsFrame(opcode,data);
  if(this.buffered+frame.length>1048576)return Promise.reject(Error('BACKPRESSURE'));
  this.buffered+=frame.length;
  const work=this.output.then(async():Promise<void>=>{if(this.ended)throw Error('CONTROL_DISCONNECTED');await this.client.send(frame.buffer);});
  this.output=work.catch(()=>{});return work.finally(()=>{this.buffered-=frame.length;});
 }
 send(value:string):Promise<void>{return this.sendFrame(1,new util.TextEncoder().encodeInto(value));}
 ping(value:string):Promise<void>{return this.sendFrame(9,new util.TextEncoder().encodeInto(value));}
 async close(code:number,reason:string):Promise<void>{
  if(this.ended)return;
  const message=new util.TextEncoder().encodeInto(reason).slice(0,123),payload=new Uint8Array(message.length+2);
  payload[0]=code>>8;payload[1]=code&255;payload.set(message,2);
  try{await this.sendFrame(8,payload);}finally{this.disconnected();}
  // The peer closes TLS after receiving CLOSE. Never race native SSL_read by
  // immediately calling TLSSocketConnection.close after a send (HarmonyOS 7).
 }
 disconnected():void{if(this.ended)return;this.ended=true;if(this.onClosed)this.onClosed();}
}

import { socket } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { monotonic } from '../platform/NativeTransport';
interface DiscoveryReply {version:number;service:string;address:string;}
/** Same discovery wire format and UDP port as services/coordinator/src/discovery.ts. */
export class CoordinatorDiscovery {
 private server:socket.UDPSocket|null=null;
 private seen:Map<string,number>=new Map();
 private address:string='';
 private timer:number=-1;
 private opening:boolean=false;
 private generation:number=0;
 async start(address:string):Promise<void>{
  if(this.address)throw Error('DISCOVERY_ALREADY_STARTED');
  if(!/^https:\/\/\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(address))throw Error('DISCOVERY_ADDRESS_INVALID');
  this.address=address;
  try{await this.bind();}catch(e){this.address='';throw e as Error;}
  this.timer=setInterval(()=>{if(!this.server&&!this.opening&&this.address)void this.bind().catch(()=>{});},2000);
 }
 private async bind():Promise<void>{
  if(this.opening||this.server||!this.address)return;this.opening=true;const generation=this.generation;
  const server=socket.constructUDPSocketInstance();
  const reply:DiscoveryReply={version:1,service:'harmony-coordinator',address:this.address};
  server.on('error',()=>{if(this.server===server){this.server=null;this.seen.clear();}void server.close().catch(()=>{});});
  server.on('message',(message:socket.SocketMessageInfo)=>{
   if(message.message.byteLength>64)return;
   if(util.TextDecoder.create('utf-8').decodeToString(new Uint8Array(message.message))!=='HARMONY_DISCOVER_V1\n')return;
   const now=monotonic(),remote=message.remoteInfo,key=remote.address+':'+remote.port,last=this.seen.get(key);if(last!==undefined&&now-last>=0&&now-last<250)return;
   if(this.seen.size>1024)this.seen.clear();this.seen.set(key,now);
   void server.send({data:JSON.stringify(reply),address:{address:remote.address,port:remote.port,family:1}}).catch(()=>{});
  });
  try{await server.bind({address:'0.0.0.0',port:7444,family:1});if(generation!==this.generation||!this.address){await server.close();return;}this.server=server;}
  catch(e){await server.close().catch(()=>{});throw e as Error;}finally{this.opening=false;}
 }
 async close():Promise<void>{this.address='';this.generation++;if(this.timer!==-1)clearInterval(this.timer);this.timer=-1;const server=this.server;this.server=null;this.seen.clear();if(server)await server.close().catch(()=>{});}
}

import { socket } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { monotonic } from '../platform/NativeTransport';
interface DiscoveryReply {version:number;service:string;address:string;}
/** Same discovery wire format and UDP port as services/coordinator/src/discovery.ts. */
export class CoordinatorDiscovery {
 private server:socket.UDPSocket|null=null;
 private seen:Map<string,number>=new Map();
 async start(address:string):Promise<void>{
  if(this.server)throw Error('DISCOVERY_ALREADY_STARTED');
  if(!/^https:\/\/\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(address))throw Error('DISCOVERY_ADDRESS_INVALID');
  const server=socket.constructUDPSocketInstance();
  const reply:DiscoveryReply={version:1,service:'harmony-coordinator',address};
  server.on('message',(message:socket.SocketMessageInfo)=>{
   if(message.message.byteLength>64)return;
   if(util.TextDecoder.create('utf-8').decodeToString(new Uint8Array(message.message))!=='HARMONY_DISCOVER_V1\n')return;
   const now=monotonic(),remote=message.remoteInfo,last=this.seen.get(remote.address);if(last!==undefined&&now-last>=0&&now-last<1000)return;
   if(this.seen.size>1024)this.seen.clear();this.seen.set(remote.address,now);
   void server.send({data:JSON.stringify(reply),address:{address:remote.address,port:remote.port,family:1}}).catch(()=>{});
  });
  try{await server.bind({address:'0.0.0.0',port:7444,family:1});this.server=server;}
  catch(e){await server.close().catch(()=>{});throw e as Error;}
 }
 async close():Promise<void>{const server=this.server;this.server=null;this.seen.clear();if(server)await server.close();}
}

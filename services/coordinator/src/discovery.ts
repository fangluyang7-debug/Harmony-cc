import dgram from 'node:dgram';
import {isIP} from 'node:net';
import {networkInterfaces} from 'node:os';
/** Discovery is an untrusted address hint. Joining still requires the pinned one-use invitation. */
export function advertiseCoordinator(address:string,onError:()=>void,port=7444):()=>void {
 const url=new URL(address);if(isIP(url.hostname)!==4)return ()=>{};
 const socket=dgram.createSocket('udp4');let closed=false;const seen=new Map<string,number>();
 socket.on('error',()=>{onError();if(!closed){closed=true;socket.close();}});
 socket.on('message',(message,remote)=>{
  if(message.length>64||message.toString()!=='HARMONY_DISCOVER_V1\n')return;
  if(!Object.values(networkInterfaces()).some(list=>list?.some(item=>item.address===url.hostname)))return;
  const now=Date.now();if(now-(seen.get(remote.address)??0)<1000)return;
  if(seen.size>1024)seen.clear();seen.set(remote.address,now);
  socket.send(Buffer.from(JSON.stringify({version:1,service:'harmony-coordinator',address:url.origin})),remote.port,remote.address,()=>{});
 });
 socket.bind(port,'0.0.0.0');
 return ()=>{if(!closed){closed=true;socket.close();}};
}

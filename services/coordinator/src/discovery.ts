import dgram from 'node:dgram';
import {isIP} from 'node:net';
import {networkInterfaces} from 'node:os';
/** Discovery is an untrusted address hint; pairing still verifies the invitation. */
export function advertiseCoordinator(address:string,onError:()=>void,port=7444):()=>void {
 const url=new URL(address);if(isIP(url.hostname)!==4)return ()=>{};
 let active:dgram.Socket|null=null,closed=false,retry:ReturnType<typeof setTimeout>|undefined;const seen=new Map<string,number>();
 const bind=()=>{if(closed)return;const socket=dgram.createSocket('udp4');active=socket;
 socket.on('error',()=>{onError();if(active!==socket)return;active=null;try{socket.close();}catch{}if(!closed)retry=setTimeout(bind,1000);});
 socket.on('message',(message,remote)=>{
  if(message.length>64||message.toString()!=='HARMONY_DISCOVER_V1\n')return;
  if(!Object.values(networkInterfaces()).some(list=>list?.some(item=>item.address===url.hostname)))return;
  const now=Date.now(),key=remote.address+':'+remote.port;if(now-(seen.get(key)??0)<250)return;
  if(seen.size>1024)seen.clear();seen.set(key,now);
  socket.send(Buffer.from(JSON.stringify({version:1,service:'harmony-coordinator',address:url.origin})),remote.port,remote.address,()=>{});
 });
 socket.bind(port,'0.0.0.0');};bind();
 return ()=>{closed=true;if(retry)clearTimeout(retry);if(active)try{active.close();}catch{}active=null;seen.clear();};
}

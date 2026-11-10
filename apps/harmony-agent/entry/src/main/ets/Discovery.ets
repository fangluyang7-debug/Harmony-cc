import { hilog } from '@kit.PerformanceAnalysisKit';
import { socket } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
interface CenterHint {version:number;service:string;address:string;}
async function reachable(address:string):Promise<boolean> {
 const tcp=socket.constructTCPSocketInstance();
 try {
  const parts=address.substring(8).split(':');
  await tcp.bind({address:'0.0.0.0',port:0,family:1});
  await tcp.connect({address:{address:parts[0],port:Number(parts[1]),family:1},timeout:1000});
  return true;
 } catch(e) { return false; }
 finally { try { await tcp.close(); } catch(e) {} }
}
export async function discoverCenters():Promise<string[]> {
 const udp=socket.constructUDPSocketInstance(),found:string[]=[];
 try{
  udp.on('message',(info:socket.SocketMessageInfo)=>{
   if(info.message.byteLength>1024)return;
   try{const hint=JSON.parse(new util.TextDecoder('utf-8').decodeToString(new Uint8Array(info.message))) as CenterHint;
    if(hint.version===1&&hint.service==='harmony-coordinator'&&/^https:\/\/[0-9.]+:[0-9]+$/.test(hint.address)&&found.indexOf(hint.address)<0&&found.length<16){found.push(hint.address);hilog.info(0x0001,'CenterDiscovery','hint %{public}s from %{public}s',hint.address,info.remoteInfo.address);}
   }catch(e){/* Untrusted broadcast packets never establish trust. */}
  });
  await udp.bind({address:'0.0.0.0',port:0,family:1});await udp.setExtraOptions({broadcast:true});
  await udp.send({data:'HARMONY_DISCOVER_V1\n',address:{address:'255.255.255.255',port:7444,family:1}});
  await new Promise<void>(resolve=>{setTimeout(resolve,2000);});
  const live:boolean[]=await Promise.all(found.map((address:string)=>reachable(address)));
  return found.filter((_address:string,index:number)=>live[index]);
 }finally{await udp.close();}
}

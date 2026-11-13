import { connection } from '@kit.NetworkKit';
export interface CoordinatorNetwork {address:string;broadcast:string;}
export function ipv4Broadcast(address:string,prefix:number):string {
 const parts=address.split('.').map(v=>Number(v));
 if(parts.length!==4||parts.some(v=>!Number.isInteger(v)||v<0||v>255)||!Number.isInteger(prefix)||prefix<1||prefix>30)return '';
 return parts.map((v,i)=>{const bits=Math.max(0,Math.min(8,prefix-i*8));return v|(255>>>bits);}).join('.');
}
/** Select LAN interfaces, never a cellular/VPN default route. Works without Internet access. */
export async function coordinatorNetworks():Promise<CoordinatorNetwork[]> {
 const result:CoordinatorNetwork[]=[];
 for(const net of await connection.getAllNets()){
  try{
   const caps=await connection.getNetCapabilities(net);
   if(!caps.bearerTypes.includes(connection.NetBearType.BEARER_WIFI)&&!caps.bearerTypes.includes(connection.NetBearType.BEARER_ETHERNET))continue;
   const props=await connection.getConnectionProperties(net);
   for(const link of props.linkAddresses){
    const address=link.address.address,broadcast=ipv4Broadcast(address,link.prefixLength);
    if(!broadcast||address.startsWith('127.')||address.startsWith('169.254.')||address==='0.0.0.0'||result.some(v=>v.address===address))continue;
    result.push({address,broadcast});
   }
  }catch(_){/* An unavailable network must not hide the remaining LAN interfaces. */}
 }
 return result;
}

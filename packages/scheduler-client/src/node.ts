import https from 'node:https';
import tls from 'node:tls';
import {createHash,X509Certificate} from 'node:crypto';
import {transfer} from '@harmony/resource-transport';
import {SdkPort,SdkTicket} from './index';
export interface AppConnection {address:string;certificate:string;fingerprint:string;credential:string;tlsMode?:'pinned'|'public';domain:'REAL'|'SIMULATED';}
/** HTTPS control transport, also used by the owner-confirmed registration command. */
export function appRequest(connection:AppConnection){
 const base=new URL(connection.address);if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||base.pathname!=='/')throw Error('SDK_ADDRESS_INVALID');
 const publicTls=connection.tlsMode==='public';
 if(!publicTls&&new X509Certificate(connection.certificate).fingerprint256.replaceAll(':','').toLowerCase()!==connection.fingerprint)throw Error('CERTIFICATE_PIN_MISMATCH');
 return (route:string,body:string|null)=>new Promise<string>((resolve,reject)=>{
  if(!/^\/v2\/(?:apps\/(?:registrations(?:\/[A-Za-z0-9_.:-]+\/revoke)?|exchange|me)|sdk\/jobs(?:\/[A-Za-z0-9_.:-]+(?:\/(?:start|cancel))?)?)$/.test(route)){reject(Error('SDK_ROUTE_INVALID'));return;}
  const bytes=body===null?null:Buffer.from(body);if(bytes&&bytes.length>100000){reject(Error('SDK_REQUEST_TOO_LARGE'));return;}
  const request=https.request(new URL(route,base),{method:bytes?'POST':'GET',...(publicTls?{}:{ca:connection.certificate,checkServerIdentity:(host:string,cert:tls.PeerCertificate)=>tls.checkServerIdentity(host,cert)??(cert.fingerprint256?.replaceAll(':','').toLowerCase()===connection.fingerprint?undefined:Error('CERTIFICATE_PIN_MISMATCH'))}),headers:{Authorization:'Bearer '+connection.credential,...(bytes?{'Content-Type':'application/json','Content-Length':bytes.length}:{})}},response=>{
   const chunks:Buffer[]=[];let count=0;
   response.on('data',(chunk:Buffer)=>{count+=chunk.length;if(count>1048576)request.destroy(Error('SDK_RESPONSE_TOO_LARGE'));else chunks.push(chunk);});response.on('error',reject);
   response.on('end',()=>{const text=Buffer.concat(chunks).toString();try{const value=JSON.parse(text);if(response.statusCode!==200&&response.statusCode!==201)throw Error(typeof value.message==='string'?value.message:'SDK_HTTP_'+response.statusCode);resolve(text);}catch(error){reject(error);}});
  });request.on('error',reject);request.setTimeout(10000,()=>request.destroy(Error('SDK_REQUEST_TIMEOUT')));if(bytes)request.write(bytes);request.end();
 });
}
export function nodeSdkPort(connection:AppConnection):SdkPort{return {
 request:appRequest(connection),
 write:async(ticket:SdkTicket,bytes:Uint8Array)=>{await transfer(connection,ticket as Parameters<typeof transfer>[1],connection.credential,Buffer.from(bytes));},
 read:async(ticket:SdkTicket)=>(await transfer(connection,ticket as Parameters<typeof transfer>[1],connection.credential)).bytes,
 digest:async bytes=>createHash('sha256').update(bytes).digest('hex'),now:Date.now,wait:ms=>new Promise(resolve=>setTimeout(resolve,ms))
};}

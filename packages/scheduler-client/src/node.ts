import https from 'node:https';
import {performance} from 'node:perf_hooks';
import tls from 'node:tls';
import {createHash,X509Certificate,randomUUID} from 'node:crypto';
import {transfer,directTransfer} from '@harmony/resource-transport';
import {SdkPort,SdkTicket} from './index';
export interface AppConnection {address:string;certificate:string;fingerprint:string;credential:string;tlsMode?:'pinned'|'public';domain:'REAL'|'SIMULATED';}
/** HTTPS control transport, also used by the owner-confirmed registration command. */
export function appRequest(connection:AppConnection){
 const base=new URL(connection.address);if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||base.pathname!=='/')throw Error('SDK_ADDRESS_INVALID');
 const publicTls=connection.tlsMode==='public';
 if(!publicTls&&new X509Certificate(connection.certificate).fingerprint256.replaceAll(':','').toLowerCase()!==connection.fingerprint)throw Error('CERTIFICATE_PIN_MISMATCH');
 return (route:string,body:string|null)=>new Promise<string>((resolve,reject)=>{
  if(!/^\/v2\/(?:display(?:\/[a-zA-Z0-9-]+(?:\/(?:accept|leave|publish|shown|revoke))?)?|data\/(?:authorizations|receipts|observations|network\/(?:reset|failure))|apps\/(?:registrations(?:\/[A-Za-z0-9_.:-]+\/revoke)?|exchange|me(?:\/capabilities)?)|sdk\/jobs(?:\/[A-Za-z0-9_.:-]+(?:\/(?:start|cancel|received))?)?)$/.test(route)){reject(Error('SDK_ROUTE_INVALID'));return;}
  const bytes=body===null?null:Buffer.from(body);if(bytes&&bytes.length>100000){reject(Error('SDK_REQUEST_TOO_LARGE'));return;}
  const request=https.request(new URL(route,base),{method:bytes?'POST':'GET',...(publicTls?{}:{ca:connection.certificate,checkServerIdentity:(host:string,cert:tls.PeerCertificate)=>tls.checkServerIdentity(host,cert)??(cert.fingerprint256?.replaceAll(':','').toLowerCase()===connection.fingerprint?undefined:Error('CERTIFICATE_PIN_MISMATCH'))}),headers:{Authorization:'Bearer '+connection.credential,...(bytes?{'Content-Type':'application/json','Content-Length':bytes.length}:{})}},response=>{
   const chunks:Buffer[]=[];let count=0;
   response.on('data',(chunk:Buffer)=>{count+=chunk.length;if(count>1048576)request.destroy(Error('SDK_RESPONSE_TOO_LARGE'));else chunks.push(chunk);});response.on('error',reject);
   response.on('end',()=>{const text=Buffer.concat(chunks).toString();try{const value=JSON.parse(text);if(response.statusCode!==200&&response.statusCode!==201)throw Error(typeof value.message==='string'?value.message:'SDK_HTTP_'+response.statusCode);resolve(text);}catch(error){reject(error);}});
  });request.on('error',reject);request.setTimeout(10000,()=>request.destroy(Error('SDK_REQUEST_TIMEOUT')));if(bytes)request.write(bytes);request.end();
 });
}
export function nodeSdkPort(connection:AppConnection):SdkPort{const clockDomainId=randomUUID();return {
 measure:()=>({clockDomainId,milliseconds:performance.now()}),
 request:appRequest(connection),
 writeDirect:async(jobId,endpointId,ticket,bytes)=>{
  const request=appRequest(connection);let endpointEpoch='';
  try{
   const grant=JSON.parse(await request('/v2/data/authorizations',JSON.stringify({attemptId:jobId,endpointId,operation:'WRITE'}))) as Parameters<typeof directTransfer>[0];
   const a=grant.signed.authorization;if(a.attemptId!==jobId||a.endpoint.id!==endpointId||a.operation!=='WRITE'||a.ref.contentHash!==ticket.ref.contentHash||a.ref.artifactId!==ticket.ref.artifactId||a.ref.contentVersion!==ticket.ref.contentVersion||a.ref.schemaId!==ticket.ref.schemaId||a.ref.schemaVersion!==ticket.ref.schemaVersion||a.bytes!==ticket.bytes)throw Error('SDK_DIRECT_SCOPE');
   endpointEpoch=a.endpoint.epoch;
   const observation=await directTransfer(grant,connection.certificate,connection.domain,Buffer.from(bytes));
   try{await request('/v2/data/observations',JSON.stringify({authorizationId:a.id,durationMs:observation.durationMs}));}catch{/* Measurement delivery does not undo a verified transfer. */}
  }catch(error){
   // Discard direct evidence before re-planning; fallback uploads data, never duplicates execution.
   const code=(error as NodeJS.ErrnoException).code??(error as Error).message;
   const reason=/TLS|CERT|SELF_SIGNED/.test(code)?'TLS_MISMATCH':/TIMEOUT|TIMEDOUT/.test(code)?'TIMEOUT':'PEER_UNREACHABLE';
   if(endpointEpoch){try{await request('/v2/data/network/failure',JSON.stringify({endpointId,endpointEpoch,reason}));}catch{await request('/v2/data/network/reset','{}');}}else await request('/v2/data/network/reset','{}');
   await transfer(connection,ticket as Parameters<typeof transfer>[1],connection.credential,Buffer.from(bytes));
  }
 },
 write:async(ticket:SdkTicket,bytes:Uint8Array)=>{if(ticket.direct){await nodeSdkPort(connection).writeDirect!(ticket.direct.jobId,ticket.direct.endpointId,ticket,bytes);return;}await transfer(connection,ticket as Parameters<typeof transfer>[1],connection.credential,Buffer.from(bytes));},
 read:async(ticket:SdkTicket)=>{
  if(ticket.direct){
   const request=appRequest(connection);
   try{
    const grant=JSON.parse(await request('/v2/data/authorizations',JSON.stringify({attemptId:ticket.direct.jobId,endpointId:ticket.direct.endpointId,operation:'READ'}))) as Parameters<typeof directTransfer>[0];
    const a=grant.signed.authorization;
    if(a.attemptId!==ticket.direct.jobId||a.endpoint.id!==ticket.direct.endpointId||a.operation!=='READ'||a.ref.contentHash!==ticket.ref.contentHash||a.ref.artifactId!==ticket.ref.artifactId||a.ref.contentVersion!==ticket.ref.contentVersion||a.ref.schemaId!==ticket.ref.schemaId||a.ref.schemaVersion!==ticket.ref.schemaVersion||a.bytes!==ticket.bytes)throw Error('SDK_DIRECT_SCOPE');
    const result=await directTransfer(grant,connection.certificate,connection.domain);
    await request('/v2/data/receipts',JSON.stringify({authorizationId:a.id,contentHash:a.ref.contentHash,bytes:a.bytes}));
    try{await request('/v2/data/observations',JSON.stringify({authorizationId:a.id,durationMs:result.durationMs}));}catch{/* Best effort telemetry. */}
    return result.bytes;
   }catch{
    await request('/v2/data/network/reset','{}');
   }
  }
  return (await transfer(connection,ticket as Parameters<typeof transfer>[1],connection.credential)).bytes;
 },
 digest:async bytes=>createHash('sha256').update(bytes).digest('hex'),now:Date.now,wait:ms=>new Promise(resolve=>setTimeout(resolve,ms))
};}

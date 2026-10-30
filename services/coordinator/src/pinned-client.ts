import https from 'node:https';
import tls from 'node:tls';
import { certificateFingerprint, Invitation } from './auth';
import { protocolId, validAllotmentGrantV2, validTraceSpanV2, analyzeTrace, canonical } from '@harmony/scheduler-core';

const exact=(v:any,keys:string[])=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
function validResponse(route:string,value:any):boolean {
  const credential=()=>typeof value.credential==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value.credential)&&exact(value.peer,['groupId','holderInstanceId','deviceId','principalId','credentialId'])&&Object.values(value.peer).every(v=>protocolId(v as string));
  if(route==='/v2/pair')return exact(value,['credential','peer','epoch'])&&credential()&&Number.isSafeInteger(value.epoch)&&value.epoch>0;
  if(route==='/v2/credentials/rotate')return exact(value,['credential','peer'])&&credential();
  if(route==='/v2/credentials/revoke')return exact(value,['revoked'])&&value.revoked===true;
  if(route==='/v2/identity')return exact(value,['version','coordinatorId','epoch','domain'])&&value.version===2&&protocolId(value.coordinatorId)&&Number.isSafeInteger(value.epoch)&&value.epoch>0&&['REAL','SIMULATED'].includes(value.domain);
  if(route==='/v2/allotments/request')return validAllotmentGrantV2(value);
  if(route==='/v2/allotments/ack')return exact(value,['acknowledged'])&&value.acknowledged===true;
  if(route.startsWith('/v2/traces/'))return exact(value,['traceId','spans','analysis'])&&protocolId(value.traceId)&&route==='/v2/traces/'+value.traceId&&
    Array.isArray(value.spans)&&value.spans.length<=16384&&value.spans.every(validTraceSpanV2)&&value.spans.every((s:any)=>s.traceId===value.traceId)&&canonical(value.analysis)===canonical(analyzeTrace(value.spans));
  if(route==='/v2/traces')return exact(value,['accepted'])&&Number.isSafeInteger(value.accepted)&&value.accepted>=1&&value.accepted<=128;
  return false;
}

/** The invitation certificate is trusted out-of-band, never fetched from an unknown server. */
export function pinnedOptions(invitation:Pick<Invitation,'address'|'certificate'|'fingerprint'>):https.RequestOptions {
  const url=new URL(invitation.address);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||certificateFingerprint(invitation.certificate)!==invitation.fingerprint)throw Error('CERTIFICATE_PIN_MISMATCH');
  return {ca:invitation.certificate,checkServerIdentity:(host,cert)=>{
    const error=tls.checkServerIdentity(host,cert);if(error)return error;
    if(cert.fingerprint256?.replaceAll(':','').toLowerCase()!==invitation.fingerprint)return Error('CERTIFICATE_PIN_MISMATCH');
    return undefined;
  }};
}
export async function pinnedRequest(invitation:Pick<Invitation,'address'|'certificate'|'fingerprint'>,route:string,body?:unknown,token?:string){
  const options=pinnedOptions(invitation),url=new URL(route,invitation.address);
  if(url.origin!==new URL(invitation.address).origin)throw Error('ORIGIN_MISMATCH');
  const bytes=body===undefined?null:Buffer.from(JSON.stringify(body));
  return new Promise<any>((resolve,reject)=>{
    const request=https.request(url,{...options,method:bytes?'POST':'GET',headers:{...(bytes?{'Content-Type':'application/json','Content-Length':bytes.length}:{}),...(token?{Authorization:'Bearer '+token}:{})}},response=>{
      const chunks:Buffer[]=[];let size=0;
      response.on('data',chunk=>{size+=chunk.length;if(size>1048576){request.destroy(Error('RESPONSE_TOO_LARGE'));return;}chunks.push(chunk);});
      response.on('end',()=>{if(response.statusCode!==200&&response.statusCode!==201){reject(Error('HTTP_'+response.statusCode));return;}try{const value=JSON.parse(Buffer.concat(chunks).toString());if(!validResponse(url.pathname,value))throw Error('RESPONSE_INVALID');resolve(value);}catch{reject(Error('RESPONSE_INVALID'));}});
      response.on('error',reject);
    });
    request.setTimeout(10000,()=>request.destroy(Error('REQUEST_TIMEOUT')));request.on('error',reject);
    if(bytes)request.write(bytes);request.end();
  });
}

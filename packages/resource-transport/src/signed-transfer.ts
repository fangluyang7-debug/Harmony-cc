import {createHash, sign, verify, X509Certificate} from 'node:crypto';
import {isIP} from 'node:net';
import {ArtifactRefV2, canonical, protocolId, validArtifactRefV2} from '@harmony/scheduler-core';

export interface DataEndpointIdentity {
  id:string; groupId:string; holderInstanceId:string; deviceId:string; epoch:string;
  address:string; certificate:string; fingerprint:string;
}
export interface TransferAuthorization {
  version:1; id:string; domain:'REAL'|'SIMULATED'; coordinatorEpoch:number;
  workflowId:string; attemptId:string; appInstanceId:string; groupId:string; ownerPrincipalId:string;
  requesterHolderId:string; senderHolderId:string; receiverHolderId:string;
  endpoint:DataEndpointIdentity; ref:ArtifactRefV2; bytes:number; operation:'READ'|'WRITE';
  proofHash:string; issuedAt:number; expiresAt:number;
}
export interface SignedTransfer {authorization:TransferAuthorization; signature:string;}
export const transferDigest=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const exact=(v:any,keys:string[])=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const integer=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0;

export function validDataEndpoint(e:DataEndpointIdentity):boolean {
  if(!exact(e,['id','groupId','holderInstanceId','deviceId','epoch','address','certificate','fingerprint'])||
    ![e.id,e.groupId,e.holderInstanceId,e.deviceId,e.epoch].every(protocolId)||!hash(e.fingerprint)||
    typeof e.address!=='string'||e.address.length>2048||typeof e.certificate!=='string'||e.certificate.length>16384)return false;
  try{
    const url=new URL(e.address),cert=new X509Certificate(e.certificate),host=url.hostname.replace(/^\[|\]$/g,'');
    return url.protocol==='https:'&&url.pathname==='/'&&!url.search&&!url.hash&&!url.username&&!url.password&&
      cert.fingerprint256.replaceAll(':','').toLowerCase()===e.fingerprint&&
      !!(isIP(host)?cert.checkIP(host):cert.checkHost(host));
  }catch{return false;}
}
export function validTransferAuthorization(a:TransferAuthorization):boolean {
  return exact(a,['version','id','domain','coordinatorEpoch','workflowId','attemptId','appInstanceId','groupId','ownerPrincipalId',
    'requesterHolderId','senderHolderId','receiverHolderId','endpoint','ref','bytes','operation','proofHash','issuedAt','expiresAt'])&&
    a.version===1&&['REAL','SIMULATED'].includes(a.domain)&&integer(a.coordinatorEpoch)&&
    [a.id,a.workflowId,a.attemptId,a.appInstanceId,a.groupId,a.ownerPrincipalId,a.requesterHolderId,a.senderHolderId,a.receiverHolderId].every(protocolId)&&
    validDataEndpoint(a.endpoint)&&a.endpoint.groupId===a.groupId&&validArtifactRefV2(a.ref)&&integer(a.bytes)&&a.bytes<=8388608&&
    ['READ','WRITE'].includes(a.operation)&&a.requesterHolderId!==a.endpoint.holderInstanceId&&
    a.senderHolderId===(a.operation==='WRITE'?a.requesterHolderId:a.endpoint.holderInstanceId)&&
    a.receiverHolderId===(a.operation==='READ'?a.requesterHolderId:a.endpoint.holderInstanceId)&&
    hash(a.proofHash)&&integer(a.issuedAt)&&integer(a.expiresAt)&&a.expiresAt>a.issuedAt&&a.expiresAt-a.issuedAt<=60000;
}
/** Only a trusted coordinator policy adapter may call this after task/App authorization. */
export function signTransfer(authorization:TransferAuthorization,key:string):SignedTransfer {
  if(!validTransferAuthorization(authorization))throw Error('TRANSFER_AUTHORIZATION_INVALID');
  return {authorization:structuredClone(authorization),signature:sign('sha256',Buffer.from(canonical(authorization)),key).toString('base64')};
}
export function verifyTransfer(value:SignedTransfer,certificate:string,domain:string,now:number):TransferAuthorization {
  if(!Number.isFinite(now)||!exact(value,['authorization','signature'])||!validTransferAuthorization(value.authorization)||typeof value.signature!=='string'||
    !/^[A-Za-z0-9+/]{1,2048}={0,2}$/.test(value.signature)||value.authorization.domain!==domain||
    value.authorization.issuedAt>now||value.authorization.expiresAt<=now||
    !verify('sha256',Buffer.from(canonical(value.authorization)),new X509Certificate(certificate).publicKey,Buffer.from(value.signature,'base64')))throw Error('TRANSFER_AUTHORIZATION_INVALID');
  return structuredClone(value.authorization);
}

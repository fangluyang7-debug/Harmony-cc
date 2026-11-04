import { util } from '@kit.ArkTS';
import { common } from '@kit.AbilityKit';
import { http } from '@kit.NetworkKit';
import { NativeTransport, TrustedCoordinator, bytes, text, hash, base64, monotonic } from '../platform/NativeTransport';
import { NativeTransferGrant } from '../platform/NativeTransferGrant';
import { SdkPort, SdkTicket, SdkInput, SdkClock } from './SchedulerSdk';
interface AppExchange {credential:string;}
interface AppCode {registrationId:string;code:string;}
interface DirectFailure {endpointId:string;endpointEpoch:string;reason:string;}
interface DirectObservation {authorizationId:string;durationMs:number;}
interface DirectReceipt {authorizationId:string;contentHash:string;bytes:number;}
interface DirectRequest {attemptId:string;endpointId:string;operation:string;}
/** Native adapter shared by SDK consumers. It has no dependency on agent or its journal. */
export class HarmonySdkPort implements SdkPort {
 private readonly clockDomainId:string=util.generateRandomUUID(true);
 measure():SdkClock{return {clockDomainId:this.clockDomainId,milliseconds:monotonic()};}
 localRead?: (contentHash:string)=>Promise<Uint8Array|null>;
 connected?:()=>boolean;
 stageInput?: (input:SdkInput,data:Uint8Array)=>Promise<void>;
 private transport:NativeTransport;
 private context:common.UIAbilityContext;
 private constructor(transport:NativeTransport,context:common.UIAbilityContext){this.transport=transport;this.context=context;}
 static async open(context:common.UIAbilityContext,trust:TrustedCoordinator,credential:string=''):Promise<HarmonySdkPort>{
  const transport=new NativeTransport(trust,context);await transport.initialize();transport.credential=credential;return new HarmonySdkPort(transport,context);
 }
 async exchange(registrationId:string,code:string):Promise<string>{
  const body:AppCode={registrationId,code},result=text(await this.transport.request('/v2/apps/exchange',body)),exchange=JSON.parse(result) as AppExchange;
  if(!/^[A-Za-z0-9_-]{43}$/.test(exchange.credential))throw Error('SDK_CREDENTIAL_INVALID');this.transport.credential=exchange.credential;return result;
 }
 async request(route:string,body:string|null):Promise<string>{return text(await this.transport.request(route,body===null?null:JSON.parse(body) as Object));}
 private route(ticket:SdkTicket):string{if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(ticket.ref.artifactId)||ticket.ref.contentVersion!==1)throw Error('SDK_TICKET_INVALID');return '/v2/artifacts/'+ticket.ref.artifactId+'/'+ticket.ref.contentVersion;}
 private headers(ticket:SdkTicket):Record<string,string>{return {'Authorization':'Bearer '+ticket.token,'X-Device-Credential':this.transport.credential,'Content-Type':'application/octet-stream'};}
 async write(ticket:SdkTicket,data:Uint8Array):Promise<void>{
  if(ticket.direct){await this.writeDirect(ticket.direct.jobId,ticket.direct.endpointId,ticket,data);return;}
  if(ticket.operation!=='WRITE'||data.byteLength!==ticket.bytes||hash(data)!==ticket.ref.contentHash)throw Error('SDK_INPUT_INTEGRITY');
  await this.transport.request(this.route(ticket),null,http.RequestMethod.PUT,this.headers(ticket),data.slice());
 }
 async writeDirect(jobId:string,endpointId:string,ticket:SdkTicket,data:Uint8Array):Promise<void>{
  if(data.byteLength!==ticket.bytes||hash(data)!==ticket.ref.contentHash)throw Error('SDK_INPUT_INTEGRITY');
  let endpointEpoch='';
  try{
   const request:DirectRequest={attemptId:jobId,endpointId,operation:'WRITE'};
   const grant=JSON.parse(text(await this.transport.request('/v2/data/authorizations',request))) as NativeTransferGrant;
   const a=grant.signed.authorization;
   if(!this.transport.verifyPayload(a,grant.signed.signature)||a.version!==1||a.attemptId!==jobId||a.endpoint.id!==endpointId||a.operation!=='WRITE'||
     a.ref.artifactId!==ticket.ref.artifactId||a.ref.contentVersion!==ticket.ref.contentVersion||a.ref.contentHash!==ticket.ref.contentHash||a.ref.schemaId!==ticket.ref.schemaId||a.ref.schemaVersion!==ticket.ref.schemaVersion||a.bytes!==ticket.bytes||
     a.expiresAt<=this.transport.now()||a.issuedAt>this.transport.now()+1000||a.expiresAt-a.issuedAt>60000||hash(bytes(grant.proof))!==a.proofHash)throw Error('SDK_DIRECT_SCOPE');
   const trust:TrustedCoordinator={address:a.endpoint.address,certificate:a.endpoint.certificate,fingerprint:a.endpoint.fingerprint};
   const peer=new NativeTransport(trust,this.context);await peer.initialize();
   const encoded=base64.encodeToStringSync(bytes(JSON.stringify(grant.signed))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
   const header:Record<string,string>={'Authorization':'Transfer '+encoded,'X-Transfer-Proof':grant.proof,'Content-Type':'application/octet-stream','Content-Length':String(data.byteLength)};
   endpointEpoch=a.endpoint.epoch;
   const started=monotonic();await peer.request('/v2/direct/'+a.id,null,http.RequestMethod.PUT,header,data.slice());
   const observation:DirectObservation={authorizationId:a.id,durationMs:Math.max(1,monotonic()-started)};
   try{await this.transport.request('/v2/data/observations',observation);}catch(e){/* Observation failure does not undo the verified transfer. */}
  }catch(e){
   const message=(e as Error).message,reason=/TLS|CERTIFICATE/.test(message)?'TLS_MISMATCH':/TIMEOUT/.test(message)?'TIMEOUT':'PEER_UNREACHABLE';
   if(endpointEpoch!==''){const failure:DirectFailure={endpointId,endpointEpoch,reason};try{await this.transport.request('/v2/data/network/failure',failure);}catch(f){await this.transport.request('/v2/data/network/reset',{} as Record<string,Object>);}}else await this.transport.request('/v2/data/network/reset',{} as Record<string,Object>);
   const relay:SdkTicket={token:ticket.token,ref:ticket.ref,bytes:ticket.bytes,expiresAt:ticket.expiresAt,operation:ticket.operation};
   await this.write(relay,data);
  }
 }
 async read(ticket:SdkTicket):Promise<Uint8Array>{
  if(ticket.operation!=='READ')throw Error('SDK_TICKET_INVALID');const local=await this.localRead?.(ticket.ref.contentHash);if(local)return local;
  if(ticket.direct){
   try{
    const request:DirectRequest={attemptId:ticket.direct.jobId,endpointId:ticket.direct.endpointId,operation:'READ'};
    const grant=JSON.parse(text(await this.transport.request('/v2/data/authorizations',request))) as NativeTransferGrant,a=grant.signed.authorization;
    if(!this.transport.verifyPayload(a,grant.signed.signature)||a.version!==1||a.attemptId!==ticket.direct.jobId||a.endpoint.id!==ticket.direct.endpointId||a.operation!=='READ'||
      a.ref.artifactId!==ticket.ref.artifactId||a.ref.contentVersion!==ticket.ref.contentVersion||a.ref.contentHash!==ticket.ref.contentHash||a.ref.schemaId!==ticket.ref.schemaId||a.ref.schemaVersion!==ticket.ref.schemaVersion||a.bytes!==ticket.bytes||
      a.expiresAt<=this.transport.now()||a.issuedAt>this.transport.now()+1000||a.expiresAt-a.issuedAt>60000||hash(bytes(grant.proof))!==a.proofHash)throw Error('SDK_DIRECT_SCOPE');
    const trust:TrustedCoordinator={address:a.endpoint.address,certificate:a.endpoint.certificate,fingerprint:a.endpoint.fingerprint};
    const peer=new NativeTransport(trust,this.context);await peer.initialize();
    const encoded=base64.encodeToStringSync(bytes(JSON.stringify(grant.signed))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
    const header:Record<string,string>={'Authorization':'Transfer '+encoded,'X-Transfer-Proof':grant.proof};
    const started=monotonic(),result=await peer.request('/v2/direct/'+a.id,null,http.RequestMethod.GET,header),durationMs=Math.max(1,monotonic()-started);
    if(result.byteLength!==ticket.bytes||hash(result)!==ticket.ref.contentHash)throw Error('SDK_OUTPUT_INTEGRITY');
    const receipt:DirectReceipt={authorizationId:a.id,contentHash:a.ref.contentHash,bytes:a.bytes};await this.transport.request('/v2/data/receipts',receipt);
    const observation:DirectObservation={authorizationId:a.id,durationMs};try{await this.transport.request('/v2/data/observations',observation);}catch(e){/* Best effort telemetry. */}
    return result;
   }catch(e){await this.transport.request('/v2/data/network/reset',{} as Record<string,Object>);}
  }
  return this.transport.request(this.route(ticket),null,http.RequestMethod.GET,this.headers(ticket));
 }
 async digest(data:Uint8Array):Promise<string>{return hash(data);}
 now():number{return Date.now();}
 async wait(ms:number):Promise<void>{await new Promise<void>(resolve=>{setTimeout(resolve,ms);});}
}

import { util } from '@kit.ArkTS';
import { CoordinatorPairing, NativePairRequest } from './CoordinatorPairing';
import { CoordinatorCertificate } from './CoordinatorCertificate';
import { CoordinatorHttpRequest } from './CoordinatorHttpParser';
import { CoordinatorHttpResponse } from './CoordinatorTlsServer';
import { CoordinatorPeer, CoordinatorCredentials } from './CoordinatorCredentials';
import { CoordinatorAllotments, CoordinatorGrantRequest } from './CoordinatorAllotments';
import { AllotmentAckV2 } from '../protocol/ResourcesV2';
import { CoordinatorDeviceSettings, CoordinatorMeasuredCapacity, CoordinatorContribution } from './CoordinatorDeviceSettings';
interface SettingsRequest {measured?:CoordinatorMeasuredCapacity;}
interface SettingsResponse {settings:CoordinatorContribution|null;}
interface SignedAck {ack:AllotmentAckV2;signature:string;}
interface OkResponse {ok:boolean;}
interface LiveResponse {live:boolean;}
interface PairResponse {credential:string;peer:CoordinatorPeer;epoch:number;}
interface ErrorResponse {message:string;}
interface ReadyResponse {ready:boolean;error:string;}
interface InviteRequest {inviteId:string;code:string;}
interface CodeRequest {code:string;}
function json(status:number,body:Object):CoordinatorHttpResponse{return {status,body:JSON.stringify(body)};}
function exact(body:Object,required:string[],optional:string[]=[]):void{
 if(body===null||typeof body!=='object'||Array.isArray(body)||required.some(key=>!Object.keys(body).includes(key))||Object.keys(body).some(key=>!required.includes(key)&&!optional.includes(key)))throw Error('REQUEST_INVALID');
}
/** HTTP surface retains the desktop endpoint names and response shapes. */
export class CoordinatorRoutes {
 private pairing:CoordinatorPairing;
 private identity:CoordinatorCertificate;
 private address:string;
 private epoch:number;
 private credentials:CoordinatorCredentials|null=null;
 private allotments:CoordinatorAllotments|null=null;
 private deviceSettings:CoordinatorDeviceSettings|null=null;
 installDeviceSettings(settings:CoordinatorDeviceSettings):void{this.deviceSettings=settings;}
 installAllotments(credentials:CoordinatorCredentials,allotments:CoordinatorAllotments):void{this.credentials=credentials;this.allotments=allotments;}
 constructor(pairing:CoordinatorPairing,identity:CoordinatorCertificate,address:string,epoch:number){this.pairing=pairing;this.identity=identity;this.address=address;this.epoch=epoch;}
 async handle(request:CoordinatorHttpRequest):Promise<CoordinatorHttpResponse>{
  if(request.method==='GET'&&request.path==='/v2/health/live'){const response:LiveResponse={live:true};return json(200,response);}
  if(request.method==='GET'&&request.path==='/v2/pairing/certificate')return {status:200,body:this.identity.certificate,contentType:'application/x-pem-file'};
  if(request.method==='POST'&&request.path==='/v2/device-settings'&&this.credentials!==null&&this.deviceSettings!==null){
   try{if(!request.authorization.startsWith('Bearer '))throw Error('CREDENTIAL_REQUIRED');const peer=await this.credentials.authenticateDevice(request.authorization.slice(7)),body=JSON.parse(util.TextDecoder.create('utf-8').decodeToString(request.body)) as SettingsRequest;exact(body,[],['measured']);const response:SettingsResponse={settings:await this.deviceSettings.read(peer,body.measured)};return json(200,response);}
   catch(e){const response:ErrorResponse={message:'DEVICE_SETTINGS_REJECTED'};return json(401,response);}
  }
  if(request.method==='POST'&&['/v2/allotments/request','/v2/allotments/ack'].includes(request.path)&&this.credentials!==null&&this.allotments!==null){
   try{
    if(!request.authorization.startsWith('Bearer '))throw Error('CREDENTIAL_REQUIRED');const peer=await this.credentials.authenticateDevice(request.authorization.slice(7));
    const body=JSON.parse(util.TextDecoder.create('utf-8').decodeToString(request.body)) as Object;
    if(request.path==='/v2/allotments/request'){exact(body,['ledgerEpoch','leaseRequestId','leaseMs','base','extra']);return json(200,await this.allotments.issue(peer,body as CoordinatorGrantRequest));}
    exact(body,['ack','signature']);const signed=body as SignedAck;await this.allotments.acknowledge(peer,signed.ack,signed.signature);const response:OkResponse={ok:true};return json(200,response);
   }catch(e){const response:ErrorResponse={message:'ALLOTMENT_REJECTED'};return json(401,response);}
  }
  if(request.method==='POST'&&['/v2/pairing/bootstrap','/v2/pairing/code','/v2/pair'].includes(request.path)){
   try{
    const body=JSON.parse(util.TextDecoder.create('utf-8').decodeToString(request.body)) as Object;
    if(request.path==='/v2/pairing/bootstrap'){exact(body,['inviteId','code']);const input=body as InviteRequest;return json(200,await this.pairing.readDeviceInvite(input.inviteId,input.code,this.address));}
    if(request.path==='/v2/pairing/code'){exact(body,['code']);return json(200,await this.pairing.redeemPairingCode((body as CodeRequest).code,this.address,request.remoteAddress??'unknown'));}
    exact(body,['inviteId','code','holderInstanceId'],['installationId','previousDeviceId','knownDeviceIds']);const input=body as NativePairRequest;
    const paired=await this.pairing.exchange(input.inviteId,input.code,input.holderInstanceId,input.installationId,input.previousDeviceId,input.knownDeviceIds??[]);
    const response:PairResponse={credential:paired.credential,peer:paired.peer,epoch:this.epoch};return json(200,response);
   }catch(e){const message=(e as Error).message;const response:ErrorResponse={message:message==='SPACE_SWITCH_BUSY'?message:'PAIRING_REJECTED'};return json(message==='SPACE_SWITCH_BUSY'?409:401,response);}
  }
  const response:ReadyResponse={ready:false,error:'COORDINATOR_MIGRATION_IN_PROGRESS'};return json(503,response);
 }
}

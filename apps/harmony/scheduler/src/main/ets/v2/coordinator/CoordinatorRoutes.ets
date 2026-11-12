import { util } from '@kit.ArkTS';
import { CoordinatorPairing, NativePairRequest } from './CoordinatorPairing';
import { CoordinatorCertificate } from './CoordinatorCertificate';
import { CoordinatorHttpRequest } from './CoordinatorHttpParser';
import { CoordinatorHttpResponse } from './CoordinatorTlsServer';
import { CoordinatorPeer, CoordinatorCredentials } from './CoordinatorCredentials';
import { CoordinatorAllotments, CoordinatorGrantRequest } from './CoordinatorAllotments';
import { AllotmentAckV2 } from '../protocol/ResourcesV2';
import { CoordinatorDeviceSettings, CoordinatorMeasuredCapacity, CoordinatorContribution } from './CoordinatorDeviceSettings';
import { CoordinatorApps, CoordinatorAppInput } from './CoordinatorApps';
import { CoordinatorDirectory } from './CoordinatorDirectory';
import { CoordinatorActivity, AppActivity } from './CoordinatorActivity';
import { DeviceProfileV2 } from '../protocol/ResourcesV2';
interface ProfilesResponse {profiles:DeviceProfileV2[];}
interface SettingsRequest {measured?:CoordinatorMeasuredCapacity;}
interface SettingsResponse {settings:CoordinatorContribution|null;}
interface SignedAck {ack:AllotmentAckV2;signature:string;}
interface AcknowledgedResponse {acknowledged:boolean;}
interface OkResponse {ok:boolean;}
interface LiveResponse {live:boolean;}
interface PairResponse {credential:string;peer:CoordinatorPeer;epoch:number;}
interface ErrorResponse {message:string;}
interface ReadyResponse {ready:boolean;error:string;}
interface InviteRequest {inviteId:string;code:string;}
interface CodeRequest {code:string;}
interface IdentityResponse {version:number;coordinatorId:string;epoch:number;domain:string;}
interface ProbeRequest {mode:string;bytes:number;padding?:string;}
interface ProbeResponse {relayId:string;padding:string;}
interface AppExchangeRequest {registrationId:string;code:string;}
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
 private coordinatorId:string='';
 private apps:CoordinatorApps|null=null;
 private directory:CoordinatorDirectory|null=null;
 private activity:CoordinatorActivity|null=null;
 installActivity(activity:CoordinatorActivity):void{this.activity=activity;}
 installDirectory(directory:CoordinatorDirectory):void{this.directory=directory;}
 installApps(apps:CoordinatorApps):void{this.apps=apps;}
 installIdentity(id:string):void{this.coordinatorId=id;}
 installDeviceSettings(settings:CoordinatorDeviceSettings):void{this.deviceSettings=settings;}
 installAllotments(credentials:CoordinatorCredentials,allotments:CoordinatorAllotments):void{this.credentials=credentials;this.allotments=allotments;}
 constructor(pairing:CoordinatorPairing,identity:CoordinatorCertificate,address:string,epoch:number){this.pairing=pairing;this.identity=identity;this.address=address;this.epoch=epoch;}
 async handle(request:CoordinatorHttpRequest):Promise<CoordinatorHttpResponse>{
  if(request.method==='GET'&&request.path==='/v2/health/live'){const response:LiveResponse={live:true};return json(200,response);}
  if(request.method==='GET'&&request.path==='/v2/identity'&&this.coordinatorId){const response:IdentityResponse={version:2,coordinatorId:this.coordinatorId,epoch:this.epoch,domain:'REAL'};return json(200,response);}
  if(request.method==='GET'&&request.path==='/v2/pairing/certificate')return {status:200,body:this.identity.certificate,contentType:'application/x-pem-file'};
  if(request.method==='POST'&&request.path==='/v2/apps/me/activity'&&this.activity!==null&&this.credentials!==null){
   try{
    if(!request.authorization.startsWith('Bearer '))throw Error('CREDENTIAL_REQUIRED');
    const peer=await this.credentials.authenticate(request.authorization.slice(7));
    await this.activity.report(peer,JSON.parse(util.TextDecoder.create('utf-8').decodeToString(request.body)) as AppActivity);
    const response:OkResponse={ok:true};return json(200,response);
   }catch(e){const response:ErrorResponse={message:'APP_ACTIVITY_REJECTED'};return json(400,response);}
  }
  if(request.method==='GET'&&request.path==='/v2/devices'&&this.directory!==null&&this.credentials!==null){
   try{
    if(!request.authorization.startsWith('Bearer '))throw Error('CREDENTIAL_REQUIRED');
    const peer=await this.credentials.authenticate(request.authorization.slice(7));
    const response:ProfilesResponse={profiles:await this.directory.profiles(peer.groupId)};return json(200,response);
   }catch(e){const response:ErrorResponse={message:'CREDENTIAL_REJECTED'};return json(401,response);}
  }
  if(this.apps!==null&&this.credentials!==null&&['/v2/apps/registrations','/v2/apps/exchange','/v2/apps/me','/v2/apps/me/performance'].includes(request.path)){
   try{
    if(request.method==='POST'&&request.path==='/v2/apps/exchange'){
     const input=JSON.parse(util.TextDecoder.create('utf-8').decodeToString(request.body)) as AppExchangeRequest;exact(input,['registrationId','code']);return json(200,await this.apps.exchange(input.registrationId,input.code));
    }
    if(!request.authorization.startsWith('Bearer '))throw Error('CREDENTIAL_REQUIRED');const peer=await this.credentials.authenticate(request.authorization.slice(7));
    if(request.method==='GET'&&request.path==='/v2/apps/me')return json(200,await this.apps.context(peer));
    if(request.method==='POST'&&request.path==='/v2/apps/me/performance')return json(200,await this.apps.performance(peer));
    if(request.method==='POST'&&request.path==='/v2/apps/registrations')return json(200,await this.apps.register(peer,JSON.parse(util.TextDecoder.create('utf-8').decodeToString(request.body)) as CoordinatorAppInput));
   }catch(e){const message=(e as Error).message,response:ErrorResponse={message:/^[A-Z][A-Z0-9_]{0,99}$/.test(message)?message:'APP_REQUEST_INVALID'};return json(message.startsWith('CREDENTIAL_')?401:400,response);}
  }
  if(request.method==='POST'&&request.path==='/v2/link-probe'&&this.credentials!==null){
   try{if(!request.authorization.startsWith('Bearer '))throw Error('CREDENTIAL_REQUIRED');await this.credentials.authenticate(request.authorization.slice(7));}catch(e){const response:ErrorResponse={message:'CREDENTIAL_REJECTED'};return json(401,response);}
   try{const body=JSON.parse(util.TextDecoder.create('utf-8').decodeToString(request.body)) as ProbeRequest;exact(body,['mode','bytes'],['padding']);
    if(!['upload','download'].includes(body.mode)||!Number.isSafeInteger(body.bytes)||body.bytes<1||body.bytes>32768||
      (body.mode==='upload'?(typeof body.padding!=='string'||body.padding.length!==body.bytes||!/^x+$/.test(body.padding)):body.padding!==undefined))throw Error('PROBE_INVALID');
    const response:ProbeResponse={relayId:this.coordinatorId,padding:body.mode==='download'?'x'.repeat(body.bytes):''};return json(200,response);
   }catch(e){const response:ErrorResponse={message:'PROBE_INVALID'};return json(400,response);}
  }
  if(request.method==='POST'&&request.path==='/v2/device-settings'&&this.credentials!==null&&this.deviceSettings!==null){
   try{if(!request.authorization.startsWith('Bearer '))throw Error('CREDENTIAL_REQUIRED');const peer=await this.credentials.authenticate(request.authorization.slice(7)),body=JSON.parse(util.TextDecoder.create('utf-8').decodeToString(request.body)) as SettingsRequest;exact(body,[],['measured']);const response:SettingsResponse={settings:await this.deviceSettings.read(peer,body.measured)};return json(200,response);}
   catch(e){const response:ErrorResponse={message:'DEVICE_SETTINGS_REJECTED'};return json(401,response);}
  }
  if(request.method==='POST'&&['/v2/allotments/request','/v2/allotments/ack'].includes(request.path)&&this.credentials!==null&&this.allotments!==null){
   try{
    if(!request.authorization.startsWith('Bearer '))throw Error('CREDENTIAL_REQUIRED');const peer=await this.credentials.authenticate(request.authorization.slice(7));
    const body=JSON.parse(util.TextDecoder.create('utf-8').decodeToString(request.body)) as Object;
    if(request.path==='/v2/allotments/request'){exact(body,['ledgerEpoch','leaseRequestId','leaseMs','base','extra']);return json(200,await this.allotments.issue(peer,body as CoordinatorGrantRequest));}
    exact(body,['ack','signature']);const signed=body as SignedAck;await this.allotments.acknowledge(peer,signed.ack,signed.signature);const response:AcknowledgedResponse={acknowledged:true};return json(200,response);
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

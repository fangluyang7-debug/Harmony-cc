import { util } from '@kit.ArkTS';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import cert from '@ohos.security.cert';
import { http, webSocket } from '@kit.NetworkKit';
import { fileIo } from '@kit.CoreFileKit';
import { relationalStore } from '@kit.ArkData';
import { common } from '@kit.AbilityKit';
import { systemDateTime } from '@kit.BasicServicesKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { AgentPersistenceV2, AgentMessageFactoryV2, AllotmentGrantV2, ResourceAmountV2, canonical } from 'scheduler';
export const bytes=(text:string):Uint8Array=>new util.TextEncoder().encodeInto(text);
export const text=(data:Uint8Array):string=>util.TextDecoder.create('utf-8').decodeToString(data);
export const base64=new util.Base64Helper();
export const hex=(data:Uint8Array):string=>Array.from(data).map(n=>n.toString(16).padStart(2,'0')).join('');
export function hash(data:Uint8Array):string {const md=cryptoFramework.createMd('SHA256');md.updateSync({data});return hex(md.digestSync().data);}
export function hashBytes(data:Uint8Array):Uint8Array {const md=cryptoFramework.createMd('SHA256');md.updateSync({data});return md.digestSync().data;}
export const monotonic=():number=>systemDateTime.getUptime(systemDateTime.TimeType.STARTUP,false);
export const factory:AgentMessageFactoryV2={id:()=>util.generateRandomUUID(true),digest:(value:string)=>hash(bytes(value))};
export interface Peer {groupId:string;deviceId:string;holderInstanceId:string;principalId:string;credentialId:string;}
export interface Paired {credential:string;peer:Peer;}
export interface Invitation {version:number;inviteId:string;groupId:string;address:string;certificate:string;fingerprint:string;code:string;expiresAt:number;tlsMode?:string;}
export interface Contribution {ownerMode:string;maxCpuThreads:number;maxMemoryBytes:number;reserveMemoryBytes:number;}
export interface Bootstrap {invitation:Invitation;holderInstanceId:string;domain:string;contribution:Contribution;}
export interface Installation {bootstrap:Bootstrap;paired:Paired;}
export class NativeDatabase {
 private db:relationalStore.RdbStore;
 private static active:NativeDatabase|null=null;
 private constructor(db:relationalStore.RdbStore){this.db=db;}
 static async open(context:common.UIAbilityContext):Promise<NativeDatabase>{
  if(NativeDatabase.active!==null)return NativeDatabase.active;
  const db=await relationalStore.getRdbStore(context,{name:'harmony-agent-v2.db',securityLevel:relationalStore.SecurityLevel.S1});
  await db.executeSql('PRAGMA synchronous=FULL');
  await db.executeSql('CREATE TABLE IF NOT EXISTS installation (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  NativeDatabase.active=new NativeDatabase(db);return NativeDatabase.active;
 }
 async get(key:string):Promise<string|null>{const rows=await this.db.querySql('SELECT value FROM installation WHERE id=?',[key]);try{return rows.goToFirstRow()?rows.getString(0):null;}finally{rows.close();}}
 async put(key:string,value:string):Promise<void>{await this.db.executeSql('INSERT OR REPLACE INTO installation (id,value) VALUES (?,?)',[key,value]);}
 ledger():AgentPersistenceV2 {return {load:()=>this.get('ledger'),commit:(value:string)=>this.put('ledger',value)};}
}
interface UnsignedGrant {allotmentId:string;groupId:string;deviceId:string;holderInstanceId:string;appInstanceId:string|null;ledgerEpoch:number;coordinatorEpoch:number;version:number;base:ResourceAmountV2[];extra:ResourceAmountV2[];leaseRequestId:string;leaseMs:number;}
export class NativeTransport {
 private address:string;
 private certificate:string;
 private fingerprint:string;
 private caPath:string;
 credential='';
 offset=0;
 private key:cryptoFramework.PubKey|null=null;
 constructor(invitation:Invitation,context:common.UIAbilityContext){
  this.address=invitation.address.replace(/\/$/,'');this.certificate=invitation.certificate;this.fingerprint=invitation.fingerprint;
  if(!/^https:\/\/[A-Za-z0-9.:-]+$/.test(this.address)||!/^[a-f0-9]{64}$/.test(this.fingerprint))throw Error('INVITATION_TRUST_INVALID');
  this.caPath=context.filesDir+'/coordinator.pem';
 }
 async initialize():Promise<void>{
  const certificate=await cert.createX509Cert({data:bytes(this.certificate),encodingFormat:cert.EncodingFormat.FORMAT_PEM});
  const encoded=await certificate.getEncoded();
  if(hash(encoded.data)!==this.fingerprint)throw Error('CERTIFICATE_PIN_MISMATCH');
  // The LAN coordinator generates RSA-3072 identities. Convert the certificate key to
  // a CryptoFramework key of the matching size before verifying signed grants.
  const publicKey=certificate.getPublicKey();this.key=(await cryptoFramework.createAsyKeyGenerator('RSA3072').convertKey(publicKey.getEncoded(),null)).pubKey;const f=fileIo.openSync(this.caPath,fileIo.OpenMode.CREATE|fileIo.OpenMode.WRITE_ONLY|fileIo.OpenMode.TRUNC);
  try{fileIo.writeSync(f.fd,this.certificate);}finally{fileIo.closeSync(f);}
 }
 async request(route:string,body:Object|null=null,method:http.RequestMethod=body===null?http.RequestMethod.GET:http.RequestMethod.POST,headers:Record<string,string>|null=null,binary:Uint8Array|null=null):Promise<Uint8Array>{
  if(!/^\/v2\/[A-Za-z0-9_.:/-]+$/.test(route))throw Error('CONTROL_ROUTE_INVALID');
  const request=http.createHttp(),header:Record<string,string>=headers??{'Content-Type':'application/json','Authorization':'Bearer '+this.credential};
  try{
   const result=await request.request(this.address+route,{method,header,caPath:this.caPath,expectDataType:http.HttpDataType.ARRAY_BUFFER,connectTimeout:10000,readTimeout:10000,usingCache:false,extraData:binary===null?(body===null?'':JSON.stringify(body)):binary.buffer});
   const data=typeof result.result==='string'?bytes(result.result):new Uint8Array(result.result as ArrayBuffer);
   if(data.byteLength>8388608)throw Error('CONTROL_RESPONSE_TOO_LARGE');
   const date=(result.header as Record<string,string>)['date'];const serverTime=Date.parse(date??'');if(Number.isFinite(serverTime))this.offset=serverTime-Date.now();
   if(result.responseCode!==200&&result.responseCode!==201){let code='HTTP_'+result.responseCode;try{const error=JSON.parse(text(data)) as Record<string,string>;if(/^[A-Z_]+$/.test(error['message']))code=error['message'];}catch(e){}throw Error(code);}
   return data;
  }catch(e){if((e as BusinessError).code===2300060)throw Error('TLS_CERTIFICATE_REJECTED');throw e as Error;}finally{request.destroy();}
 }
 async json(route:string,body:Object|null=null):Promise<Object>{return JSON.parse(text(await this.request(route,body))) as Object;}
 async connect(socket:webSocket.WebSocket):Promise<void>{
  // The native connect promise means connection initiated; only the open event permits send.
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('CHANNEL_OPEN_TIMEOUT')),10000);socket.on('open',()=>{clearTimeout(timer);resolve();});void socket.connect(this.address.replace('https:','wss:')+'/v2/channel',{caPath:this.caPath,header:{'Authorization':'Bearer '+this.credential}}).catch((e:Error)=>{clearTimeout(timer);reject(e);});});
 }
 verify(grant:AllotmentGrantV2):boolean {
  if(this.key===null)throw Error('CERTIFICATE_NOT_INITIALIZED');
  const unsigned:UnsignedGrant={allotmentId:grant.allotmentId,groupId:grant.groupId,deviceId:grant.deviceId,holderInstanceId:grant.holderInstanceId,appInstanceId:grant.appInstanceId,ledgerEpoch:grant.ledgerEpoch,coordinatorEpoch:grant.coordinatorEpoch,version:grant.version,base:grant.base,extra:grant.extra,leaseRequestId:grant.leaseRequestId,leaseMs:grant.leaseMs};
  const verify=cryptoFramework.createVerify('RSA3072|PKCS1|SHA256');verify.initSync(this.key);return verify.verifySync({data:bytes(canonical(unsigned))},{data:base64.decodeSync(grant.signature)});
 }
 async ackSignature(ack:Object):Promise<string>{
  const key=await cryptoFramework.createSymKeyGenerator('HMAC|SHA256').convertKey({data:hashBytes(bytes(this.credential))});
  const mac=cryptoFramework.createMac('SHA256');mac.initSync(key);mac.updateSync({data:bytes(canonical(ack))});return base64.encodeToStringSync((await mac.doFinal()).data);
 }
 now():number{return Date.now()+this.offset;}
}

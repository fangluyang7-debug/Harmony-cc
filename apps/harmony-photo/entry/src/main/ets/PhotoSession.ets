import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { HarmonySdkPort, TrustedCoordinator, NativeAgent, Installation, Paired, ResourceAmountV2, SdkTicket, SdkInput, SdkPort, base64, hash, monotonic, factory } from 'scheduler';

interface Registration extends TrustedCoordinator {registrationId:string;code:string;expiresAt:number;domain:string;}
interface Exchange extends Paired {offlineBase:ResourceAmountV2[];onlineExtra:ResourceAmountV2[];}
interface Identity {appInstanceId:string;}
interface AppContext {identity:Identity;deviceCapacity:ResourceAmountV2[];}
interface Manifest {label:string;allowedContracts:string[];}
interface CapabilityCount {capability:string;devices?:number;}
interface CapabilityCounts {capabilities:CapabilityCount[];}
export interface PhotoConnection {address:string;fingerprint:string;groupId:string;deviceId:string;appInstanceId:string;}
const manifest:Manifest={label:'Harmony 图片演示 v1',allowedContracts:['photo.analyze.v1','photo.prepare.v1','photo.enhance.v1','photo.assemble.v1','photo.deliver.v1']};

/** Independent application credentials and foreground executor, like SoleAI. */
export class PhotoSession {
 private context:common.UIAbilityContext|null=null;
 private installation:Installation|null=null;
 private port:HarmonySdkPort|null=null;
 private host:NativeAgent|null=null;
 private foreground=false;
 private changing=false;
 initialize(context:common.UIAbilityContext):void{this.context=context;}
 lifecycle(value:boolean):void{this.foreground=value;this.host?.setForeground(value);}
 async close():Promise<void>{this.foreground=false;await this.host?.close();this.host=null;this.port=null;}
 async prepareLocal():Promise<void>{
  // Do not run unaccounted local inference alongside this App's unsettled v2 work.
  if(this.host){await this.host.pauseForLocal();this.port=null;}
 }
 private async retireHost():Promise<void>{
  if(this.host){await this.host.closeForSwitch();this.host=null;this.port=null;}
 }
 connection():PhotoConnection|null{const i=this.installation;if(!i)return null;return {address:i.bootstrap.invitation.address,fingerprint:i.bootstrap.invitation.fingerprint,groupId:i.paired.peer.groupId,deviceId:i.paired.peer.deviceId,appInstanceId:i.appInstanceId??''};}
 private async activate(i:Installation):Promise<void>{
  if(!this.context)throw Error('APP_CONTEXT_REQUIRED');
  const port=await HarmonySdkPort.open(this.context,i.bootstrap.invitation,i.paired.credential),info=JSON.parse(await port.request('/v2/apps/me',null)) as AppContext;
  if(info.identity.appInstanceId!==i.appInstanceId)throw Error('APP_HOST_IDENTITY_MISMATCH');
  if(this.host&&this.host.displayHolderId()!==i.paired.peer.holderInstanceId){await this.host.closeForSwitch();this.host=null;}
  if(!this.host){this.host=await NativeAgent.start(this.context,null,()=>this.foreground,i);await this.host.enablePerformance();}
  else await this.host.resumeContribution();
  this.installation=i;this.port=await this.host.sdkPort();
 }
 async restore():Promise<boolean>{
  if(!this.context)return false;
  const store=await preferences.getPreferences(this.context,{name:'photo-app-v1'}),raw=await store.get('installation','') as string;
  if(!raw)return false;await this.activate(JSON.parse(raw) as Installation);return true;
 }
 async connect(force:boolean=false,onStatus:(message:string)=>void=()=>{}):Promise<void>{
  if(!this.context||this.changing)throw Error('APP_CONNECT_BUSY');this.changing=true;
  try{
   const context=this.context,store=await preferences.getPreferences(context,{name:'photo-app-v1'});let raw=await store.get('installation','') as string;
   if(raw&&!force){onStatus('正在检查上次的协作连接…');try{await this.activate(JSON.parse(raw) as Installation);onStatus('已连接协作空间');return;}catch(e){
    // A migrated center may no longer answer at the saved address. Settle any
    // previous work before asking the device app to authorize its current space.
    await this.retireHost();await store.put('previousInstallation',raw);
    onStatus('上次连接已不可用，正在请求当前空间授权…');
   }}
   if(force){await this.retireHost();if(raw)await store.put('previousInstallation',raw);}
   if(await store.get('exchangePending',false) as boolean)throw Error('上次授权结果待核对，请勿重复注册');
   onStatus('请在调度连接 App 中点击“允许并返回应用”');
   const result=await context.startAbilityForResult({bundleName:'org.harmonycc.agent',abilityName:'EnrollmentAbility',parameters:{declaration:JSON.stringify(manifest)}}),encoded=result.want?.parameters?.['registration'];
   if(result.resultCode!==0||typeof encoded!=='string')throw Error('图片应用授权已取消');
   onStatus('授权已收到，正在连接当前协作空间…');
   const registration=JSON.parse(encoded) as Registration,port=await HarmonySdkPort.open(context,registration);
   await store.put('exchangePending',true);await store.flush();
   const paired=JSON.parse(await port.exchange(registration.registrationId,registration.code)) as Exchange,info=JSON.parse(await port.request('/v2/apps/me',null)) as AppContext;
   const saved:Installation={appInstanceId:info.identity.appInstanceId,paired,bootstrap:{domain:registration.domain,holderInstanceId:paired.peer.holderInstanceId,invitation:{version:2,inviteId:registration.registrationId,groupId:paired.peer.groupId,address:registration.address,certificate:registration.certificate,fingerprint:registration.fingerprint,code:'',expiresAt:registration.expiresAt},contribution:{ownerMode:'dedicated',maxCpuThreads:info.deviceCapacity.find(r=>r.resourcePoolId==='cpu')!.amount,maxMemoryBytes:info.deviceCapacity.find(r=>r.resourcePoolId==='ram')!.amount,reserveMemoryBytes:0}}};
   await store.put('installation',JSON.stringify(saved));await store.put('exchangePending',false);await store.flush();await this.activate(saved);onStatus('已连接协作空间');
  }finally{this.changing=false;}
 }
 async request(route:string,body:string|null):Promise<string>{if(!this.port)throw Error('PHOTO_APP_NOT_CONNECTED');return this.port.request(route,body);}
 async batchConcurrency():Promise<number>{
  try{
   const view=JSON.parse(await this.request('/v2/apps/me/capabilities',null)) as CapabilityCounts;
   const devices=view.capabilities.find(c=>c.capability==='photo.enhance.v1')?.devices;
   // A small window overlaps input/compute/delivery without submitting the whole batch.
   return devices!==undefined&&Number.isInteger(devices)&&devices>0?Math.min(4,devices+1):2;
  }catch{return 2;} // Older coordinators retain the existing two-image window.
 }
 async pendingReady():Promise<string[]>{
  if(!this.host)throw Error('请先连接协作空间');
  const capabilities=['photo.analyze.v1','photo.prepare.v1','photo.enhance.v1','photo.assemble.v1','photo.deliver.v1'];
  const labels=['照片分析','图块准备','高清增强','图像合成','成品生成'];
  const pending=await this.host.pendingCapabilities(capabilities);
  return pending.map(c=>{const i=capabilities.indexOf(c);return i<0?c:labels[i];});
 }
 async requireReady():Promise<void>{
  const pending=await this.pendingReady();if(pending.length)throw Error('协作尚未就绪：'+pending.join('、')+'。请等待绿色就绪提示后再开始。');
 }
 async waitReady(remaining:()=>number,cancelled:()=>boolean,progress:(message:string)=>void):Promise<void>{
  for(;;){
   if(cancelled())throw Error('已取消');if(remaining()<=0)throw Error('180 秒预算已用尽，设备能力尚未就绪');
   const pending=await this.pendingReady();
   if(cancelled())throw Error('已取消');if(remaining()<=0)throw Error('180 秒预算已用尽，设备能力尚未就绪');
   if(pending.length===0)return;
   progress('正在等待协作能力就绪：'+pending.join('、'));
   await new Promise<void>(resolve=>{setTimeout(resolve,Math.min(1000,Math.max(1,remaining())));});
  }
 }
 workflowPort(cancelled:()=>boolean,capture:()=>Promise<void>):SdkPort{
  if(!this.port)throw Error('PHOTO_APP_NOT_CONNECTED');const port=this.port,domain='photo-native-'+factory.id();
  return {
   request:(route:string,body:string|null):Promise<string>=>this.sdkRequest(route,body),
   write:(ticket:SdkTicket,data:Uint8Array):Promise<void>=>port.write(ticket,data),
   writeDirect:(jobId:string,endpointId:string,ticket:SdkTicket,data:Uint8Array):Promise<void>=>port.writeDirect(jobId,endpointId,ticket,data),
   stageInput:async(input:SdkInput,data:Uint8Array):Promise<void>=>{if(!port.stageInput)throw Error('APP_HOST_REQUIRED');await port.stageInput(input,data);},
   read:async(ticket:SdkTicket):Promise<Uint8Array>=>{
    let data:Uint8Array;try{data=await port.read(ticket);}catch(e){throw Error('PHOTO_OUTPUT_READ: '+(e as Error).message);}
    if(data.length!==ticket.bytes||hash(data)!==ticket.ref.contentHash)throw Error('SDK_OUTPUT_INTEGRITY');
    if(ticket.ref.schemaId==='photo.product')try{await capture();}catch(e){throw Error('PHOTO_DISPLAY_CAPTURE: '+(e as Error).message);}
    return data;
   },
   digest:async(data:Uint8Array):Promise<string>=>hash(data),now:():number=>Date.now(),
   measure:()=>({clockDomainId:domain,milliseconds:monotonic()}),
   wait:async(ms:number):Promise<void>=>{await new Promise<void>(resolve=>{setTimeout(resolve,ms);});},cancelled
  };
 }
 async sdkRequest(route:string,body:string|null):Promise<string>{
  if(!/^\/v2\/sdk\/jobs(?:\/[A-Za-z0-9_.:-]+(?:\/(?:start|received|cancel))?)?$/.test(route))throw Error('PHOTO_SDK_ROUTE');
  if(!this.host?.isConnected())throw Error('手机正在连接或校准，请稍后重试');return this.request(route,body);
 }
 async write(encoded:string,data:string):Promise<void>{if(!this.port)throw Error('PHOTO_APP_NOT_CONNECTED');await this.port.write(JSON.parse(encoded) as SdkTicket,base64.decodeSync(data));}
 async read(encoded:string):Promise<string>{if(!this.port)throw Error('PHOTO_APP_NOT_CONNECTED');return base64.encodeToStringSync(await this.port.read(JSON.parse(encoded) as SdkTicket));}
 matches(url:string,certificate:Uint8Array):boolean{const c=this.connection();return c!==null&&url.startsWith(c.address+'/')&&hash(certificate)===c.fingerprint;}
}
export const photoSession=new PhotoSession();

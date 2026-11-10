import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { util } from '@kit.ArkTS';
import { fileIo } from '@kit.CoreFileKit';
import { HarmonySdkPort, SchedulerSdk, SdkTask, TrustedCoordinator, NativeAgent, Installation, Paired, ResourceAmountV2, DeviceProfileV2, monotonic } from 'scheduler';
export interface ShoppingCapacity {sdk:SchedulerSdk|null;originDevice:string;originTarget:string|null;roundTripMs:number;remoteAvailable:boolean;}
interface Profiles {profiles:DeviceProfileV2[];}
interface Registration extends TrustedCoordinator {registrationId:string;code:string;expiresAt:number;domain:string;}
interface Exchange extends Paired {offlineBase:ResourceAmountV2[];onlineExtra:ResourceAmountV2[];}
interface Resource {resourcePoolId:string;amount:number;}
export interface DeclaredNode {id:string;capability:string;contractId?:string;parameters?:string;effects?:string;privacy?:string;dependsOn:string[];}
export interface WorkflowDeclaration {id:string;capabilities:string[];inputSchema:string;outputContract:string;qualityTarget?:string;alternatives?:WorkflowDeclaration[];nodes:DeclaredNode[];}
interface Declaration {version:number;revision:string;workflows:WorkflowDeclaration[];}
interface AppIdentity {appInstanceId:string;}
interface AppContext {identity:AppIdentity;declaration:Declaration|null;}
interface DisplayMutation {version?:number;text?:string;}
export interface RegistrationRequest {label:string;allowedContracts:string[];maxConcurrent:number;resources:Resource[];offlineBase:Resource[];onlineExtra:Resource[];declaration:Declaration;}
const manifest:RegistrationRequest={label:'SoleAI 日常购物工作流 3',allowedContracts:['image.crop.contract','catalog.filter.v1','image.visual-match.v1'],maxConcurrent:4,
 resources:[{resourcePoolId:'cpu',amount:8},{resourcePoolId:'ram',amount:4294967296}],offlineBase:[],onlineExtra:[{resourcePoolId:'cpu',amount:2},{resourcePoolId:'ram',amount:268435456}],
 declaration:{version:1,revision:'soleai.shopping.3',workflows:[
  {id:'shopping.photo.prepare',capabilities:['image.crop.v1'],inputSchema:'image.raster',outputContract:'image.raster',nodes:[{id:'prepare',capability:'image.crop.v1',contractId:'image.crop.contract',dependsOn:[]}]},
  {id:'shopping.compare',capabilities:['catalog.filter.v1'],inputSchema:'catalog.items',outputContract:'catalog.ranked',nodes:[{id:'compare',capability:'catalog.filter.v1',dependsOn:[]}]},
  {id:'shopping.photo.match',capabilities:['image.visual-match.v1'],inputSchema:'image.visual-bundle',outputContract:'image.visual-evidence',nodes:[{id:'match',capability:'image.visual-match.v1',dependsOn:[]}]}]}};
export interface CapabilityAvailability {capability:string;targets:number;services:number;}
interface CapabilityReply {capabilities?:CapabilityAvailability[];}
class CooperativeSession {
 declaration():RegistrationRequest{return manifest;}
 async capabilities():Promise<CapabilityAvailability[]>{if(!this.port)return [];const reply=JSON.parse(await this.port.request('/v2/apps/me/capabilities',null)) as CapabilityReply;return reply.capabilities??[];}

 private context:common.UIAbilityContext|null=null;
 private sdk:SchedulerSdk|null=null;
 private port:HarmonySdkPort|null=null;
 private preparing=false;
 private active:SdkTask|null=null;
 private changing=false;
 private cancelRequested=false;
 private host:NativeAgent|null=null;
 private foreground=false;
 private restoring:Promise<void>|null=null;
 private originDevice='';
 initialize(context:common.UIAbilityContext):void{this.context=context;AppStorage.setOrCreate('cooperativeEnabled',false);AppStorage.setOrCreate('cooperativeStatus','未连接协作空间 · 正常使用手机购物');AppStorage.setOrCreate('cooperativeChanging',false);AppStorage.setOrCreate('cooperativePreview','');AppStorage.setOrCreate('cooperativeDemoBusy',false);}
 lifecycle(value:boolean):void{this.foreground=value;this.host?.setForeground(value);if(value&&!this.changing)void this.restore().catch(()=>{});}
 async close():Promise<void>{this.foreground=false;await this.host?.close();this.host=null;this.sdk=null;}
 private async activate(installation:Installation):Promise<void>{
  if(!this.context)throw Error('APP_CONTEXT_REQUIRED');
  const port=await HarmonySdkPort.open(this.context,installation.bootstrap.invitation,installation.paired.credential);
  const info=JSON.parse(await port.request('/v2/apps/me',null)) as AppContext;
  if(info.declaration?.revision!==manifest.declaration.revision||info.identity.appInstanceId!==installation.appInstanceId)throw Error('APP_HOST_IDENTITY_MISMATCH');
  if(this.host&&this.host.displayHolderId()!==installation.paired.peer.holderInstanceId){await this.host.closeForSwitch();this.host=null;}
  if(!this.host)this.host=await NativeAgent.start(this.context,null,()=>this.foreground,installation);
  this.port=port;this.sdk=await this.host.sdk();
  this.originDevice=installation.paired.peer.deviceId;
  AppStorage.set('cooperativeEnabled',true);AppStorage.set('cooperativeStatus','已连接空间 · 按任务实际开销自动选择本地或协作');
 }
 async restore():Promise<void>{
  if(this.changing||!this.context||!this.foreground)return;
  if(this.restoring)return this.restoring;
  const context=this.context;
  this.restoring=(async():Promise<void>=>{try{
   const store=await preferences.getPreferences(context,{name:'cooperative-shopping-3'}),raw=await store.get('installation','') as string;
   if(raw)await this.activate(JSON.parse(raw) as Installation);
  }catch(e){AppStorage.set('cooperativeEnabled',false);AppStorage.set('cooperativeStatus','协作连接暂不可用 · 新任务正常使用手机；旧任务不重投');}
  finally{this.restoring=null;}})();return this.restoring;
 }
 enabled():boolean{return AppStorage.get<boolean>('cooperativeEnabled')===true;}
 async capacity():Promise<ShoppingCapacity>{
  const result:ShoppingCapacity={sdk:null,originDevice:this.originDevice,originTarget:null,roundTripMs:0,remoteAvailable:false};
  if(!this.enabled()||!this.port||!this.host?.isConnected()||!this.foreground)return result;
  try{const began=monotonic();await this.port.request('/v2/apps/me',null);const data=JSON.parse(await this.port.request('/v2/devices',null)) as Profiles;result.roundTripMs=Math.max(1,(monotonic()-began)/2);
   for(const profile of data.profiles){if(profile.energyGate||profile.ownerActivity.value!=='IDLE'||profile.foreground.sampledAt+profile.foreground.ttlMs<=Date.now())continue;
    const executor=profile.executors.find(e=>e.contract.capability==='image.visual-match.v1');if(!executor)continue;
    const available=profile.pools.some(pool=>pool.kind==='CPU_SLOTS'&&(pool.admissionLimit.value??0)>=1);if(!available)continue;
    if(profile.holderInstanceId===this.host.displayHolderId())result.originTarget=executor.target.targetId;
    else if(profile.deviceId!==this.originDevice)result.remoteAvailable=true;
   }result.sdk=this.sdk;
  }catch(e){AppStorage.set('cooperativeEnabled',false);AppStorage.set('cooperativeStatus','空间已断开或不可用 · 本次新计算使用手机');}
  return result;
 }
 client():SchedulerSdk{if(!this.enabled()||!this.sdk)throw Error('请先开启协同调度');return this.sdk;}
 async displayInvite(viewerHolderId:string):Promise<Object>{
  if(!this.enabled()||!this.port)throw Error('请先开启协同调度');
  return JSON.parse(await this.port.request('/v2/display',JSON.stringify({viewerHolderId,leaseMs:300000}))) as Object;
 }
 async displaySession(id:string,action:string='',body:DisplayMutation={}):Promise<Object>{
  if(!this.port||!/^[a-zA-Z0-9-]{1,100}$/.test(id)||!['','publish','revoke'].includes(action))throw Error('DISPLAY_ROUTE_INVALID');
  return JSON.parse(await this.port.request('/v2/display/'+id+(action?'/'+action:''),action?JSON.stringify(body):null)) as Object;
 }
 async availableClient():Promise<SchedulerSdk|null>{
  if(!this.enabled()||!this.port||!this.host?.isConnected()||!this.foreground)return null;
  try{await this.port.request('/v2/apps/me',null);return this.enabled()?this.sdk:null;}
  catch(e){AppStorage.set('cooperativeEnabled',false);AppStorage.set('cooperativeStatus','协调中心不可用，新任务使用原业务路径；已提交任务不重投');return null;}
 }
 async setEnabled(value:boolean):Promise<void>{
  if(this.changing)return;if(!this.context)throw Error('APP_CONTEXT_REQUIRED');
  if(!value){AppStorage.set('cooperativeEnabled',false);AppStorage.set('cooperativeStatus','已停止新协同任务，原有任务继续结算');return;}
  this.changing=true;AppStorage.set('cooperativeChanging',true);AppStorage.set('cooperativeStatus','正在连接设备调度件并注册应用');
  try{
   // Only the user-initiated connection action enters the approval UI. Normal jobs never do.
   const context=this.context,store=await preferences.getPreferences(context,{name:'cooperative-shopping-3'});
   let raw=await store.get('installation','') as string;
   if(raw){try{await this.activate(JSON.parse(raw) as Installation);}catch(e){
    // Rebind only after an explicit terminal revocation, never on an ambiguous network failure.
    if(!['APP_CREDENTIAL_REVOKED','CREDENTIAL_REVOKED','DEVICE_LEFT_SPACE','APP_HOST_IDENTITY_MISMATCH'].includes((e as Error).message))throw e as Error;
    await store.put('previousInstallation',raw);raw='';
   }}
   if(!raw){
    if(await store.get('exchangePending',false) as boolean)throw Error('上次注册结果未知，请在协调中心对账后恢复');
    const result=await context.startAbilityForResult({bundleName:'org.harmonycc.agent',abilityName:'EnrollmentAbility',parameters:{declaration:JSON.stringify(manifest)}});
    const encoded=result.want?.parameters?.['registration'];if(result.resultCode!==0||typeof encoded!=='string')throw Error('应用接入已取消');
    const registration=JSON.parse(encoded) as Registration;const port=await HarmonySdkPort.open(context,registration);
    await store.put('exchangePending',true);await store.flush();
    const registered=JSON.parse(await port.exchange(registration.registrationId,registration.code)) as Exchange;
    const info=JSON.parse(await port.request('/v2/apps/me',null)) as AppContext;
    const saved:Installation={appInstanceId:info.identity.appInstanceId,paired:registered,bootstrap:{domain:registration.domain,holderInstanceId:registered.peer.holderInstanceId,
     invitation:{version:2,inviteId:registration.registrationId,groupId:registered.peer.groupId,address:registration.address,certificate:registration.certificate,fingerprint:registration.fingerprint,code:'',expiresAt:registration.expiresAt},
     contribution:{ownerMode:'dedicated',maxCpuThreads:2,maxMemoryBytes:268435456,reserveMemoryBytes:0}}};
    await store.put('installation',JSON.stringify(saved));await store.put('exchangePending',false);await store.flush();
    await this.activate(saved);
   }
  }catch(e){AppStorage.set('cooperativeEnabled',false);AppStorage.set('cooperativeStatus',(e as Error).message);throw e as Error;}
  finally{this.changing=false;AppStorage.set('cooperativeChanging',false);}
 }
 async cancel():Promise<void>{this.cancelRequested=true;if(this.active)await this.active.cancel();}
 async prepareDemoPhoto():Promise<void>{
  if(!this.context||!this.enabled())throw Error('请先开启协同调度');
  if(AppStorage.get<boolean>('cooperativeDemoBusy'))return;
  AppStorage.set('cooperativeDemoBusy',true);AppStorage.set('cooperativePreview','');
  try{
   const data=await this.context.resourceManager.getRawFileContent('cooperative-demo.png'),destination=this.context.cacheDir+'/cooperative-demo.png';
   const file=fileIo.openSync(destination,fileIo.OpenMode.CREATE|fileIo.OpenMode.WRITE_ONLY|fileIo.OpenMode.TRUNC);
   try{if(fileIo.writeSync(file.fd,data.slice().buffer)!==data.byteLength)throw Error('FILE_WRITE_INCOMPLETE');}finally{fileIo.closeSync(file);}
   AppStorage.set('cooperativeStatus','正在提交示例图片预处理，执行设备由调度器选择');
   const result=await this.preparePhoto('file://'+destination);AppStorage.set('cooperativePreview',result);
  }catch(e){AppStorage.set('cooperativeStatus','示例图片处理失败：'+(e as Error).message);throw e as Error;}
  finally{AppStorage.set('cooperativeDemoBusy',false);}
 }
 async preparePhoto(uri:string):Promise<string>{
  if(!this.enabled())return uri;
  if(this.preparing)throw Error('上一条协同图片任务尚未结束');this.preparing=true;this.cancelRequested=false;
  try{
  const sdk=await this.availableClient();if(!sdk)return uri;
  const context=this.context!;
  const file=fileIo.openSync(uri,fileIo.OpenMode.READ_ONLY);let data:Uint8Array;
  try{const size=fileIo.statSync(file.fd).size;if(size<1||size>8388608)throw Error('IMAGE_SIZE_LIMIT');const buffer=new ArrayBuffer(size);if(fileIo.readSync(file.fd,buffer)!==size)throw Error('FILE_READ_INCOMPLETE');data=new Uint8Array(buffer);}finally{fileIo.closeSync(file);}
  const id=util.generateRandomUUID(true),input=await sdk.registerInput(data,'image.raster');
  try{
   if(this.cancelRequested)throw Error('协同任务已取消');
   const task=await sdk.submit({version:3,id,outputContract:'image.raster',qualityTarget:'reference',nodes:[{id:'prepare',capability:'image.crop.v1',input,parameters:'{"box":{"x":0,"y":0,"width":1,"height":1},"paddingRatio":0,"targetSize":1024,"jpegQuality":95}',dependsOn:[]}]},{requestId:id,budgetMs:30000,resultDestination:'ORIGIN'});
   this.active=task;if(this.cancelRequested){await task.cancel();throw Error('协同任务已取消');}
   const result=await task.result();if(this.cancelRequested)throw Error('协同任务已取消');
   const destination=context.cacheDir+'/cooperative-'+id+'.jpg',out=fileIo.openSync(destination,fileIo.OpenMode.CREATE|fileIo.OpenMode.WRITE_ONLY|fileIo.OpenMode.TRUNC);
   try{if(fileIo.writeSync(out.fd,result.output.slice().buffer)!==result.output.byteLength)throw Error('FILE_WRITE_INCOMPLETE');}finally{fileIo.closeSync(out);}
   AppStorage.set('cooperativeStatus','图片预处理完成 · 执行目标 '+result.status.targetId);return 'file://'+destination;
  }finally{this.active=null;sdk.releaseInput(input);}
  }finally{this.preparing=false;}
 }
}
export const cooperative=new CooperativeSession();

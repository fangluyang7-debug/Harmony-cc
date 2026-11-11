import { common } from '@kit.AbilityKit';
import { util } from '@kit.ArkTS';
import { fileIo } from '@kit.CoreFileKit';
import { HarmonySdkPort, SchedulerSdk, SdkTask, NativeAgent, DeviceProfileV2, SchedulerAppSession, SchedulerAppOptions, SchedulerAppStatus, monotonic } from 'scheduler';
export interface ShoppingCapacity {sdk:SchedulerSdk|null;originDevice:string;originTarget:string|null;roundTripMs:number;remoteAvailable:boolean;}
interface Profiles {profiles:DeviceProfileV2[];}
interface Resource {resourcePoolId:string;amount:number;}
export interface DeclaredNode {id:string;capability:string;contractId?:string;parameters?:string;effects?:string;privacy?:string;dependsOn:string[];}
export interface WorkflowDeclaration {id:string;capabilities:string[];inputSchema:string;outputContract:string;qualityTarget?:string;alternatives?:WorkflowDeclaration[];nodes:DeclaredNode[];}
interface Declaration {version:number;revision:string;workflows:WorkflowDeclaration[];}
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
// ArkTS requires object literals to carry a declared type (arkts-no-untyped-obj-literals).
const sessionOptions:SchedulerAppOptions={storeName:'cooperative-shopping-3',declaration:manifest,revision:manifest.declaration.revision};
class CooperativeSession {
 declaration():RegistrationRequest{return manifest;}
 async capabilities():Promise<CapabilityAvailability[]>{if(!this.port)return [];const reply=JSON.parse(await this.port.request('/v2/apps/me/capabilities',null)) as CapabilityReply;return reply.capabilities??[];}

 // Authorization, credential persistence and the in-process NativeAgent live in the shared
 // SchedulerAppSession (scheduler HAR). This class only adds the shopping business logic.
 private session=new SchedulerAppSession(sessionOptions);
 private context:common.UIAbilityContext|null=null;
 private preparing=false;
 private active:SdkTask|null=null;
 private cancelRequested=false;
 private get port():HarmonySdkPort|null{return this.session.port();}
 private get host():NativeAgent|null{return this.session.host();}
 private get sdk():SchedulerSdk|null{return this.session.sdk();}
 private get foreground():boolean{return this.visible;}
 private get originDevice():string{return this.session.deviceId();}
 private visible=false;
 initialize(context:common.UIAbilityContext):void{this.context=context;this.session.initialize(context);AppStorage.setOrCreate('cooperativeEnabled',false);AppStorage.setOrCreate('cooperativeStatus','未连接协作空间 · 正常使用手机购物');AppStorage.setOrCreate('cooperativeChanging',false);AppStorage.setOrCreate('cooperativePreview','');AppStorage.setOrCreate('cooperativeDemoBusy',false);
  this.session.onStatus((s:SchedulerAppStatus)=>{AppStorage.set('cooperativeEnabled',s.state==='CONNECTED');AppStorage.set('cooperativeChanging',s.state==='CONNECTING');
   AppStorage.set('cooperativeStatus',s.state==='CONNECTED'?'已连接空间 · 按任务实际开销自动选择本地或协作':s.message);});}
 /** Foreground automatically restores the identity, or asks the device agent once on first use. */
 lifecycle(value:boolean):void{this.visible=value;this.session.lifecycle(value);}
 async close():Promise<void>{this.visible=false;await this.session.close();}
 enabled():boolean{return this.session.status().state==='CONNECTED';}
 async capacity():Promise<ShoppingCapacity>{
  const result:ShoppingCapacity={sdk:null,originDevice:this.originDevice,originTarget:null,roundTripMs:0,remoteAvailable:false};
  const port=this.port,host=this.host;
  if(!this.enabled()||!port||!host?.isConnected()||!this.foreground)return result;
  try{const began=monotonic();await port.request('/v2/apps/me',null);const data=JSON.parse(await port.request('/v2/devices',null)) as Profiles;result.roundTripMs=Math.max(1,(monotonic()-began)/2);
   for(const profile of data.profiles){if(profile.energyGate||profile.ownerActivity.value!=='IDLE'||profile.foreground.sampledAt+profile.foreground.ttlMs<=Date.now())continue;
    const executor=profile.executors.find(e=>e.contract.capability==='image.visual-match.v1');if(!executor)continue;
    const available=profile.pools.some(pool=>pool.kind==='CPU_SLOTS'&&(pool.admissionLimit.value??0)>=1);if(!available)continue;
    if(profile.holderInstanceId===host.displayHolderId())result.originTarget=executor.target.targetId;
    else if(profile.deviceId!==this.originDevice)result.remoteAvailable=true;
   }result.sdk=this.sdk;
  }catch(e){AppStorage.set('cooperativeEnabled',false);AppStorage.set('cooperativeStatus','空间已断开或不可用 · 本次新计算使用手机');}
  return result;
 }
 client():SchedulerSdk{const sdk=this.sdk;if(!this.enabled()||!sdk)throw Error('协同调度未接入');return sdk;}
 async displayInvite(viewerHolderId:string):Promise<Object>{
  const port=this.port;if(!this.enabled()||!port)throw Error('协同调度未接入');
  return JSON.parse(await port.request('/v2/display',JSON.stringify({viewerHolderId,leaseMs:300000}))) as Object;
 }
 async displaySession(id:string,action:string='',body:DisplayMutation={}):Promise<Object>{
  const port=this.port;if(!port||!/^[a-zA-Z0-9-]{1,100}$/.test(id)||!['','publish','revoke'].includes(action))throw Error('DISPLAY_ROUTE_INVALID');
  return JSON.parse(await port.request('/v2/display/'+id+(action?'/'+action:''),action?JSON.stringify(body):null)) as Object;
 }
 async availableClient():Promise<SchedulerSdk|null>{
  const port=this.port;if(!this.enabled()||!port||!this.host?.isConnected()||!this.foreground)return null;
  try{await port.request('/v2/apps/me',null);return this.enabled()?this.sdk:null;}
  catch(e){AppStorage.set('cooperativeEnabled',false);AppStorage.set('cooperativeStatus','协调中心不可用，新任务使用原业务路径；已提交任务不重投');return null;}
 }
 /** The switch now only pauses/resumes; joining happens automatically in lifecycle(). true also re-asks after a refusal. */
 async setEnabled(value:boolean):Promise<void>{
  if(!value){this.session.pause();return;}
  await this.session.resume();
 }
 async cancel():Promise<void>{this.cancelRequested=true;if(this.active)await this.active.cancel();}
 async prepareDemoPhoto():Promise<void>{
  if(!this.context||!this.enabled())throw Error('协同调度未接入');
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

import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { util } from '@kit.ArkTS';
import { fileIo } from '@kit.CoreFileKit';
import { HarmonySdkPort, SchedulerSdk, SdkTask, TrustedCoordinator } from 'scheduler';
interface Registration extends TrustedCoordinator {registrationId:string;code:string;}
interface Exchange {credential:string;}
interface Saved {trust:TrustedCoordinator;credential:string;}
interface Resource {resourcePoolId:string;amount:number;}
interface DeclaredNode {id:string;capability:string;dependsOn:string[];}
interface WorkflowDeclaration {id:string;capabilities:string[];inputSchema:string;outputContract:string;nodes:DeclaredNode[];}
interface Declaration {version:number;revision:string;workflows:WorkflowDeclaration[];}
interface AppContext {declaration:Declaration|null;}
interface DisplayMutation {version?:number;text?:string;}
interface RegistrationRequest {label:string;allowedContracts:string[];maxConcurrent:number;resources:Resource[];offlineBase:Resource[];onlineExtra:Resource[];declaration:Declaration;}
const manifest:RegistrationRequest={label:'SoleAI 购物',allowedContracts:['image.crop.v1','image.encode.v1'],maxConcurrent:2,
 resources:[{resourcePoolId:'cpu',amount:4},{resourcePoolId:'ram',amount:4294967296},{resourcePoolId:'gpu',amount:1},{resourcePoolId:'vram',amount:8589934592}],offlineBase:[],onlineExtra:[],
 declaration:{version:1,revision:'soleai.image.1',workflows:[
  {id:'shopping.photo.prepare',capabilities:['image.crop.v1'],inputSchema:'image.raster',outputContract:'image.raster',nodes:[{id:'prepare',capability:'image.crop.v1',dependsOn:[]}]},
  {id:'shopping.image.encode',capabilities:['image.encode.v1'],inputSchema:'image.raster',outputContract:'image.embedding',nodes:[{id:'encode',capability:'image.encode.v1',dependsOn:[]}]}]}};
class CooperativeSession {
 private context:common.UIAbilityContext|null=null;
 private sdk:SchedulerSdk|null=null;
 private port:HarmonySdkPort|null=null;
 private preparing=false;
 private active:SdkTask|null=null;
 private changing=false;
 private cancelRequested=false;
 initialize(context:common.UIAbilityContext):void{this.context=context;AppStorage.setOrCreate('cooperativeEnabled',false);AppStorage.setOrCreate('cooperativeStatus','尚未启用协同调度');AppStorage.setOrCreate('cooperativeChanging',false);}
 enabled():boolean{return AppStorage.get<boolean>('cooperativeEnabled')===true;}
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
  if(!this.enabled()||!this.port)return null;
  try{await this.port.request('/v2/apps/me',null);return this.enabled()?this.sdk:null;}
  catch(e){AppStorage.set('cooperativeEnabled',false);AppStorage.set('cooperativeStatus','协调中心不可用，新任务使用原业务路径；已提交任务不重投');return null;}
 }
 async setEnabled(value:boolean):Promise<void>{
  if(this.changing)return;if(!this.context)throw Error('APP_CONTEXT_REQUIRED');
  if(!value){AppStorage.set('cooperativeEnabled',false);AppStorage.set('cooperativeStatus','已停止新协同任务，原有任务继续结算');return;}
  this.changing=true;AppStorage.set('cooperativeChanging',true);AppStorage.set('cooperativeStatus','正在连接设备调度件并注册应用');
  try{
   const context=this.context,store=await preferences.getPreferences(context,{name:'cooperative-app'});
   const raw=await store.get('installation','') as string;let port:HarmonySdkPort;
   if(raw){const saved=JSON.parse(raw) as Saved;port=await HarmonySdkPort.open(context,saved.trust,saved.credential);}
   else{
    if(await store.get('exchangePending',false) as boolean)throw Error('上次注册结果未知，请在协调中心对账后恢复');
    const result=await context.startAbilityForResult({bundleName:'org.harmonycc.agent',abilityName:'EnrollmentAbility',parameters:{declaration:JSON.stringify(manifest)}});
    const encoded=result.want?.parameters?.['registration'];if(result.resultCode!==0||typeof encoded!=='string')throw Error('应用接入已取消');
    const registration=JSON.parse(encoded) as Registration;port=await HarmonySdkPort.open(context,registration);
    await store.put('exchangePending',true);await store.flush();
    const registered=JSON.parse(await port.exchange(registration.registrationId,registration.code)) as Exchange;
    const saved:Saved={trust:{address:registration.address,certificate:registration.certificate,fingerprint:registration.fingerprint},credential:registered.credential};
    await store.put('installation',JSON.stringify(saved));await store.put('exchangePending',false);await store.flush();
   }
   const registeredContext=JSON.parse(await port.request('/v2/apps/me',null)) as AppContext;
   if(registeredContext.declaration?.revision!==manifest.declaration.revision)throw Error('工作流声明版本不一致，请重新授权应用版本');
   this.port=port;this.sdk=new SchedulerSdk(port);
   AppStorage.set('cooperativeEnabled',true);AppStorage.set('cooperativeStatus','应用已注册 · 图片预处理与图像编码交由调度器选择设备');
  }catch(e){AppStorage.set('cooperativeEnabled',false);AppStorage.set('cooperativeStatus',(e as Error).message);throw e as Error;}
  finally{this.changing=false;AppStorage.set('cooperativeChanging',false);}
 }
 async cancel():Promise<void>{this.cancelRequested=true;if(this.active)await this.active.cancel();}
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

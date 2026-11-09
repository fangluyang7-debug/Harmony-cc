import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { util } from '@kit.ArkTS';
import { HarmonySdkPort, SchedulerSdk, SdkTask, TrustedCoordinator } from 'scheduler';
interface Registration extends TrustedCoordinator {registrationId:string;code:string;}
interface Exchange {credential:string;}
interface Saved {trust:TrustedCoordinator;credential:string;}
interface Resource {resourcePoolId:string;amount:number;}
export interface DeclaredNode {id:string;capability:string;dependsOn:string[];parameters?:string;effects?:string;privacy?:string;}
export interface WorkflowDeclaration {id:string;capabilities:string[];inputSchema:string;outputContract:string;qualityTarget?:string;nodes?:DeclaredNode[];alternatives?:WorkflowDeclaration[];}
export interface CapabilityAvailability {capability:string;targets:number;services:number;}
interface CapabilityReply {capabilities?:CapabilityAvailability[];}
interface Declaration {version:number;revision:string;workflows:WorkflowDeclaration[];}
interface AppContext {declaration:Declaration|null;}
interface DisplayMutation {version?:number;text?:string;}
export interface RegistrationRequest {label:string;allowedContracts:string[];maxConcurrent:number;resources:Resource[];offlineBase:Resource[];onlineExtra:Resource[];declaration:Declaration;}
/** The complete AI capability declaration of this App (rawfile/ai-declaration.json). Declared once by the developer;
 * the coordinator persists it and the planner decides where each node runs. Never trimmed to what is convenient. */
const DECLARATION_FILE='ai-declaration.json';
async function loadManifest(context:common.UIAbilityContext):Promise<RegistrationRequest>{
 const raw=await context.resourceManager.getRawFileContent(DECLARATION_FILE);
 const manifest=JSON.parse(new util.TextDecoder('utf-8',{ignoreBOM:true}).decodeToString(raw)) as RegistrationRequest;
 if(!manifest||!Array.isArray(manifest.allowedContracts)||!manifest.declaration||!Array.isArray(manifest.declaration.workflows)||manifest.declaration.workflows.length<1)throw Error('AI_DECLARATION_INVALID');
 return manifest;
}
class CooperativeSession {
 private context:common.UIAbilityContext|null=null;
 private sdk:SchedulerSdk|null=null;
 private port:HarmonySdkPort|null=null;
 private manifest:RegistrationRequest|null=null;
 private availability:CapabilityAvailability[]|null=null;
 private availabilityAt=0;
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
   const context=this.context,store=await preferences.getPreferences(context,{name:'cooperative-app'}),manifest=await loadManifest(context);
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
   this.port=port;this.sdk=new SchedulerSdk(port);this.manifest=manifest;this.availability=null;
   AppStorage.set('cooperativeEnabled',true);AppStorage.set('cooperativeStatus','应用已注册 · 已声明 '+manifest.declaration.workflows.length+' 条 AI 工作流 · 当前可协同执行：图片预处理、图像编码；其余环节待能力登记');
  }catch(e){AppStorage.set('cooperativeEnabled',false);AppStorage.set('cooperativeStatus',(e as Error).message);throw e as Error;}
  finally{this.changing=false;AppStorage.set('cooperativeChanging',false);}
 }
 async cancel():Promise<void>{this.cancelRequested=true;if(this.active)await this.active.cancel();}
 /** Declared workflows as shipped; the gateway matches them against coordinator availability. */
 declaration():RegistrationRequest|null{return this.manifest;}
 /** Qualified-target counts per declared capability, cached briefly. Read-only: the planner still decides placement. */
 async capabilities():Promise<CapabilityAvailability[]>{
  if(!this.enabled()||!this.port)return [];
  const now=Date.now();if(this.availability!==null&&now-this.availabilityAt<10000)return this.availability;
  try{const reply=JSON.parse(await this.port.request('/v2/apps/me/capabilities',null)) as CapabilityReply;this.availability=reply.capabilities??[];this.availabilityAt=now;return this.availability;}
  catch(e){return this.availability??[];}
 }
}
export const cooperative=new CooperativeSession();

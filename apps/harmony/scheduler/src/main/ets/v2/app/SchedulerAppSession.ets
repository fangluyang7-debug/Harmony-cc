import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { HarmonySdkPort } from '../client/HarmonySdkPort';
import { SchedulerSdk } from '../client/SchedulerSdk';
import { TrustedCoordinator } from '../platform/NativeTransport';
import { NativeAgent, NativeServiceAdapter } from '../host/NativeAgent';
import { Installation, Paired } from '../host/NativePlatform';
import { ResourceAmountV2 } from '../protocol/ResourcesV2';

/**
 * What an App declares to join the scheduling system. Shown once to the user on the device
 * agent's approval page; the coordinator enforces contracts and quota on every job.
 */
export interface SchedulerAppDeclaration {
 label:string;
 allowedContracts:string[];
 /** Optional workflow declaration registered with the App (see SoleAI). */
 declaration?:Object;
}
export interface SchedulerAppOptions {
 /** Unique per App; names the preferences file that keeps this App's credential. */
 storeName:string;
 declaration:SchedulerAppDeclaration;
 /** Revision inside `declaration.declaration`; a mismatch with the coordinator forces re-authorization. */
 revision?:string;
 /** In-process executors this App contributes while in the foreground. */
 services?:NativeServiceAdapter[];
 /** Ask for authorization automatically on first foreground (default true). A refusal is remembered. */
 autoEnroll?:boolean;
 /** Device agent that approves the App. */
 agentBundle?:string;
 agentAbility?:string;
}
export type SchedulerAppState='IDLE'|'CONNECTING'|'CONNECTED'|'PAUSED'|'UNAVAILABLE'|'DECLINED'|'NEEDS_AGENT';
export interface SchedulerAppStatus {state:SchedulerAppState;message:string;}
interface Registration extends TrustedCoordinator {registrationId:string;code:string;expiresAt:number;domain:string;}
interface Exchange extends Paired {offlineBase:ResourceAmountV2[];onlineExtra:ResourceAmountV2[];}
interface AppIdentity {appInstanceId:string;}
interface DeclarationRevision {revision?:string;}
interface AppContext {identity:AppIdentity;declaration:DeclarationRevision|null;deviceCapacity:ResourceAmountV2[];}

const TERMINAL=['APP_CREDENTIAL_REVOKED','CREDENTIAL_REVOKED','DEVICE_LEFT_SPACE','APP_HOST_IDENTITY_MISMATCH'];

/**
 * One object an App needs to join the scheduling system:
 *  1. obtains an App identity from the paired device agent (one approval, then remembered);
 *  2. runs a NativeAgent inside this App's process, so the phone both submits and executes work;
 *  3. follows the App's foreground state, the only time HarmonyOS lets it compute.
 *
 * Usage (EntryAbility): initialize(context) in onCreate, lifecycle(true/false) in
 * onForeground/onBackground, close() in onDestroy; submit work with sdk().
 */
export class SchedulerAppSession {
 private options:SchedulerAppOptions;
 private context:common.UIAbilityContext|null=null;
 private agent:NativeAgent|null=null;
 private client:SchedulerSdk|null=null;
 private sdkPort:HarmonySdkPort|null=null;
 private installation:Installation|null=null;
 private foreground=false;
 private statusTimer:number=-1;
 private paused=false;
 private busy:Promise<void>|null=null;
 private current:SchedulerAppStatus={state:'IDLE',message:'未接入协同调度'};
 private listeners:((status:SchedulerAppStatus)=>void)[]=[];
 constructor(options:SchedulerAppOptions){this.options=options;}

 initialize(context:common.UIAbilityContext):void{this.context=context;}
 /** Call from onForeground(true) / onBackground(false). Foreground restores or (first time) requests authorization. */
 lifecycle(foreground:boolean):void{
  this.foreground=foreground;this.agent?.setForeground(foreground&&!this.paused);
  if(foreground&&!this.paused&&this.agent===null)void this.connect(false).catch(()=>{});
 }
 async close():Promise<void>{if(this.statusTimer>=0)clearInterval(this.statusTimer);this.statusTimer=-1;this.foreground=false;const agent=this.agent;this.agent=null;this.client=null;this.sdkPort=null;await agent?.close();}

 status():SchedulerAppStatus{return this.current;}
 onStatus(listener:(status:SchedulerAppStatus)=>void):void{this.listeners.push(listener);listener(this.current);}
 /** Ready to submit and to receive work. */
 isReady():boolean{return !this.paused&&this.agent!==null&&this.agent.isConnected()&&this.client!==null;}
 /** SDK for submitting workflows; null while not connected or paused. */
 sdk():SchedulerSdk|null{return this.isReady()?this.client:null;}
 /** Authenticated control port (App routes such as /v2/apps/me, /v2/devices, /v2/display). */
 port():HarmonySdkPort|null{return this.paused?null:this.sdkPort;}
 host():NativeAgent|null{return this.agent;}
 deviceId():string{return this.installation?.paired.peer.deviceId??'';}
 holderId():string{return this.installation?.paired.peer.holderInstanceId??'';}

 /** Stop new cooperative work without dropping the identity; started work still settles. */
 pause():void{this.paused=true;this.agent?.setForeground(false);this.set('PAUSED','已暂停协同调度 · 新任务使用本机原有路径');}
 async resume():Promise<void>{this.paused=false;this.agent?.setForeground(this.foreground);await this.connect(true);}
 async reauthorize():Promise<void>{if(this.busy)return this.busy;this.paused=false;this.busy=this.run(true,true).finally(()=>{this.busy=null;});return this.busy;}

 /**
  * Restore the saved identity, or ask the device agent for one.
  * @param userInitiated true for an explicit user action: re-asks even after a previous refusal.
  */
 async connect(userInitiated:boolean=true):Promise<void>{
  if(this.busy)return this.busy;
  this.busy=this.run(userInitiated).finally(()=>{this.busy=null;});
  return this.busy;
 }

 async disconnect():Promise<void>{
  if(this.busy)await this.busy;
  this.set('CONNECTING','正在退出协作中心…');
  try{await this.agent?.closeForSwitch();this.agent=null;this.client=null;this.sdkPort=null;this.paused=true;
   if(this.statusTimer>=0)clearInterval(this.statusTimer);this.statusTimer=-1;
   if(this.context){const store=await preferences.getPreferences(this.context,{name:this.options.storeName});await store.put('enabled',false);await store.flush();}
   this.set('PAUSED','未接入协作中心');
  }catch(e){this.set('UNAVAILABLE','退出未完成：'+(e as Error).message);throw e as Error;}
 }
 private async run(userInitiated:boolean,force:boolean=false):Promise<void>{
  const context=this.context;if(!context)throw Error('APP_CONTEXT_REQUIRED');
  if(!this.foreground&&!userInitiated)return;
  const store=await preferences.getPreferences(context,{name:this.options.storeName});
  if(!userInitiated&&await store.get('enabled',true)===false){this.paused=true;this.set('PAUSED','未接入协作中心');return;}
  if(userInitiated)this.paused=false;
  let raw=await store.get('installation','') as string;
  this.set('CONNECTING',raw?'正在恢复协同连接…':'正在向调度连接 App 申请接入…');
  try{
   if(raw){
    try{if(force)throw Error('APP_REAUTHORIZE');await this.activate(JSON.parse(raw) as Installation);await store.put('enabled',true);await store.flush();return;}
    catch(e){
     // Automatic restores retain failed identities; an explicit connect can authorize the current space after settlement.
     if(!userInitiated&&!TERMINAL.includes((e as Error).message))throw e as Error;
     await this.agent?.closeForSwitch();this.agent=null;this.client=null;this.sdkPort=null;
     await store.put('previousInstallation',raw);await store.delete('installation');await store.flush();raw='';
    }
   }
   if(!userInitiated&&(this.options.autoEnroll===false||await store.get('declined',false) as boolean)){this.set('IDLE','未接入协同调度');return;}
   if(await store.get('exchangePending',false) as boolean)throw Error('上次授权结果未知，请在协调中心核对后重新授权');
   let result:common.AbilityResult;
   try{result=await context.startAbilityForResult({bundleName:this.options.agentBundle??'org.harmonycc.agent',abilityName:this.options.agentAbility??'EnrollmentAbility',parameters:{declaration:JSON.stringify(this.options.declaration)}});}
   catch(e){this.set('NEEDS_AGENT','未安装调度连接 App，或其版本不支持应用接入');return;}
   const encoded=result.want?.parameters?.['registration'];
   if(result.resultCode!==0||typeof encoded!=='string'){await store.put('declined',true);await store.flush();this.set('DECLINED','未授权协同调度 · 可在应用内重新授权');return;}
   await store.put('declined',false);
   const registration=JSON.parse(encoded) as Registration,port=await HarmonySdkPort.open(context,registration);
   await store.put('exchangePending',true);await store.flush();
   const paired=JSON.parse(await port.exchange(registration.registrationId,registration.code)) as Exchange;
   const info=JSON.parse(await port.request('/v2/apps/me',null)) as AppContext;
   const cpuCapacity=info.deviceCapacity.find(r=>r.resourcePoolId==='cpu')?.amount;
   const ramCapacity=info.deviceCapacity.find(r=>r.resourcePoolId==='ram')?.amount;
   if(cpuCapacity===undefined||ramCapacity===undefined)throw Error('DEVICE_CAPACITY_UNKNOWN');
   const saved:Installation={appInstanceId:info.identity.appInstanceId,paired,bootstrap:{domain:registration.domain,holderInstanceId:paired.peer.holderInstanceId,
    invitation:{version:2,inviteId:registration.registrationId,groupId:paired.peer.groupId,address:registration.address,certificate:registration.certificate,fingerprint:registration.fingerprint,code:'',expiresAt:registration.expiresAt},
    contribution:{ownerMode:'dedicated',maxCpuThreads:cpuCapacity,maxMemoryBytes:ramCapacity,reserveMemoryBytes:0}}};
   await store.put('installation',JSON.stringify(saved));await store.put('exchangePending',false);await store.flush();
   await this.activate(saved);await store.put('enabled',true);await store.flush();
  }catch(e){this.set('UNAVAILABLE','协同调度暂不可用：'+(e as Error).message+' · 新任务使用本机原有路径');throw e as Error;}
 }

 private async activate(installation:Installation):Promise<void>{
  const context=this.context!;
  const port=await HarmonySdkPort.open(context,installation.bootstrap.invitation,installation.paired.credential);
  const info=JSON.parse(await port.request('/v2/apps/me',null)) as AppContext;
  if(info.identity.appInstanceId!==installation.appInstanceId||(this.options.revision!==undefined&&info.declaration?.revision!==this.options.revision))throw Error('APP_HOST_IDENTITY_MISMATCH');
  if(this.agent&&this.agent.displayHolderId()!==installation.paired.peer.holderInstanceId){await this.agent.closeForSwitch();this.agent=null;}
  if(!this.agent)this.agent=await NativeAgent.start(context,null,()=>this.foreground&&!this.paused,installation,this.options.services??[]);
  this.sdkPort=port;this.client=await this.agent.sdk();this.installation=installation;
  this.agent.setForeground(this.foreground&&!this.paused);
  if(this.statusTimer<0)this.statusTimer=setInterval(()=>this.updateControlStatus(),1000);
  this.set(this.foreground&&this.agent.isConnected()?'CONNECTED':'UNAVAILABLE',this.foreground&&this.agent.isConnected()?'已连接协作空间 · 本应用前台参与计算':'本应用控制连接尚未就绪，正在重连');
 }

 private updateControlStatus():void {
  if(this.paused||!this.agent||this.current.state==='CONNECTING'&&this.busy!==null)return;
  const online=this.foreground&&this.agent.isConnected();
  this.set(online?'CONNECTED':'UNAVAILABLE',online?'已连接协作空间 · 本应用前台参与计算':this.foreground?'本应用控制连接尚未就绪，正在重连':'应用已退到后台，前台返回后恢复贡献');
 }
 private set(state:SchedulerAppState,message:string):void{this.current={state,message};for(const l of this.listeners)l(this.current);}
}

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
 maxConcurrent:number;
 resources:ResourceAmountV2[];
 offlineBase:ResourceAmountV2[];
 onlineExtra:ResourceAmountV2[];
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
interface AppContext {identity:AppIdentity;declaration:DeclarationRevision|null;}

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
 private paused=false;
 private busy:Promise<void>|null=null;
 private current:SchedulerAppStatus={state:'IDLE',message:'未接入协同调度'};
 private listeners:((status:SchedulerAppStatus)=>void)[]=[];
 constructor(options:SchedulerAppOptions){this.options=options;}

 initialize(context:common.UIAbilityContext):void{this.context=context;}
 /** Call from onForeground(true) / onBackground(false). Foreground restores or (first time) requests authorization. */
 lifecycle(foreground:boolean):void{
  this.foreground=foreground;this.agent?.setForeground(foreground);
  if(foreground&&!this.paused&&this.agent===null)void this.connect(false).catch(()=>{});
 }
 async close():Promise<void>{this.foreground=false;const agent=this.agent;this.agent=null;this.client=null;this.sdkPort=null;await agent?.close();}

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
 pause():void{this.paused=true;this.set('PAUSED','已暂停协同调度 · 新任务使用本机原有路径');}
 async resume():Promise<void>{this.paused=false;await this.connect(true);}

 /**
  * Restore the saved identity, or ask the device agent for one.
  * @param userInitiated true for an explicit user action: re-asks even after a previous refusal.
  */
 async connect(userInitiated:boolean=true):Promise<void>{
  if(this.busy)return this.busy;
  this.busy=this.run(userInitiated).finally(()=>{this.busy=null;});
  return this.busy;
 }

 private async run(userInitiated:boolean):Promise<void>{
  const context=this.context;if(!context)throw Error('APP_CONTEXT_REQUIRED');
  if(!this.foreground&&!userInitiated)return;
  const store=await preferences.getPreferences(context,{name:this.options.storeName});
  let raw=await store.get('installation','') as string;
  this.set('CONNECTING',raw?'正在恢复协同连接…':'正在向调度连接 App 申请接入…');
  try{
   if(raw){
    try{await this.activate(JSON.parse(raw) as Installation);return;}
    catch(e){
     // Re-authorize only after a definite revocation; a network failure keeps the identity for the next foreground.
     if(!TERMINAL.includes((e as Error).message))throw e as Error;
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
   const saved:Installation={appInstanceId:info.identity.appInstanceId,paired,bootstrap:{domain:registration.domain,holderInstanceId:paired.peer.holderInstanceId,
    invitation:{version:2,inviteId:registration.registrationId,groupId:paired.peer.groupId,address:registration.address,certificate:registration.certificate,fingerprint:registration.fingerprint,code:'',expiresAt:registration.expiresAt},
    contribution:{ownerMode:'dedicated',maxCpuThreads:2,maxMemoryBytes:268435456,reserveMemoryBytes:0}}};
   await store.put('installation',JSON.stringify(saved));await store.put('exchangePending',false);await store.flush();
   await this.activate(saved);
  }catch(e){this.set('UNAVAILABLE','协同调度暂不可用：'+(e as Error).message+' · 新任务使用本机原有路径');throw e as Error;}
 }

 private async activate(installation:Installation):Promise<void>{
  const context=this.context!;
  const port=await HarmonySdkPort.open(context,installation.bootstrap.invitation,installation.paired.credential);
  const info=JSON.parse(await port.request('/v2/apps/me',null)) as AppContext;
  if(info.identity.appInstanceId!==installation.appInstanceId||(this.options.revision!==undefined&&info.declaration?.revision!==this.options.revision))throw Error('APP_HOST_IDENTITY_MISMATCH');
  if(this.agent&&this.agent.displayHolderId()!==installation.paired.peer.holderInstanceId){await this.agent.closeForSwitch();this.agent=null;}
  if(!this.agent)this.agent=await NativeAgent.start(context,null,()=>this.foreground,installation,this.options.services??[]);
  this.sdkPort=port;this.client=await this.agent.sdk();this.installation=installation;
  this.set('CONNECTED','已接入协同调度 · 前台时本机参与计算');
 }

 private set(state:SchedulerAppState,message:string):void{this.current={state,message};for(const l of this.listeners)l(this.current);}
}

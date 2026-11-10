import {executeLocal,encoderCapability,localExecutorVersion,hasLocalExecutor} from './executors/Registry';
import {EngineResult} from './executors/Types';
import { NativePeerLinks } from '../platform/NativePeerLinks';
import { pairingHistory } from './PairingHistory';
import { HarmonySdkPort } from '../client/HarmonySdkPort';
import { SchedulerSdk, SdkInput } from '../client/SchedulerSdk';
import { NativeInputStore } from '../platform/NativeInputStore';
import { AppIdentityV2 } from '../protocol/SchedulingProtocolV2';
import { common } from '@kit.AbilityKit';
import { webSocket, http } from '@kit.NetworkKit';
import { hilog, hidebug } from '@kit.PerformanceAnalysisKit';
import { batteryInfo, power, thermal } from '@kit.BasicServicesKit';
import { NativeTrace } from './NativeTrace';
import { AgentStoreV2, AgentSnapshotV2, AgentChangeV2, AgentJournalChangeV2 } from '../agent/AgentStoreV2';
import { AgentJournalV2, agentMessageV2, bindAgentJournalV2, receiveAgentMessageV2, validateAgentOfferV2, statusPayloadV2 } from '../agent/AgentJournalV2';
import { RunTimings, newLedgerV2, requestGrantV2, installGrantV2, admitV2, startAttemptV2, cancelAttemptV2, settleAttemptV2, occupiedV2, LedgerEntryV2 } from '../core/LedgerV2';
import { canonical } from '../core/CanonicalV2';
import { ResourceAmountV2, DispatchOfferV2, AllotmentGrantV2, AllotmentAckV2, DeviceProfileV2, NumericSampleV2, StateSampleV2, ExecutorV2, CapabilityPackV2, ExecutionConfigV2, CapabilityAdmissionV2, validCapabilityAdmissionV2, PoolV2, ModelManifestV2, ExecutionReportV2, AdmissionReplyV2, YieldNoticeV2, LinkV2, validDeviceProfileV2 } from '../protocol/ResourcesV2';
import { MessageEnvelopeV2, TraceSpanV2, TaskContractV2, TargetV2, AttemptRecordV2, ExecutionReceiptV2, ArtifactRefV2, validMessageEnvelopeV2 } from '../protocol/SchedulingProtocolV2';
import { MicroQueueV2, QueueHistory } from '../core/MicroQueueV2';
import { NativeDatabase, NativeTransport, Bootstrap, Paired, Installation, Contribution, bytes, text, hash, factory, monotonic, base64 } from './NativePlatform';
class HostChange implements AgentChangeV2 {
 private action:(snapshot:AgentSnapshotV2)=>void;
 constructor(action:(snapshot:AgentSnapshotV2)=>void){this.action=action;}
 apply(snapshot:AgentSnapshotV2):void{this.action(snapshot);}
}
interface ExecutionControl {cancel:boolean;settled:boolean;}
class HostJournalChange implements AgentJournalChangeV2 {
 private action:(journal:AgentJournalV2)=>void;
 constructor(action:(journal:AgentJournalV2)=>void){this.action=action;}
 apply(journal:AgentJournalV2):void{this.action(journal);}
}
interface DisplayInvite {viewerHolderId:string;leaseMs:number;}
interface DisplayMutation {version?:number;text?:string;}
interface AppPolicy {identity:AppIdentityV2;offlineBase:ResourceAmountV2[];onlineExtra:ResourceAmountV2[];deviceCapacity?:ResourceAmountV2[];}
export interface ReferenceCase {id:string;input:string;parameters:string;config:ExecutionConfigV2;maxOutputBytes:number;}
export interface ReferencePack {manifest:CapabilityPackV2;digest:string;cases:ReferenceCase[];}
function referenceBytes(encoded:string):Uint8Array{return encoded.length?base64.decodeSync(encoded):new Uint8Array(0);}
interface Identity {version:number;domain:string;coordinatorId:string;epoch:number;}
interface AckPayload {messageId:string;}
interface Settings {settings:Contribution|null;}
interface MeasuredCapacity {cpuThreads:number|null;totalMemoryBytes:number;}
interface SettingsRequest {measured?:MeasuredCapacity;}
interface Qualification {executor:ExecutorV2;admission:CapabilityAdmissionV2;}
interface Ticket {token:string;ref:ArtifactRefV2;bytes:number;operation:string;expiresAt:number;}
interface Authorization {offer:DispatchOfferV2;snapshotVersion:number;inputTicket:Ticket;}
interface OutputTicket {ticket:Ticket;delivery?:string;}
interface Permit {id:string;groupId:string;holderInstanceId:string;targetId:string;identity:string;packDigest:string;caseId:string;inputHash:string;config:ExecutionConfigV2;maxOutputBytes:number;timeoutMs:number;domain:string;}
interface Work {permit:Permit;executor:ExecutorV2;coordinatorEpoch:number;ledgerEpoch:number;deviceInstanceId:string;expiresAt:number;mode:string;}
interface Claim {work:Work|null;}
interface CalibrationCost {compute:NumericSampleV2;cold:NumericSampleV2;}
interface EvaluationReport {overheadMs?:number;errorCode?:string;interrupted?:boolean;notRun?:boolean;settled:boolean;permitId:string;domain:string;output:string;durationMs:number;}
interface Probe {relayId:string;padding:string;}
interface Observation {bytes:number;durationMs:number;}
interface ProtocolError {version:number;code:string;retryable:boolean;messageId:string;}
interface TraceBatch {spans:TraceSpanV2[];}
interface QueueWaiter {workflowId:string;resolve:()=>void;reject:(error:Error)=>void;}
 interface PairInput {inviteId:string;code:string;holderInstanceId:string;installationId:string;previousDeviceId?:string;knownDeviceIds:string[];}
interface HelloPayload {versions:number[];extensions:Object[];}
function helloPayload():HelloPayload{return {versions:[2],extensions:[]};}
interface GrantRequest {ledgerEpoch:number;leaseRequestId:string;leaseMs:number;base:ResourceAmountV2[];extra:ResourceAmountV2[];}
interface SignedAck {ack:AllotmentAckV2;signature:string;}
interface ProbePayload {mode:string;bytes:number;padding?:string;}
interface TaskDigest {inputs:ArtifactRefV2[];contract:TaskContractV2;parameters:string;allowedTargetIds:string[];allowedConfigurations:string[];}
interface PublishInput {bytes:number;contentHash:string;schemaId:string;}
interface ExecutorDigest {target:TargetV2;contract:TaskContractV2;model:ModelManifestV2|null;resources:ResourceAmountV2[];configurations:ExecutionConfigV2[];}
function validContribution(p:Contribution):boolean {return !!p&&['dedicated','windows-idle','paused'].includes(p.ownerMode)&&Number.isSafeInteger(p.maxCpuThreads)&&p.maxCpuThreads>=1&&p.maxCpuThreads<=64&&Number.isSafeInteger(p.maxMemoryBytes)&&p.maxMemoryBytes>=67108864&&Number.isSafeInteger(p.reserveMemoryBytes)&&p.reserveMemoryBytes>=0;}
export interface NativeServiceAdapter {pack:ReferencePack;execute(input:Uint8Array,parameters:string,cancelled:()=>boolean):Promise<EngineResult>;}
export class NativeAgent {
 private peerLinks:NativePeerLinks|null=null;
 private services:NativeServiceAdapter[]=[];
 private static starting=false;
 private policy:AppPolicy|null=null;
 private inputs:NativeInputStore|null=null;
 private context:common.UIAbilityContext;
 private db:NativeDatabase;
 private store:AgentStoreV2;
 private transport:NativeTransport;
 private installation:Installation;
 private packs:ReferencePack[];
 private socket:webSocket.WebSocket|null=null;
 private stopped=false;
 private switching=false;
 private ready=false;
 private welcomed=false;
 private foreground=true;
 private lifecycleForeground:()=>boolean=()=>true;
 private paused=false;
 private enabled=true;
 private contribution:Contribution;
 private timer:number=0;
 private work:Promise<void>=Promise.resolve();
 private refreshing=false;
 private connecting=false;
 private calibrating=false;
 private grantBusy=false;
 private renewAt=0;
 private renewalConfig='';
 private instance=factory.id();
 private helloId='';
 private sent=new Set<string>();
 private flushTail:Promise<void>=Promise.resolve();
 private running=new Set<string>();
 private offered=new Set<string>();
 private queue:MicroQueueV2;
 private waiting=new Map<string,QueueWaiter>();
 private waitReasons=new Map<string,QueueHistory>();
 private launching=false;
 private timings=new RunTimings();
 private queueStarted=new Set<string>();
 private links:LinkV2[]=[];
 private costs=new Map<string,CalibrationCost>();
 private totalRam:number|null=null;
 private availableRam:number|null=null;
 private powerSaving:string|null=null;
 private batteryPercent:number|null=null;
 private charging:string|null=null;
 private thermalLevel:number|null=null;
 private energyGate:string|null=null;
 private sampleEnergy():void{
  try{const soc=batteryInfo.batterySOC;this.batteryPercent=Number.isFinite(soc)&&soc>=0&&soc<=100?soc:null;}catch(e){this.batteryPercent=null;}
  try{
   const status=batteryInfo.chargingStatus;
   this.charging=status===batteryInfo.BatteryChargeState.ENABLE||status===batteryInfo.BatteryChargeState.FULL?'CHARGING':
    status===batteryInfo.BatteryChargeState.DISABLE||status===batteryInfo.BatteryChargeState.NONE?'NOT_CHARGING':null;
  }catch(e){this.charging=null;}
  try{const level=thermal.getLevel();this.thermalLevel=level>=thermal.ThermalLevel.COOL&&level<=thermal.ThermalLevel.ESCAPE?level:null;}catch(e){this.thermalLevel=null;}
  let low=false;
  try{const level=batteryInfo.batteryCapacityLevel;low=level===batteryInfo.BatteryCapacityLevel.LEVEL_LOW||level===batteryInfo.BatteryCapacityLevel.LEVEL_WARNING||level===batteryInfo.BatteryCapacityLevel.LEVEL_CRITICAL;}catch(e){}
  if(this.thermalLevel!==null&&this.thermalLevel>=thermal.ThermalLevel.OVERHEATED)this.energyGate='THERMAL_LIMIT';
  else if(this.powerSaving==='ON')this.energyGate='POWER_SAVE';
  else if(low&&this.charging==='NOT_CHARGING')this.energyGate='LOW_BATTERY';
  else this.energyGate=null;
 }
 private constructor(context:common.UIAbilityContext,db:NativeDatabase,store:AgentStoreV2,transport:NativeTransport,installation:Installation,packs:ReferencePack[]){this.context=context;this.db=db;this.store=store;this.transport=transport;this.installation=installation;this.packs=packs;this.contribution=JSON.parse(JSON.stringify(installation.bootstrap.contribution)) as Contribution;this.queue=new MicroQueueV2(installation.paired.peer.deviceId,{shares:[.5,.3,.2],agingMs:1000,maxConsecutive:2,yieldDeadlineMs:1000});}
 static async start(context:common.UIAbilityContext,bootstrap:Bootstrap|null,lifecycleForeground:()=>boolean=()=>true,registered:Installation|null=null,services:NativeServiceAdapter[]=[]):Promise<NativeAgent>{
  if(NativeAgent.starting)throw Error('HOST_ALREADY_STARTED');NativeAgent.starting=true;
  try{return await NativeAgent.create(context,bootstrap,lifecycleForeground,registered,services);}catch(error){NativeAgent.starting=false;throw error as Error;}
 }
 private static async create(context:common.UIAbilityContext,bootstrap:Bootstrap|null,lifecycleForeground:()=>boolean,registered:Installation|null,services:NativeServiceAdapter[]):Promise<NativeAgent>{
  const db=await NativeDatabase.open(context);let saved=await db.get('identity');let installation:Installation;
  if(saved!==null){
   const previous=JSON.parse(saved) as Installation,holder=previous.paired.peer.holderInstanceId;
   await db.put('identity:'+holder,saved);
   // Preserve the legacy single-space ledger before selecting another identity.
   if(await db.get('scope-ready:'+holder)===null){
    for(const key of ['ledger','contribution','contribution-enabled'])if(await db.get(key+':'+holder)===null){const legacy=await db.get(key);if(legacy!==null)await db.put(key+':'+holder,legacy);}
    await db.put('scope-ready:'+holder,'true');
   }
   if(bootstrap!==null&&holder!==bootstrap.holderInstanceId){
    if(previous.appInstanceId||registered!==null)throw Error('INSTALLATION_ALREADY_PAIRED');
    saved=await db.get('identity:'+bootstrap.holderInstanceId);
    if(saved!==null){const known=JSON.parse(saved) as Installation;if(known.paired.peer.groupId!==bootstrap.invitation.groupId||known.bootstrap.invitation.fingerprint!==bootstrap.invitation.fingerprint||known.bootstrap.domain!==bootstrap.domain)throw Error('PAIR_DOMAIN_INVALID');}
   }
   if(registered!==null&&holder!==registered.paired.peer.holderInstanceId){
    if(!previous.appInstanceId||!registered.appInstanceId)throw Error('APP_HOST_IDENTITY_REQUIRED');
    const old=await AgentStoreV2.open({groupId:previous.paired.peer.groupId,deviceId:previous.paired.peer.deviceId,holderInstanceId:holder,appInstanceId:previous.appInstanceId},db.ledger('ledger:'+holder));
    if(old.read().state.entries.some(e=>!e.record.resourcesSettled))throw Error('SPACE_SWITCH_BUSY');
    saved=await db.get('identity:'+registered.paired.peer.holderInstanceId);
   }
  }
  if(saved===null&&registered!==null){if(!registered.appInstanceId)throw Error('APP_HOST_IDENTITY_REQUIRED');}
  if(saved===null&&registered!==null){installation=registered;}
  else if(saved!==null){installation=JSON.parse(saved) as Installation;if(registered!==null&&(installation.appInstanceId!==registered.appInstanceId||installation.paired.peer.holderInstanceId!==registered.paired.peer.holderInstanceId))throw Error('INSTALLATION_ALREADY_PAIRED');if(bootstrap!==null&&installation.bootstrap.holderInstanceId!==bootstrap.holderInstanceId)throw Error('INSTALLATION_ALREADY_PAIRED');}
  else{
   if(bootstrap===null||bootstrap.invitation.version!==2||bootstrap.invitation.expiresAt<=Date.now()||!validContribution(bootstrap.contribution)||!['REAL','SIMULATED'].includes(bootstrap.domain))throw Error('INVITATION_REQUIRED');
   const pendingPair=await db.get('pairing-pending:'+bootstrap.holderInstanceId);
   if(pendingPair!==null&&pendingPair!==''||await db.get('pairing-pending')===bootstrap.holderInstanceId)throw Error('PAIRING_RECONCILIATION_REQUIRED');
   const transport=new NativeTransport(bootstrap.invitation,context);await transport.initialize();
   const info=await transport.json('/v2/identity') as Identity;if(info.version!==2||info.domain!==bootstrap.domain)throw Error('PAIR_DOMAIN_INVALID');
   await db.put('pairing-pending:'+bootstrap.holderInstanceId,bootstrap.invitation.inviteId);
   let installationId=await db.get('device-installation-id');if(installationId===null){installationId=factory.id();await db.put('device-installation-id',installationId);}
   const oldIdentity=await db.get('identity'),history=pairingHistory(bootstrap,oldIdentity===null?null:JSON.parse(oldIdentity) as Installation,(await db.storedIdentities()).map((value:string)=>JSON.parse(value) as Installation));
   const previousDeviceId=history.previousDeviceId,knownDeviceIds=history.knownDeviceIds;
   const pairInput:PairInput={inviteId:bootstrap.invitation.inviteId,code:bootstrap.invitation.code,holderInstanceId:bootstrap.holderInstanceId,installationId,previousDeviceId,knownDeviceIds};let paired:Paired;
   try{paired=await transport.json('/v2/pair',pairInput) as Paired;}
   catch(error){if((error as Error).message==='SPACE_SWITCH_BUSY')await db.put('pairing-pending:'+bootstrap.holderInstanceId,'');throw error as Error;}
   if(!/^[A-Za-z0-9_-]{43}$/.test(paired.credential)||paired.peer.groupId!==bootstrap.invitation.groupId||paired.peer.holderInstanceId!==bootstrap.holderInstanceId)throw Error('PAIR_RESPONSE_INVALID');
   installation={bootstrap,paired};await db.put('identity:'+paired.peer.holderInstanceId,JSON.stringify(installation));
  }
  if(registered===null){await db.put('scope-ready:'+installation.paired.peer.holderInstanceId,'true');await db.put('identity',JSON.stringify(installation));}
  const transport=new NativeTransport(installation.bootstrap.invitation,context);await transport.initialize();transport.credential=installation.paired.credential;
  const peer=installation.paired.peer,store=await AgentStoreV2.open({groupId:peer.groupId,deviceId:peer.deviceId,holderInstanceId:peer.holderInstanceId,appInstanceId:installation.appInstanceId??null},db.ledger('ledger:'+peer.holderInstanceId));
  if(store.read().state.grant!==null&&!transport.verify(store.read().state.grant!))throw Error('LEDGER_GRANT_SIGNATURE');
  const packs=(JSON.parse(text(await context.resourceManager.getRawFileContent('reference-packs.json'))) as ReferencePack[]).filter(p=>!p.manifest.contract.capability.startsWith('photo.')||hasLocalExecutor(p.manifest.contract.capability));
  if(services.some(s=>!s.pack.manifest.contract.serviceId||s.pack.manifest.contract.sideEffectPolicy!=='PURE'||s.pack.manifest.contract.interruptibility!=='CANCEL_RESTART')||services.length>0&&!installation.appInstanceId)throw Error('SERVICE_CONFIG_INVALID');
  for(const service of services){if(packs.some(p=>p.manifest.contract.capability===service.pack.manifest.contract.capability))throw Error('SERVICE_CAPABILITY_CONFLICT');packs.push(service.pack);}
  const agent=new NativeAgent(context,db,store,transport,installation,packs);agent.services=services;if(installation.appInstanceId){const policy=await transport.json('/v2/apps/me') as AppPolicy;if(policy.identity.appInstanceId!==installation.appInstanceId||policy.identity.groupId!==peer.groupId)throw Error('APP_HOST_IDENTITY_MISMATCH');agent.policy=policy;agent.packs=agent.packs.filter(p=>policy.identity.allowedContracts.includes(p.manifest.contract.contractId));if(agent.packs.length===0)throw Error('APP_HOST_CAPABILITIES_REQUIRED');agent.inputs=await NativeInputStore.open(context);}
  if(registered!==null){await db.put('scope-ready:'+installation.paired.peer.holderInstanceId,'true');await db.put('identity:'+installation.paired.peer.holderInstanceId,JSON.stringify(installation));await db.put('identity',JSON.stringify(installation));}
  agent.peerLinks=new NativePeerLinks(context,transport,peer.deviceId);agent.peerLinks.start();
  agent.lifecycleForeground=lifecycleForeground;agent.foreground=lifecycleForeground();await agent.restorePreferences();agent.timer=setInterval(()=>{void agent.tick().catch((e:Error)=>agent.error(e as Error));},2000);await agent.tick();return agent;
 }
 isConnected():boolean{return this.ready&&!this.stopped;}
 async closeForSwitch():Promise<void>{
  this.switching=true;
  try{
   const until=monotonic()+15000;
   while((this.refreshing||this.calibrating||this.grantBusy||this.connecting||this.running.size>0)&&monotonic()<until)await new Promise<void>(resolve=>setTimeout(resolve,100));
   await this.work;
   if(this.refreshing||this.calibrating||this.grantBusy||this.connecting||this.store.read().state.entries.some(e=>!e.record.resourcesSettled))throw Error('SPACE_SWITCH_BUSY');
   await this.close();
  }catch(e){this.switching=false;throw e as Error;}
 }
 async leaveSpace():Promise<void>{
  this.switching=true;
  try{const port=await HarmonySdkPort.open(this.context,this.installation.bootstrap.invitation,this.installation.paired.credential);await this.closeForSwitch();await port.request('/v2/devices/leave','{}');}
  catch(e){this.switching=false;throw e as Error;}
 }
 async registerApplication(declaration:Object):Promise<string>{
  if(!this.isConnected())throw Error('SDK_COORDINATOR_OFFLINE');
  if(this.installation.appInstanceId)throw Error('DEVICE_OWNER_CREDENTIAL_REQUIRED');
  return JSON.stringify(await this.transport.json('/v2/apps/registrations',declaration));
 }
 displayHolderId():string{return this.installation.paired.peer.holderInstanceId;}
 async displayInbox():Promise<Object>{return this.transport.json('/v2/display');}
 async displayInvite(viewerHolderId:string):Promise<Object>{
  const invite:DisplayInvite={viewerHolderId,leaseMs:300000};
  return this.transport.json('/v2/display',invite);
 }
 async displaySession(id:string,action:string='',body:DisplayMutation={}):Promise<Object>{
  if(!/^[a-zA-Z0-9-]{1,100}$/.test(id)||!['','accept','leave','publish','shown','revoke'].includes(action))throw Error('DISPLAY_ROUTE_INVALID');
  return this.transport.json('/v2/display/'+id+(action?'/'+action:''),action?body:null);
 }
 async sdk():Promise<SchedulerSdk>{
  if(this.policy===null||this.inputs===null)throw Error('APP_HOST_REQUIRED');
  const port=await HarmonySdkPort.open(this.context,this.installation.bootstrap.invitation,this.installation.paired.credential);
  port.connected=()=>this.ready&&!this.stopped;
  const inputs=this.inputs;port.localRead=(contentHash:string):Promise<Uint8Array|null>=>inputs.read(contentHash);port.stageInput=(input:SdkInput,data:Uint8Array):Promise<void>=>inputs.stage(input.contentHash,input.bytes,data);
  return new SchedulerSdk(port);
 }
 private showStatus():void {
  const status=this.stopped?'已停止':!this.ready?'正在连接协调中心':!this.idle()?'已连接 · 贡献已暂停':this.energyGate!==null?'已连接 · 等待电量或温控条件':'已连接 · 前台贡献';
  AppStorage.setOrCreate('agentStatus',status);
 }
 private error(e:Error):void {const code=/^[A-Z_0-9:]+$/.test(e.message)?e.message:'NATIVE_AGENT_FAILED';AppStorage.setOrCreate('agentWarning',code);this.showStatus();hilog.error(0x0001,'HarmonyAgent','%{public}s',code);}
 private async restorePreferences():Promise<void>{
  const saved=await this.db.get('contribution:'+this.displayHolderId());if(saved!==null){const value=JSON.parse(saved) as Contribution;if(!this.withinCeiling(value))throw Error('CONTRIBUTION_INVALID');this.contribution=value;}
  this.enabled=(await this.db.get('contribution-enabled:'+this.displayHolderId()))!=='false';this.showPreferences();
 }
 private withinCeiling(value:Contribution):boolean {const ceiling=this.installation.bootstrap.contribution;return validContribution(value)&&value.maxCpuThreads<=ceiling.maxCpuThreads&&value.maxMemoryBytes<=ceiling.maxMemoryBytes;}
 /** The settings poll carries this device's measured hardware so an auto-capacity ceiling follows the real phone, not the invitation's provisional 1 GiB. */
 private settingsRequest():SettingsRequest {
  const request:SettingsRequest={};
  if(this.totalRam!==null){const measured:MeasuredCapacity={cpuThreads:null,totalMemoryBytes:this.totalRam};request.measured=measured;}
  return request;
 }
 /** Adopt a ceiling the coordinator derived from our measurements. A contribution the owner left at the old ceiling follows it; one they lowered is only clamped. */
 private async adoptCeiling(settings:Contribution):Promise<void>{
  const ceiling=this.installation.bootstrap.contribution;
  if(!validContribution(settings)||settings.maxCpuThreads===ceiling.maxCpuThreads&&settings.maxMemoryBytes===ceiling.maxMemoryBytes&&settings.reserveMemoryBytes===ceiling.reserveMemoryBytes)return;
  const atCeiling=this.contribution.maxCpuThreads===ceiling.maxCpuThreads&&this.contribution.maxMemoryBytes===ceiling.maxMemoryBytes;
  const next:Contribution={ownerMode:ceiling.ownerMode,maxCpuThreads:settings.maxCpuThreads,maxMemoryBytes:settings.maxMemoryBytes,reserveMemoryBytes:settings.reserveMemoryBytes};
  this.installation.bootstrap.contribution=next;
  await this.db.put('identity',JSON.stringify(this.installation));
  const current:Contribution={ownerMode:this.contribution.ownerMode,maxCpuThreads:atCeiling?next.maxCpuThreads:Math.min(this.contribution.maxCpuThreads,next.maxCpuThreads),
   maxMemoryBytes:atCeiling?next.maxMemoryBytes:Math.min(this.contribution.maxMemoryBytes,next.maxMemoryBytes),reserveMemoryBytes:next.reserveMemoryBytes};
  this.contribution=current;
  await this.db.put('contribution',JSON.stringify(current));
  this.showPreferences();
 }
 private showPreferences():void {AppStorage.setOrCreate('cpuLimit',String(this.contribution.maxCpuThreads));AppStorage.setOrCreate('memoryLimitMB',String(this.contribution.maxMemoryBytes/1048576));AppStorage.setOrCreate('maxCpuLimit',this.installation.bootstrap.contribution.maxCpuThreads);AppStorage.setOrCreate('maxMemoryLimitMB',this.installation.bootstrap.contribution.maxMemoryBytes/1048576);AppStorage.setOrCreate('contributing',this.enabled);}
 async configure(cpu:number,memoryMB:number):Promise<void>{const next:Contribution={ownerMode:'dedicated',maxCpuThreads:cpu,maxMemoryBytes:memoryMB*1048576,reserveMemoryBytes:this.contribution.reserveMemoryBytes};if(!this.withinCeiling(next))throw Error('CONTRIBUTION_EXCEEDS_PAIRED_CEILING');this.contribution=next;await this.db.put('contribution:'+this.displayHolderId(),JSON.stringify(next));this.showPreferences();await this.tick();}
 async setEnabled(value:boolean):Promise<void>{this.enabled=value;await this.db.put('contribution-enabled:'+this.displayHolderId(),String(value));if(!value)await this.yield();this.showPreferences();if(this.ready)await this.profile();}
 private idle():boolean{return this.foreground&&this.lifecycleForeground()&&this.enabled&&!this.paused&&!this.switching;}
 private limits():ResourceAmountV2[]{const available=this.idle()&&this.energyGate===null,p=this.contribution,used=this.store.occupied().find(x=>x.resourcePoolId==='ram')?.amount??0;return [{resourcePoolId:'cpu',amount:available?p.maxCpuThreads:0},{resourcePoolId:'ram',amount:available&&this.availableRam!==null?Math.min(p.maxMemoryBytes,used+Math.max(0,this.availableRam-p.reserveMemoryBytes)):0}];}
 private enqueue(s:AgentSnapshotV2,type:string,payload:Object,ackOf:string|null=null):MessageEnvelopeV2 {const m=agentMessageV2(s.journal,s.state.groupId,s.state.holderInstanceId,type,payload,factory,ackOf);s.journal.outbox.push(m);return m;}
 private async flush():Promise<void>{
  const run=this.flushTail.then(()=>this.flushQueued());this.flushTail=run.catch(()=>{});return run;
 }
 private async flushQueued():Promise<void>{
  const socket=this.socket;if(socket===null)return;
  for(const m of this.store.readJournal().outbox){
   if(this.socket!==socket)return;
   if(!this.welcomed&&m.type!=='Hello'||this.sent.has(m.messageId))continue;
   this.sent.add(m.messageId);
   let timer:number=-1;
   try{await new Promise<void>((resolve,reject)=>{timer=setTimeout(()=>reject(Error('CONTROL_SEND_TIMEOUT')),5000);void socket.send(JSON.stringify(m)).then(()=>resolve()).catch((e:Error)=>reject(e));});}catch(e){
    // A rejected send is not delivery. Retain the durable message and recover
    // the channel even when the platform omits an error/close callback.
    if(this.socket===socket){this.peerLinks?.invalidate();this.ready=false;this.welcomed=false;this.socket=null;this.sent.clear();}
    try{void socket.close().catch(()=>{});}catch(_){}
    throw Error('CONTROL_SEND_FAILED');
   }finally{if(timer!==-1)clearTimeout(timer);}
   if(m.type==='Ack')await this.store.changeJournal(new HostJournalChange(j=>{j.outbox=j.outbox.filter(x=>x.messageId!==m.messageId);}));
  }
 }
 private async connect():Promise<void>{
  if(this.connecting||this.socket!==null||this.stopped)return;this.connecting=true;this.renewAt=0;
  try{
   const info=await this.transport.json('/v2/identity') as Identity;if(info.domain!==this.installation.bootstrap.domain||info.version!==2)throw Error('IDENTITY_INVALID');
   await this.store.change(new HostChange(s=>{s.journal=bindAgentJournalV2(s.journal,info.coordinatorId,info.epoch);}));
   const socket=webSocket.createWebSocket();this.socket=socket;this.sent.clear();this.welcomed=false;
   socket.on('message',(_error,data)=>{if(this.socket!==socket)return;if(typeof data!=='string'){void socket.close();return;}this.work=this.work.then(()=>this.message(JSON.parse(data) as MessageEnvelopeV2)).catch((e:Error)=>{this.error(e as Error);void socket.close();});});
   socket.on('close',()=>{if(this.socket!==socket)return;this.peerLinks?.invalidate();this.ready=false;this.welcomed=false;this.socket=null;this.sent.clear();});
   socket.on('error',()=>{if(this.socket!==socket)return;this.peerLinks?.invalidate();this.ready=false;this.welcomed=false;this.socket=null;this.sent.clear();void socket.close().catch(()=>{});});
   try{
    await this.transport.connect(socket);
    if(this.socket!==socket)throw Error('CONTROL_DISCONNECTED');
    await this.store.change(new HostChange(s=>{s.journal.outbox=s.journal.outbox.filter(x=>x.type!=='Hello');const m=this.enqueue(s,'Hello',helloPayload());this.helloId=m.messageId;}));await this.flush();
   }catch(e){
    if(this.socket===socket){this.peerLinks?.invalidate();this.ready=false;this.welcomed=false;this.socket=null;this.sent.clear();}
    try{await socket.close();}catch(_){}
    throw e as Error;
   }
  }finally{this.connecting=false;}
 }
 private async message(m:MessageEnvelopeV2):Promise<void>{
  const j=this.store.readJournal();
  if(!validMessageEnvelopeV2(m,[])||m.groupId!==this.installation.paired.peer.groupId||m.senderInstanceId!==j.coordinatorId||m.coordinatorEpoch!==j.epoch)throw Error('SERVER_MESSAGE_INVALID');
  if(m.type==='Ack'){
   const payload=JSON.parse(m.payload) as AckPayload;if(Object.keys(payload).join('|')!=='messageId'||payload.messageId!==m.ackOf)throw Error('ACK_INVALID');
   const old=j.outbox.find(x=>x.messageId===payload.messageId);if(payload.messageId===this.helloId)this.welcomed=true;
   if(payload.messageId===this.helloId)await this.store.change(new HostChange(s=>{s.journal.outbox=s.journal.outbox.filter(x=>x.messageId!==payload.messageId);if(!s.journal.outbox.some(x=>x.type==='RecoveryRequest'))this.enqueue(s,'RecoveryRequest',{} as Record<string,Object>);}));
   else await this.store.changeJournal(new HostJournalChange(j=>{j.outbox=j.outbox.filter(x=>x.messageId!==payload.messageId);}));
   if(old?.type==='RecoveryRequest'){this.ready=true;AppStorage.setOrCreate('agentStatus','已连接 · 前台贡献');void this.tick().catch((e:Error)=>this.error(e as Error));}
  }else if(m.type==='AttemptStatusQuery'){
   await this.store.change(new HostChange(s=>{const fresh=receiveAgentMessageV2(s.journal,m,s.state.groupId,factory);if(fresh)this.enqueue(s,'AttemptStatusReply',statusPayloadV2(m,s.state.groupId,s.state.holderInstanceId,s.state.entries.map(e=>e.record)),m.messageId);this.enqueue(s,'Ack',{messageId:m.messageId} as AckPayload,m.messageId);}));
  }else if(m.type==='EvaluationChanged'){if(this.ready)void this.calibrate().catch((e:Error)=>this.error(e as Error));}
  else if(m.type==='DispatchOffer'){if(this.ready)void this.dispatch(m).catch((e:Error)=>this.error(e as Error));}
  else throw Error('SERVER_MESSAGE_UNSUPPORTED');await this.flush();
 }
 private async renew():Promise<void>{
  if(this.grantBusy||!this.ready)return;
  // A background owner must not keep all discretionary capacity while the
  // foreground source App is trying to acquire its own grant. Occupied work
  // remains fenced by the coordinator's reservation/acknowledgment protocol.
  const base=this.policy?.offlineBase??[],extra=this.idle()?(this.policy?.onlineExtra??[{resourcePoolId:'cpu',amount:this.contribution.maxCpuThreads},{resourcePoolId:'ram',amount:this.contribution.maxMemoryBytes}]):[];
  const configuration=canonical(base)+'|'+canonical(extra);if(monotonic()<this.renewAt&&configuration===this.renewalConfig)return;
  this.grantBusy=true;const requestedAt=monotonic();
  try{
   const id=factory.id();await this.store.change(new HostChange(s=>{s.state=requestGrantV2(s.state,id,monotonic());}));const state=this.store.read().state;
   const request:GrantRequest={ledgerEpoch:state.ledgerEpoch,leaseRequestId:id,leaseMs:60000,base,extra};const grant=await this.transport.json('/v2/allotments/request',request) as AllotmentGrantV2;
   const verified=this.transport.verify(grant);await this.store.change(new HostChange(s=>{s.state=installGrantV2(s.state,grant,verified,monotonic());}));await this.ackQuota();
   this.renewalConfig=configuration;this.renewAt=Math.min(monotonic()+grant.leaseMs/3,requestedAt+grant.leaseMs*2/3);
  }finally{this.grantBusy=false;}
 }
 private async ackQuota():Promise<void>{const state=this.store.read().state,g=state.grant;if(g===null)return;const ack:AllotmentAckV2={allotmentId:g.allotmentId,holderInstanceId:state.holderInstanceId,ledgerEpoch:g.ledgerEpoch,coordinatorEpoch:g.coordinatorEpoch,version:g.version,persisted:true,settlementSeq:state.settlementSeq,occupied:occupiedV2(state)};const signed:SignedAck={ack,signature:await this.transport.ackSignature(ack)};await this.transport.json('/v2/allotments/ack',signed);}
 private sample(value:number|null,unit:string,source:string='PRIOR'):NumericSampleV2{return {value,unit,source:value===null?'UNKNOWN':source,sampledAt:this.transport.now(),ttlMs:15000};}
 private status(value:string|null,source:string='PRIOR'):StateSampleV2{return {value,unit:'state',source:value===null?'UNKNOWN':source,sampledAt:this.transport.now(),ttlMs:15000};}
 private executors():ExecutorV2[]{return this.packs.map((pack:ReferencePack):ExecutorV2=>{
  const encoder=pack.manifest.contract.capability===encoderCapability;
  const executorId=encoder?'harmony.image.cpu.v1':'harmony.cpu.v1';
  const resources=pack.manifest.resourceLimit.filter((r:ResourceAmountV2)=>r.resourcePoolId==='cpu'||r.resourcePoolId==='ram');
  return {startup:encoder?'COLD':'UNKNOWN',target:{targetId:'harmony-'+hash(bytes(this.installation.paired.peer.holderInstanceId+':'+pack.manifest.contract.capability)).slice(0,32),deviceId:this.installation.paired.peer.deviceId,executorId,executorVersion:localExecutorVersion(pack.manifest.contract.capability),backend:pack.manifest.contract.serviceId?'SERVICE':'CPU',resourcePoolIds:['cpu','ram'],stableExecutionId:executorId},contract:pack.manifest.contract,model:pack.manifest.model,resources,configurations:[pack.cases[0].config],compute:this.costs.get(pack.manifest.contract.capability)?.compute??this.sample(null,'ms'),queue:this.sample(null,'ms'),cold:this.costs.get(pack.manifest.contract.capability)?.cold??this.sample(null,'ms'),publish:this.sample(0,'ms'),uncertainty:this.sample(null,'ms','UNKNOWN')} as ExecutorV2;});}
  private async profile():Promise<void>{
  await this.store.change(new HostChange(s=>{
   if(s.journal.outbox.some(m=>m.type==='DeviceProfile'))return;const used=occupiedV2(s.state),limits=this.limits();
   const executors=this.executors();
   const sampleSource=this.installation.bootstrap.domain==='REAL'?'MEASURED':'SIMULATED';
   const profile:DeviceProfileV2={deviceId:s.state.deviceId,deviceInstanceId:this.instance,holderInstanceId:s.state.holderInstanceId,ledgerEpoch:s.state.ledgerEpoch,sequence:s.journal.sequence+1,domain:this.installation.bootstrap.domain,
    ownerActivity:this.status(this.idle()?'IDLE':'ACTIVE'),foreground:this.status(this.foreground&&this.lifecycleForeground()?'FOREGROUND':'BACKGROUND'),charging:this.status(this.charging,sampleSource),powerSave:this.status(this.powerSaving,sampleSource),battery:this.sample(this.batteryPercent,'percent',sampleSource),temperature:this.sample(this.thermalLevel,'level',sampleSource),
    // CPU total is the paired owner-declared ceiling (PRIOR), not this App's current contribution.
    pools:limits.map((r:ResourceAmountV2):PoolV2=>({resourcePoolId:r.resourcePoolId,kind:r.resourcePoolId==='cpu'?'CPU_SLOTS':'RAM_BYTES',exclusive:false,total:this.sample(r.resourcePoolId==='cpu'?(this.policy?.deviceCapacity?.find(pool=>pool.resourcePoolId==='cpu')?.amount??this.installation.bootstrap.contribution.maxCpuThreads):this.totalRam,r.resourcePoolId==='cpu'?'slots':'bytes',r.resourcePoolId==='cpu'?'PRIOR':this.installation.bootstrap.domain==='REAL'?'MEASURED':'SIMULATED'),ownerReserved:0,contributionLimit:r.resourcePoolId==='cpu'?this.contribution.maxCpuThreads:this.contribution.maxMemoryBytes,admissionLimit:this.sample(r.amount,r.resourcePoolId==='cpu'?'slots':'bytes'),occupied:this.sample(used.find(x=>x.resourcePoolId===r.resourcePoolId)?.amount??0,r.resourcePoolId==='cpu'?'slots':'bytes'),draining:(used.find(x=>x.resourcePoolId===r.resourcePoolId)?.amount??0)>r.amount,drainMs:this.sample(null,'ms')})),
    executors:executors,links:this.links,credits:this.queue.capacityCredits(executors.map(e=>e.resources),limits,used,this.idle())};
   if(this.energyGate!==null)profile.energyGate=this.energyGate;
   const queued=this.queue.queuedFacts(monotonic(),this.transport.now(),profile.domain);if(queued!==undefined)profile.queued=queued.filter(q=>!s.state.entries.some(e=>e.record.attemptId===q.attemptId));
   const facts=this.timings.sample(s.state.entries,monotonic(),this.transport.now(),profile.domain);if(facts!==undefined)profile.inFlight=facts;
   if(!validDeviceProfileV2(profile))throw Error('PROFILE_INVALID');this.enqueue(s,'DeviceProfile',profile);
  }));await this.flush();
 }
 private async probeLinks():Promise<void>{
  const epoch=factory.id(),links:LinkV2[]=[];
  for(const mode of ['upload','download']){
   const rows:Observation[]=[];let relay='';
   for(const size of [1024,8192,32768]){const start=monotonic();const payload:ProbePayload={mode,bytes:size};if(mode==='upload')payload.padding='x'.repeat(size);const reply=await this.transport.json('/v2/link-probe',payload) as Probe;if(reply.padding!==(mode==='upload'?'':'x'.repeat(size))||relay!==''&&relay!==reply.relayId)throw Error('LINK_PROBE_INVALID');relay=reply.relayId;rows.push({bytes:size,durationMs:monotonic()-start});}
   const n=rows.length,mx=rows.reduce((s,r)=>s+r.bytes,0)/n,my=rows.reduce((s,r)=>s+r.durationMs,0)/n,variance=rows.reduce((s,r)=>s+(r.bytes-mx)**2,0);
   let slope=rows.reduce((s,r)=>s+(r.bytes-mx)*(r.durationMs-my),0)/variance;
   // Match core fitLink: startup/jitter belongs in fixedMs, not a tiny probe's per-byte rate.
   if(!Number.isFinite(slope)||slope<=0){const largest=Math.max(...rows.map(r=>r.bytes));slope=Math.max(...rows.filter(r=>r.bytes===largest).map(r=>Math.max(1,r.durationMs)/r.bytes));}
   const source=this.installation.bootstrap.domain==='REAL'?'MEASURED':'SIMULATED';links.push({from:mode==='upload'?this.installation.paired.peer.deviceId:relay,to:mode==='upload'?relay:this.installation.paired.peer.deviceId,networkEpoch:epoch,via:null,metered:true,fixedMs:this.sample(Math.max(0,...rows.map(r=>r.durationMs-slope*r.bytes)),'ms',source),bytesPerSecond:this.sample(1000/slope,'bytes_per_second',source)});
  }this.links=links;
 }
 private async pollCancellation():Promise<void>{
  for(const id of this.offered){
   const control=await this.transport.json('/v2/executions/'+id+'/control',{} as Record<string,Object>) as ExecutionControl;
   if(!control.cancel)continue;
   const entry=this.store.read().state.entries.find(e=>e.record.attemptId===id);
   if(entry&&!entry.record.resourcesSettled)await this.store.change(new HostChange(s=>{s.state=cancelAttemptV2(s.state,id);}));
   else if(!entry){const waiter=this.waiting.get(id);if(waiter){this.waiting.delete(id);waiter.reject(Error('CANCEL_REQUESTED'));}}
  }
 }
 private async tick():Promise<void>{
  if(this.stopped||this.switching||this.refreshing)return;if(this.foreground!==this.lifecycleForeground())this.setForeground(this.lifecycleForeground());this.refreshing=true;
  try{try{const memory=hidebug.getSystemMemInfo();this.totalRam=Number(memory.totalMem)*1024;this.availableRam=Number(memory.availableMem)*1024;}catch(e){this.totalRam=null;this.availableRam=null;}try{const mode=power.getPowerMode();this.powerSaving=mode===power.DevicePowerMode.MODE_NORMAL||mode===power.DevicePowerMode.MODE_PERFORMANCE?'OFF':'ON';}catch(e){this.powerSaving=null;}this.sampleEnergy();await this.connect();if(!this.ready)return;void this.peerLinks?.sample().catch((e:Error)=>{this.peerLinks?.invalidate();this.error(e);});AppStorage.setOrCreate('deviceTotalMemoryMB',this.totalRam===null?0:Math.floor(this.totalRam/1048576));const reply:Settings=this.policy===null?await this.transport.json('/v2/device-settings',this.settingsRequest()) as Settings:{settings:null};if(reply.settings!==null)await this.adoptCeiling(reply.settings);const paused=reply.settings?.ownerMode==='paused';if(this.paused!==paused){this.paused=paused;if(!this.idle())await this.yield();}
   await this.pollCancellation();this.pumpQueue();try{await this.renew();}catch(e){this.error(e as Error);}if(this.links.length===0||this.links[0].fixedMs.sampledAt+10000<this.transport.now())await this.probeLinks();await this.profile();this.pumpQueue();if(this.idle())void this.calibrate().catch((e:Error)=>this.error(e as Error));
  }finally{this.refreshing=false;this.showStatus();}
 }
 setForeground(foreground:boolean):void {this.foreground=foreground;void (async()=>{if(!foreground){await this.yield();if(this.ready)await this.renew();}if(this.ready)await this.profile();})().catch((e:Error)=>this.error(e as Error));}
 private async yield():Promise<void>{await this.store.change(new HostChange(s=>{for(const id of this.running){const entry=s.state.entries.find(e=>e.record.attemptId===id);if(!entry||entry.record.resourcesSettled||entry.cancelRequested)continue;s.state=cancelAttemptV2(s.state,id);const notice:YieldNoticeV2={attemptId:id,kind:'RESTART',releaseMs:this.sample(null,'ms'),checkpoint:null,reasonCode:'OWNER_ACTIVE'};this.enqueue(s,'YieldNotice',notice);}}));await this.flush();}
 private digest(offer:DispatchOfferV2):string{const t=offer.task;const value:TaskDigest={inputs:t.inputs,contract:t.contract,parameters:t.parameters,allowedTargetIds:t.allowedTargetIds,allowedConfigurations:t.allowedConfigurations};return hash(bytes(canonical(value)));}
 private report(s:AgentSnapshotV2,receipt:ExecutionReceiptV2,resourceHeldMs?:number,overheadMs?:number):void{const entry=s.state.entries.find(e=>e.record.attemptId===receipt.attemptId)!;const record=entry.record;
  const actualModel=receipt.state==='SUCCEEDED'&&entry.offer.target.executorId==='harmony.image.cpu.v1'?JSON.parse(entry.offer.task.parameters) as ModelManifestV2:receipt.state==='SUCCEEDED'&&entry.offer.task.contract.capability==='photo.enhance.v1'?(this.packs.find(p=>p.manifest.contract.capability==='photo.enhance.v1')?.manifest.model??null):null;const report:ExecutionReportV2={receipt,allotmentId:record.allotmentId,allotmentVersion:record.allotmentVersion,leaseId:record.leaseId,actualModel,timings:[]};if(resourceHeldMs!==undefined)report.resourceHeldMs=resourceHeldMs;if(overheadMs!==undefined){report.overheadMs=overheadMs;report.startup='COLD';}this.enqueue(s,'ExecutionReceipt',report);}
 private waitTurn(offer:DispatchOfferV2):Promise<void>{this.waitReasons.set(offer.task.attemptId,new QueueHistory());const queued=JSON.parse(JSON.stringify(offer)) as DispatchOfferV2;queued.task.budget.deadlineAt=monotonic()+Math.max(0,offer.task.budget.deadlineAt-this.transport.now());this.queue.enqueue(queued,monotonic());return new Promise<void>((resolve,reject)=>{this.waiting.set(offer.task.attemptId,{workflowId:offer.task.workflowId,resolve,reject});this.pumpQueue();});}
 private pumpQueue():void{
  // Selected work is no longer waiting: authorization/admission may yield to
  // this periodic pump. Never remove it between durable admit and queue.start.
  for(const id of this.queue.expired(monotonic())){if(!this.waiting.has(id))continue;this.queue.removeWaiting(id);this.waiting.get(id)?.reject(Error('QUEUE_STARVED'));this.waiting.delete(id);}
  const state=this.store.read().state;
  if(this.launching||!this.ready||!this.idle()){const reason=!this.ready?'CONTROL_UNAVAILABLE':!this.idle()?'OWNER_ACTIVE':'ADMISSION_SERIALIZATION';this.waiting.forEach((_waiter:QueueWaiter,id:string)=>{this.queue.noteWait(id,reason);this.waitReasons.get(id)?.observe(monotonic(),reason,[],state.entries,_waiter.workflowId);});return;}
  const limits=this.limits(),occupied=occupiedV2(state),chosen=this.queue.choose(limits,occupied,monotonic(),this.idle());
  for(const observation of this.queue.waitingReasons(limits,occupied,this.idle(),chosen?.task.attemptId??null)){
   this.queue.noteWait(observation.attemptId,observation.reasonCode);
   const waiter=this.waiting.get(observation.attemptId);if(waiter)this.waitReasons.get(observation.attemptId)?.observe(monotonic(),observation.reasonCode,observation.resourcePoolIds,state.entries,waiter.workflowId);
  }
  if(chosen===null)return;
  const waiter=this.waiting.get(chosen.task.attemptId);if(waiter!==undefined){this.queue.noteWait(chosen.task.attemptId,'ADMISSION_SERIALIZATION');this.waitReasons.get(chosen.task.attemptId)?.observe(monotonic(),'SELECTED',[],state.entries,waiter.workflowId);this.launching=true;this.waiting.delete(chosen.task.attemptId);waiter.resolve();}
 }
 private async dispatch(message:MessageEnvelopeV2):Promise<void>{
  const offer=validateAgentOfferV2(message,this.installation.paired.peer.deviceId),id=offer.task.attemptId;
  if(this.offered.has(id))return;this.offered.add(id);
  try{
   const rejected=this.store.read().journal.rejected?.find(r=>r.attemptId===id);
   if(rejected)throw Error(rejected.digest===factory.digest(canonical(offer))?rejected.reason:'ATTEMPT_CONFLICT');
   const old=this.store.read().state.entries.find(e=>e.record.attemptId===id);
   if(old){
    if(canonical(old.offer)!==canonical(offer)||old.record.executionDigest!==this.digest(offer)){await this.store.change(new HostChange(s=>{const p:ProtocolError={version:2,code:'ATTEMPT_CONFLICT',retryable:false,messageId:message.messageId};this.enqueue(s,'ProtocolError',p);}));await this.flush();return;}
    await this.admit(offer,message,false);await this.flush();return;
   }
   if(!this.idle()||!this.ready)throw Error('OWNER_ACTIVE');
   const queueStart=monotonic();await this.waitTurn(offer);const queueEnd=monotonic();
   const authorization=await this.transport.json('/v2/executions/'+id+'/authorize',{} as Record<string,Object>) as Authorization;
   if(canonical(authorization.offer)!==canonical(offer))throw Error('OFFER_SCOPE');
   const evidence=await this.transport.json('/v2/qualification/'+offer.target.targetId) as Qualification;
   const local=this.executors().find(e=>e.target.targetId===offer.target.targetId);const a=evidence.admission;
   if(local===undefined||!validCapabilityAdmissionV2(a)||a.domain!==this.installation.bootstrap.domain||a.groupId!==offer.task.groupId||a.holderInstanceId!==this.installation.paired.peer.holderInstanceId||!['CANARY','ACTIVE'].includes(a.state)||a.quality.value===null||a.quality.sampledAt+a.quality.ttlMs<=this.transport.now()||canonical(evidence.executor.target)!==canonical(local.target)||canonical(local.contract)!==canonical(offer.task.contract)||canonical(local.resources)!==canonical(offer.resources)||a.identity!==this.executorDigest(local)||offer.allowedConfigs.some(c=>!local.configurations.some(config=>canonical(config)===canonical(c))))throw Error('CAPABILITY_NOT_QUALIFIED');
   const trace=new NativeTrace(offer,message.traceId,authorization.snapshotVersion,this.instance);const history=this.waitReasons.get(id),reasons=history?.reasons,reason=reasons===undefined||reasons.size===0?null:reasons.size>1?'OBSERVED_MIXED_WAIT':'OBSERVED_'+Array.from(reasons)[0];trace.add('QUEUE',queueStart,queueEnd,reason,history?.samples);await trace.segment('ADMIT',()=>this.admit(offer,message,true));this.queue.start(id,monotonic());this.queueStarted.add(id);this.launching=false;this.pumpQueue();this.running.add(id);
   // Admission is already durable. A transient control send must not orphan
   // its reserved slot before execute can produce a terminal receipt.
   void this.flush().catch((e:Error)=>this.error(e));
   await this.execute(offer,authorization.inputTicket,null,trace);
  }catch(e){
   if(!this.store.read().state.entries.some(x=>x.record.attemptId===id)){const reason=/^[A-Z_0-9:]+$/.test((e as Error).message)?(e as Error).message:'EXECUTION_REJECTED';await this.store.change(new HostChange(s=>{receiveAgentMessageV2(s.journal,message,s.state.groupId,factory);
    if(!s.journal.rejected)s.journal.rejected=[];
    const old=s.journal.rejected.find(r=>r.attemptId===id),digest=factory.digest(canonical(offer));
    if(old&&old.digest!==digest){const conflict:ProtocolError={version:2,code:'ATTEMPT_CONFLICT',retryable:false,messageId:message.messageId};this.enqueue(s,'ProtocolError',conflict);return;}
    const code=old?.reason??(reason==='QUEUE_STARVED'?'QUEUE_STARVED_NOT_STARTED':reason);
    if(!old)s.journal.rejected.push({attemptId:id,digest,reason:code});
    const reply:AdmissionReplyV2={attemptId:id,holderInstanceId:s.state.holderInstanceId,status:'REJECTED',reasonCode:code,record:null,wait:{value:null,source:'UNKNOWN',sampledAt:0,ttlMs:1,unit:'ms'}};this.enqueue(s,'AdmissionReply',reply,message.messageId);this.enqueue(s,'Ack',{messageId:message.messageId} as AckPayload,message.messageId);}));await this.flush();}else{await this.abortBeforeStart(id);this.error(e as Error);}
  }finally{this.waitReasons.delete(id);this.offered.delete(id);this.running.delete(id);if(this.queueStarted.has(id)){const record=this.store.read().state.entries.find(e=>e.record.attemptId===id)?.record;if(record?.resourcesSettled){this.queue.settle(id,monotonic(),record.receipt?.state==='SUCCEEDED');this.queueStarted.delete(id);}}else{try{this.queue.removeWaiting(id);}catch(e){}}this.launching=false;this.pumpQueue();}
 }
 private async abortBeforeStart(id:string):Promise<void>{
  await this.store.change(new HostChange(s=>{const entry=s.state.entries.find(e=>e.record.attemptId===id);
   if(!entry||entry.record.state!=='ACCEPTED'||entry.record.resourcesSettled)return;
   // RUNNING is persisted before invoking the engine: ACCEPTED proves it never ran.
   const receipt:ExecutionReceiptV2={attemptId:id,coordinatorEpoch:entry.record.coordinatorEpoch,planRevision:entry.record.planRevision,fence:entry.record.fence,state:'FAILED',resourcesSettled:true,outputs:[],actualTarget:entry.offer.target,actualConfiguration:entry.offer.allowedConfigs[0].id,errorCode:'ADMISSION_ABORTED_BEFORE_START'};
   s.state=settleAttemptV2(s.state,receipt);this.report(s,receipt);
  }));void this.flush().catch((e:Error)=>this.error(e));
 }
 private async admit(offer:DispatchOfferV2,message:MessageEnvelopeV2|null,live:boolean):Promise<void>{await this.store.change(new HostChange(s=>{
  if(s.journal.rejected?.some(r=>r.attemptId===offer.task.attemptId))throw Error('DISPATCH_PREVIOUSLY_REJECTED');
  const remaining=Math.min(offer.leaseMs,offer.task.budget.remainingMs,offer.task.budget.deadlineAt-this.transport.now());
  if(live&&remaining<=0&&!s.state.entries.some(e=>e.record.attemptId===offer.task.attemptId))throw Error('BUDGET_EXHAUSTED');
  const result=admitV2(s.state,offer,{now:monotonic(),coordinatorEpoch:s.journal.epoch,online:live&&this.ready,ownerIdle:live&&this.idle(),admissionLimit:this.limits(),executionDigest:this.digest(offer),leaseId:factory.id()});s.state=result.state;
  if(live&&!result.existing){const entry=s.state.entries.find(e=>e.record.attemptId===offer.task.attemptId)!;entry.deadline=Math.min(entry.deadline,monotonic()+Math.max(0,remaining));}
  if(message!==null){receiveAgentMessageV2(s.journal,message,s.state.groupId,factory);const record=JSON.parse(JSON.stringify(result.entry.record)) as AttemptRecordV2;record.state='ACCEPTED';record.resourcesSettled=false;record.receipt=null;const reply:AdmissionReplyV2={attemptId:record.attemptId,holderInstanceId:s.state.holderInstanceId,status:'ACCEPTED',reasonCode:null,record,wait:this.sample(null,'ms')};this.enqueue(s,'AdmissionReply',reply,message.messageId);this.enqueue(s,'Ack',{messageId:message.messageId} as AckPayload,message.messageId);if(result.entry.record.receipt!==null)this.report(s,result.entry.record.receipt);}
 }));}
 private async engine(capability:string,input:Uint8Array,parameters:string,id:string):Promise<EngineResult>{
  const service=this.services.find(s=>s.pack.manifest.contract.capability===capability);
  if(service){const entry=this.store.read().state.entries.find(e=>e.record.attemptId===id);if(!entry||this.policy===null||entry.offer.task.app.appInstanceId!==this.policy.identity.appInstanceId||entry.offer.task.originDeviceId!==this.installation.paired.peer.deviceId||canonical(entry.offer.task.contract)!==canonical(service.pack.manifest.contract))throw Error('SERVICE_SCOPE');
   const result=await service.execute(new Uint8Array(input),parameters,()=>this.cancelled(id));if(result.data.byteLength<1||result.data.byteLength>8388608||!entry.offer.task.contract.outputSchemas.includes(result.schemaId))throw Error('SERVICE_OUTPUT_INVALID');return result;
  }
  const pack=this.packs.find(p=>p.manifest.contract.capability===capability);
  return executeLocal(capability,{context:this.context,input,parameters,model:pack?.manifest.model??null,cancelled:()=>this.cancelled(id)});

 }
 private cancelled(id:string):boolean{return this.store.isCancelled(id,monotonic())||!this.idle();}
 private async execute(offer:DispatchOfferV2,ticket:Ticket|null,test:ReferenceCase|null,trace:NativeTrace|null=null):Promise<EvaluationReport|null>{
  const id=offer.task.attemptId;let overheadMs:number|undefined;let outputs:ArtifactRefV2[]=[],state='FAILED',errorCode:string|null=null,report:EvaluationReport|null=null,phase='LOAD',phaseStart=monotonic();
  try{
   let input:Uint8Array;
   if(test!==null)input=referenceBytes(test.input);else{if(ticket===null||ticket.operation!=='READ'||canonical(ticket.ref)!==canonical(offer.task.inputs[0]))throw Error('ARTIFACT_SCOPE');const local=offer.transferPlan.length===0&&this.inputs!==null;if(local&&(offer.task.app.appInstanceId!==this.policy?.identity.appInstanceId||offer.task.originDeviceId!==this.installation.paired.peer.deviceId))throw Error('LOCAL_INPUT_SCOPE');const cached=local?await this.inputs!.read(ticket.ref.contentHash):null;if(local&&cached===null)throw Error('SDK_INPUT_NOT_REGISTERED');const download=async():Promise<Uint8Array>=>await this.transport.request('/v2/artifacts/'+ticket!.ref.artifactId+'/'+ticket!.ref.contentVersion,null,http.RequestMethod.GET,{'Authorization':'Bearer '+ticket!.token,'X-Device-Credential':this.transport.credential});input=cached??(trace===null?await download():await trace.transfer('READ',download));if(input.byteLength!==ticket.bytes)throw Error('TRANSFER_SIZE');}
   if(hash(input)!==offer.task.inputs[0].contentHash)throw Error('INPUT_HASH');trace?.add(phase,phaseStart,monotonic());phaseStart=-1;if(this.cancelled(id))throw Error('CANCELLED_SETTLED');
   await this.store.change(new HostChange(s=>{s.state=startAttemptV2(s.state,id,monotonic());}));const computeStart=monotonic();this.timings.start(id,computeStart,input.byteLength,offer.target.executorId==='harmony.image.cpu.v1'?'COLD':'UNKNOWN');phase='EXECUTE';phaseStart=computeStart;const result=await this.engine(offer.task.contract.capability,input,offer.task.parameters,id);const executeEnd=monotonic(),wall=executeEnd-computeStart;
   if(result.overheadMs!==undefined&&Number.isFinite(result.overheadMs)&&result.overheadMs>=0&&result.overheadMs<=wall)overheadMs=result.overheadMs;
   if(test!==null){const compute=this.sample(wall-(overheadMs??0),'ms','PRIOR'),cold=this.sample(overheadMs??0,'ms','PRIOR');compute.ttlMs=3600000;cold.ttlMs=3600000;this.costs.set(offer.task.contract.capability,{compute,cold});}
   trace?.add(phase,phaseStart,executeEnd);phaseStart=-1;if(this.cancelled(id))throw Error('CANCELLED_SETTLED');phase='PUBLISH';phaseStart=monotonic();
   if(test!==null){if(result.data.byteLength>test.maxOutputBytes)throw Error('EVALUATION_OUTPUT_LIMIT');report={settled:true,permitId:id,domain:this.installation.bootstrap.domain,output:base64.encodeToStringSync(result.data),durationMs:wall};if(overheadMs!==undefined)report.overheadMs=overheadMs;await this.db.put('evaluation:'+id,JSON.stringify(report));outputs=[{artifactId:id,contentVersion:1,contentHash:hash(result.data),schemaId:result.schemaId,schemaVersion:1}];}
   else{const publish:PublishInput={bytes:result.data.byteLength,contentHash:hash(result.data),schemaId:result.schemaId};const destination=await this.transport.json('/v2/executions/'+id+'/output',publish) as OutputTicket;const t=destination.ticket;if(t.operation!=='WRITE'||t.bytes!==result.data.byteLength||t.ref.contentHash!==hash(result.data)||t.ref.schemaId!==result.schemaId)throw Error('ARTIFACT_SCOPE');if(destination.delivery==='LOCAL'){if(this.inputs===null||this.policy?.identity.appInstanceId!==offer.task.app.appInstanceId||offer.task.originDeviceId!==this.installation.paired.peer.deviceId)throw Error('LOCAL_OUTPUT_SCOPE');await this.inputs.stage(t.ref.contentHash,t.bytes,result.data);}else{const upload=async():Promise<Uint8Array>=>await this.transport.request('/v2/artifacts/'+t.ref.artifactId+'/'+t.ref.contentVersion,null,http.RequestMethod.PUT,{'Authorization':'Bearer '+t.token,'X-Device-Credential':this.transport.credential,'Content-Type':'application/octet-stream'},result.data);if(trace===null)await upload();else await trace.transfer('WRITE',upload);}outputs=[t.ref];}
   trace?.add(phase,phaseStart,monotonic());phaseStart=-1;state='SUCCEEDED';
  }catch(e){if(phaseStart>=0)trace?.add(phase,phaseStart,monotonic(),'PHASE_FAILED');errorCode=/^[A-Z_]+$/.test((e as Error).message)?(e as Error).message:'EXECUTION_FAILED';if(this.cancelled(id)||errorCode==='CANCELLED_SETTLED')state='CANCELLED_SETTLED';}
  // Persist telemetry with the receipt: a later quota ACK or socket failure must
  // not discard the completed execution's only phase measurements.
  await this.store.change(new HostChange(s=>{const entry=s.state.entries.find(x=>x.record.attemptId===id)!;const receipt:ExecutionReceiptV2={attemptId:id,coordinatorEpoch:offer.task.coordinatorEpoch,planRevision:offer.task.planRevision,fence:entry.record.fence,state,resourcesSettled:true,outputs,actualTarget:offer.target,actualConfiguration:offer.allowedConfigs[0].id,errorCode};s.state=settleAttemptV2(s.state,receipt);if(test===null){const admittedAt=entry.deadline-Math.min(offer.leaseMs,offer.task.budget.remainingMs);this.report(s,receipt,entry.record.ledgerEpoch===s.state.ledgerEpoch?Math.max(0,monotonic()-admittedAt):undefined,overheadMs);if(trace!==null&&trace.spans.length>0)this.enqueue(s,'TraceBatch',{spans:trace.spans} as TraceBatch);}}));
  const settled=this.store.read().state.entries.find(e=>e.record.attemptId===id);if(settled)this.timings.finish(settled,monotonic());
  if(test!==null&&report===null){report={settled:true,permitId:id,domain:this.installation.bootstrap.domain,output:'',durationMs:0};if(state==='FAILED'&&errorCode)report.errorCode=errorCode;else report.interrupted=true;await this.db.put('evaluation:'+id,JSON.stringify(report));}
  await this.ackQuota();await this.flush();return report;
 }
 private executorDigest(e:ExecutorV2):string{const value:ExecutorDigest={target:e.target,contract:e.contract,model:e.model,resources:e.resources,configurations:e.configurations};return hash(bytes(canonical(value)));}
 private async admitEvaluation(offer:DispatchOfferV2):Promise<void>{
  // Evaluation admission shares the business queue's reservation gate. A claim
  // made before a task arrived must not steal its selected CPU slot.
  if(this.launching||this.offered.size>0)throw Error('EVALUATION_DEFERRED');
  this.launching=true;
  try{await this.admit(offer,null,true);}finally{this.launching=false;this.pumpQueue();}
 }
 private async calibrate():Promise<void>{
  if(this.calibrating||!this.ready||!this.idle()||this.store.read().state.grant===null)return;this.calibrating=true;
  try{
   const work=(await this.transport.json('/v2/evaluations/claim',{} as Record<string,Object>) as Claim).work;if(work===null)return;
   const permit=work.permit,pack=this.packs.find(x=>x.digest===permit.packDigest),test=pack?.cases.find(x=>x.id===permit.caseId),state=this.store.read().state;
   if(permit.groupId!==state.groupId||permit.holderInstanceId!==state.holderInstanceId||permit.domain!==this.installation.bootstrap.domain||work.executor.target.deviceId!==state.deviceId)throw Error('EVALUATION_SCOPE');
   const previous=state.entries.find(x=>x.record.attemptId===permit.id);
   if(work.mode==='RECONCILE'&&previous?.record.resourcesSettled){
    if(previous.offer.target.targetId!==permit.targetId||previous.offer.task.inputs[0].contentHash!==permit.inputHash)throw Error('EVALUATION_SCOPE');
    const saved=await this.db.get('evaluation:'+permit.id);let recovered:EvaluationReport;
    if(saved!==null)recovered=JSON.parse(saved) as EvaluationReport;
    else{recovered={settled:true,permitId:permit.id,domain:permit.domain,output:'',durationMs:0};const receipt=previous.record.receipt;if(receipt?.state==='FAILED'&&receipt.errorCode)recovered.errorCode=receipt.errorCode;else recovered.interrupted=true;}
    await this.transport.json('/v2/evaluations/'+permit.id+'/report',recovered);return;
   }
   // Admission records survive ledger recovery. An absent admission in a retired
   // generation proves non-execution; an unknown current-generation claim does not.
   if(work.mode==='RECONCILE'&&work.ledgerEpoch<state.ledgerEpoch&&work.deviceInstanceId!==this.instance&&!state.entries.some(x=>x.record.attemptId===permit.id)){
    const declined:EvaluationReport={notRun:true,settled:true,permitId:permit.id,domain:permit.domain,output:'',durationMs:0};
    await this.db.put('evaluation:'+permit.id,JSON.stringify(declined));
    await this.transport.json('/v2/evaluations/'+permit.id+'/report',declined);return;
   }
   // Persist and retry a declined RUN before checking mutable pack/boot metadata.
   const savedDecline=await this.db.get('evaluation:'+permit.id);
   if(savedDecline!==null&&!state.entries.some(x=>x.record.attemptId===permit.id)){
    const declined=JSON.parse(savedDecline) as EvaluationReport;
    if(declined.notRun===true&&declined.permitId===permit.id&&declined.domain===permit.domain){await this.transport.json('/v2/evaluations/'+permit.id+'/report',declined);return;}
   }
   if(pack===undefined||test===undefined||permit.groupId!==state.groupId||permit.holderInstanceId!==state.holderInstanceId||permit.domain!==this.installation.bootstrap.domain||permit.identity!==this.executorDigest(work.executor)||hash(referenceBytes(test.input))!==permit.inputHash||canonical(permit.config)!==canonical(test.config)||permit.maxOutputBytes!==test.maxOutputBytes||work.deviceInstanceId!==this.instance||work.ledgerEpoch!==state.ledgerEpoch){
    if(work.mode==='RUN'&&!state.entries.some(x=>x.record.attemptId===permit.id)){
     const declined:EvaluationReport={notRun:true,settled:true,permitId:permit.id,domain:permit.domain,output:'',durationMs:0};
     await this.db.put('evaluation:'+permit.id,JSON.stringify(declined));
     await this.transport.json('/v2/evaluations/'+permit.id+'/report',declined);return;
    }
    throw Error('EVALUATION_UNAUTHORIZED');
   }
   const old=state.entries.find(x=>x.record.attemptId===permit.id);let report:EvaluationReport|null=null;
   if(old?.record.resourcesSettled){const saved=await this.db.get('evaluation:'+permit.id);if(saved!==null)report=JSON.parse(saved) as EvaluationReport;else {report={settled:true,permitId:permit.id,domain:permit.domain,output:'',durationMs:0};const receipt=old.record.receipt;if(receipt?.state==='FAILED'&&receipt.errorCode)report.errorCode=receipt.errorCode;else report.interrupted=true;}}
   else if(work.mode==='RUN'&&old===undefined){
    const g=state.grant!;
    const offer:DispatchOfferV2={task:{groupId:state.groupId,sessionId:null,originDeviceId:state.deviceId,resultDestination:state.deviceId,workflowId:'eval-'+permit.id,nodeId:'reference',attemptId:permit.id,coordinatorEpoch:work.coordinatorEpoch,planRevision:1,app:this.policy?.identity??{groupId:state.groupId,principalId:state.holderInstanceId,appId:state.holderInstanceId,appInstanceId:state.holderInstanceId,allowedContracts:[pack.manifest.contract.contractId]},contract:pack.manifest.contract,budget:{remainingMs:permit.timeoutMs,deadlineAt:work.expiresAt},inputs:[{artifactId:'eval-input-'+permit.id,contentVersion:1,contentHash:permit.inputHash,schemaId:pack.manifest.contract.inputSchemas[0],schemaVersion:1}],allowedTargetIds:[work.executor.target.targetId],qualityTarget:'reference',privacy:'LOCAL_ONLY',priority:'REMOTE_BATCH',parameters:test.parameters,allowedConfigurations:[test.config.id],businessIdempotencyKey:null},target:work.executor.target,resources:work.executor.resources,allowedConfigs:[test.config],allotmentId:g.allotmentId,allotmentVersion:g.version,leaseMs:Math.min(permit.timeoutMs,Math.max(1,work.expiresAt-this.transport.now())),transferPlan:[],dependencies:[],reasonCode:'REFERENCE_EVALUATION'};
    try{await this.admitEvaluation(offer);this.running.add(permit.id);report=await this.execute(offer,null,test);}catch(e){if(!this.store.read().state.entries.some(x=>x.record.attemptId===permit.id)){report={notRun:true,settled:true,permitId:permit.id,domain:permit.domain,output:'',durationMs:0};await this.db.put('evaluation:'+permit.id,JSON.stringify(report));}else throw Error('EVALUATION_SETTLEMENT_UNKNOWN');}finally{this.running.delete(permit.id);}
   }
   if(report!==null)await this.transport.json('/v2/evaluations/'+permit.id+'/report',report);
  }finally{this.calibrating=false;}
 }
 async close():Promise<void>{this.stopped=true;await this.peerLinks?.close();clearInterval(this.timer);this.foreground=false;await this.yield();await this.socket?.close();await this.store.drained();NativeAgent.starting=false;}
}

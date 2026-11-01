import { common } from '@kit.AbilityKit';
import { webSocket, http } from '@kit.NetworkKit';
import { hilog, hidebug } from '@kit.PerformanceAnalysisKit';
import { power } from '@kit.BasicServicesKit';
import { cropImage } from './ImageCrop';
import { NativeTrace } from './NativeTrace';
import { AgentStoreV2, AgentSnapshotV2, AgentJournalV2, agentMessageV2, bindAgentJournalV2, receiveAgentMessageV2, validateAgentOfferV2, statusPayloadV2,
  newLedgerV2, requestGrantV2, installGrantV2, admitV2, startAttemptV2, cancelAttemptV2, settleAttemptV2, occupiedV2,
  canonical, LedgerEntryV2, ResourceAmountV2, MessageEnvelopeV2, DispatchOfferV2, AllotmentGrantV2, AllotmentAckV2, DeviceProfileV2,
  NumericSampleV2, StateSampleV2, ExecutorV2, CapabilityPackV2, ExecutionConfigV2, CapabilityAdmissionV2, validCapabilityAdmissionV2,
  MicroQueueV2, TraceSpanV2,
  PoolV2, CreditV2, TaskContractV2, TargetV2, ModelManifestV2, AttemptRecordV2, ExecutionReceiptV2, ExecutionReportV2, AdmissionReplyV2, YieldNoticeV2, ArtifactRefV2, LinkV2, validMessageEnvelopeV2, validDeviceProfileV2 } from 'scheduler';
import { NativeDatabase, NativeTransport, Bootstrap, Paired, Installation, Contribution, bytes, text, hash, factory, monotonic, base64 } from './NativePlatform';
interface ReferenceCase {id:string;input:string;parameters:string;config:ExecutionConfigV2;maxOutputBytes:number;}
interface ReferencePack {manifest:CapabilityPackV2;digest:string;cases:ReferenceCase[];}
interface Identity {version:number;domain:string;coordinatorId:string;epoch:number;}
interface AckPayload {messageId:string;}
interface Settings {settings:Contribution|null;}
interface Qualification {executor:ExecutorV2;admission:CapabilityAdmissionV2;}
interface Ticket {token:string;ref:ArtifactRefV2;bytes:number;operation:string;expiresAt:number;}
interface Authorization {offer:DispatchOfferV2;snapshotVersion:number;inputTicket:Ticket;}
interface OutputTicket {ticket:Ticket;}
interface Permit {id:string;groupId:string;holderInstanceId:string;targetId:string;identity:string;packDigest:string;caseId:string;inputHash:string;config:ExecutionConfigV2;maxOutputBytes:number;timeoutMs:number;domain:string;}
interface Work {permit:Permit;executor:ExecutorV2;coordinatorEpoch:number;ledgerEpoch:number;deviceInstanceId:string;expiresAt:number;mode:string;}
interface Claim {work:Work|null;}
interface EvaluationReport {settled:boolean;permitId:string;domain:string;output:string;durationMs:number;}
interface TextInput {text:string;}
interface TextOutput {characters:number;words:number;lines:number;}
interface VectorInput {dimension:number;rows:number[][];}
interface VectorOutput {dimension:number;rows:number[][];norms:number[];}
interface EngineResult {data:Uint8Array;schemaId:string;}
interface Probe {relayId:string;padding:string;}
interface Observation {bytes:number;durationMs:number;}
interface ProtocolError {version:number;code:string;retryable:boolean;messageId:string;}
interface TraceBatch {spans:TraceSpanV2[];}
interface QueueWaiter {resolve:()=>void;reject:(error:Error)=>void;}
interface PairInput {inviteId:string;code:string;holderInstanceId:string;}
interface HelloPayload {versions:number[];extensions:Object[];}
function helloPayload():HelloPayload{return {versions:[2],extensions:[]};}
interface GrantRequest {ledgerEpoch:number;leaseRequestId:string;leaseMs:number;base:ResourceAmountV2[];extra:ResourceAmountV2[];}
interface SignedAck {ack:AllotmentAckV2;signature:string;}
interface ProbePayload {mode:string;bytes:number;padding?:string;}
interface TaskDigest {inputs:ArtifactRefV2[];contract:TaskContractV2;parameters:string;allowedTargetIds:string[];allowedConfigurations:string[];}
interface PublishInput {bytes:number;contentHash:string;schemaId:string;}
interface ExecutorDigest {target:TargetV2;contract:TaskContractV2;model:ModelManifestV2|null;resources:ResourceAmountV2[];configurations:ExecutionConfigV2[];}
function validContribution(p:Contribution):boolean {return !!p&&['dedicated','windows-idle','paused'].includes(p.ownerMode)&&Number.isSafeInteger(p.maxCpuThreads)&&p.maxCpuThreads>=1&&p.maxCpuThreads<=64&&Number.isSafeInteger(p.maxMemoryBytes)&&p.maxMemoryBytes>=67108864&&Number.isSafeInteger(p.reserveMemoryBytes)&&p.reserveMemoryBytes>=0;}
export class NativeAgent {
 private context:common.UIAbilityContext;
 private db:NativeDatabase;
 private store:AgentStoreV2;
 private transport:NativeTransport;
 private installation:Installation;
 private packs:ReferencePack[];
 private socket:webSocket.WebSocket|null=null;
 private stopped=false;
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
 private instance=factory.id();
 private helloId='';
 private sent=new Set<string>();
 private running=new Set<string>();
 private offered=new Set<string>();
 private queue:MicroQueueV2;
 private waiting=new Map<string,QueueWaiter>();
 private launching=false;
 private queueStarted=new Set<string>();
 private links:LinkV2[]=[];
 private costs=new Map<string,number>();
 private totalRam:number|null=null;
 private availableRam:number|null=null;
 private powerSaving:string|null=null;
 private constructor(context:common.UIAbilityContext,db:NativeDatabase,store:AgentStoreV2,transport:NativeTransport,installation:Installation,packs:ReferencePack[]){this.context=context;this.db=db;this.store=store;this.transport=transport;this.installation=installation;this.packs=packs;this.contribution=JSON.parse(JSON.stringify(installation.bootstrap.contribution)) as Contribution;this.queue=new MicroQueueV2(installation.paired.peer.deviceId,{shares:[.5,.3,.2],agingMs:1000,maxConsecutive:2,yieldDeadlineMs:1000});}
 static async start(context:common.UIAbilityContext,bootstrap:Bootstrap|null,lifecycleForeground:()=>boolean=()=>true):Promise<NativeAgent>{
  const db=await NativeDatabase.open(context),saved=await db.get('identity');let installation:Installation;
  if(saved!==null){installation=JSON.parse(saved) as Installation;if(bootstrap!==null&&installation.bootstrap.holderInstanceId!==bootstrap.holderInstanceId)throw Error('INSTALLATION_ALREADY_PAIRED');}
  else{
   if(bootstrap===null||bootstrap.invitation.version!==2||bootstrap.invitation.expiresAt<=Date.now()||!validContribution(bootstrap.contribution)||!['REAL','SIMULATED'].includes(bootstrap.domain))throw Error('INVITATION_REQUIRED');
   if(await db.get('pairing-pending')!==null)throw Error('PAIRING_RECONCILIATION_REQUIRED');
   const transport=new NativeTransport(bootstrap.invitation,context);await transport.initialize();
   const info=await transport.json('/v2/identity') as Identity;if(info.version!==2||info.domain!==bootstrap.domain)throw Error('PAIR_DOMAIN_INVALID');
   await db.put('pairing-pending',bootstrap.holderInstanceId);
   const pairInput:PairInput={inviteId:bootstrap.invitation.inviteId,code:bootstrap.invitation.code,holderInstanceId:bootstrap.holderInstanceId};const paired=await transport.json('/v2/pair',pairInput) as Paired;
   if(!/^[A-Za-z0-9_-]{43}$/.test(paired.credential)||paired.peer.groupId!==bootstrap.invitation.groupId||paired.peer.holderInstanceId!==bootstrap.holderInstanceId)throw Error('PAIR_RESPONSE_INVALID');
   installation={bootstrap,paired};await db.put('identity',JSON.stringify(installation));
  }
  const transport=new NativeTransport(installation.bootstrap.invitation,context);await transport.initialize();transport.credential=installation.paired.credential;
  const peer=installation.paired.peer,store=await AgentStoreV2.open({groupId:peer.groupId,deviceId:peer.deviceId,holderInstanceId:peer.holderInstanceId,appInstanceId:null},db.ledger());
  if(store.read().state.grant!==null&&!transport.verify(store.read().state.grant!))throw Error('LEDGER_GRANT_SIGNATURE');
  const packs=JSON.parse(text(await context.resourceManager.getRawFileContent('reference-packs.json'))) as ReferencePack[];
  const agent=new NativeAgent(context,db,store,transport,installation,packs);agent.lifecycleForeground=lifecycleForeground;agent.foreground=lifecycleForeground();await agent.restorePreferences();agent.timer=setInterval(()=>{void agent.tick().catch((e:Error)=>agent.error(e as Error));},2000);await agent.tick();return agent;
 }
 private error(e:Error):void {const code=/^[A-Z_0-9:]+$/.test(e.message)?e.message:'NATIVE_AGENT_FAILED';AppStorage.setOrCreate('agentStatus',code);hilog.error(0x0001,'HarmonyAgent','%{public}s',code);}
 private async restorePreferences():Promise<void>{
  const saved=await this.db.get('contribution');if(saved!==null){const value=JSON.parse(saved) as Contribution;if(!this.withinCeiling(value))throw Error('CONTRIBUTION_INVALID');this.contribution=value;}
  this.enabled=(await this.db.get('contribution-enabled'))!=='false';this.showPreferences();
 }
 private withinCeiling(value:Contribution):boolean {const ceiling=this.installation.bootstrap.contribution;return validContribution(value)&&value.maxCpuThreads<=ceiling.maxCpuThreads&&value.maxMemoryBytes<=ceiling.maxMemoryBytes;}
 private showPreferences():void {AppStorage.setOrCreate('cpuLimit',String(this.contribution.maxCpuThreads));AppStorage.setOrCreate('memoryLimitMB',String(this.contribution.maxMemoryBytes/1048576));AppStorage.setOrCreate('maxCpuLimit',this.installation.bootstrap.contribution.maxCpuThreads);AppStorage.setOrCreate('maxMemoryLimitMB',this.installation.bootstrap.contribution.maxMemoryBytes/1048576);AppStorage.setOrCreate('contributing',this.enabled);}
 async configure(cpu:number,memoryMB:number):Promise<void>{const next:Contribution={ownerMode:'dedicated',maxCpuThreads:cpu,maxMemoryBytes:memoryMB*1048576,reserveMemoryBytes:this.contribution.reserveMemoryBytes};if(!this.withinCeiling(next))throw Error('CONTRIBUTION_EXCEEDS_PAIRED_CEILING');this.contribution=next;await this.db.put('contribution',JSON.stringify(next));this.showPreferences();await this.tick();}
 async setEnabled(value:boolean):Promise<void>{this.enabled=value;await this.db.put('contribution-enabled',String(value));if(!value)await this.yield();this.showPreferences();if(this.ready)await this.profile();}
 private idle():boolean{return this.foreground&&this.lifecycleForeground()&&this.enabled&&!this.paused;}
 private limits():ResourceAmountV2[]{const p=this.contribution,used=occupiedV2(this.store.read().state).find(x=>x.resourcePoolId==='ram')?.amount??0;return [{resourcePoolId:'cpu',amount:this.idle()?p.maxCpuThreads:0},{resourcePoolId:'ram',amount:this.idle()&&this.availableRam!==null?Math.min(p.maxMemoryBytes,used+Math.max(0,this.availableRam-p.reserveMemoryBytes)):0}];}
 private enqueue(s:AgentSnapshotV2,type:string,payload:Object,ackOf:string|null=null):MessageEnvelopeV2 {const m=agentMessageV2(s.journal,s.state.groupId,s.state.holderInstanceId,type,payload,factory,ackOf);s.journal.outbox.push(m);return m;}
 private async flush():Promise<void>{if(this.socket===null)return;for(const m of this.store.read().journal.outbox){if(!this.welcomed&&m.type!=='Hello'||this.sent.has(m.messageId))continue;this.sent.add(m.messageId);await this.socket.send(JSON.stringify(m));if(m.type==='Ack')await this.store.change({apply:s=>{s.journal.outbox=s.journal.outbox.filter(x=>x.messageId!==m.messageId);}});}}
 private async connect():Promise<void>{
  if(this.connecting||this.socket!==null||this.stopped)return;this.connecting=true;
  try{
   const info=await this.transport.json('/v2/identity') as Identity;if(info.domain!==this.installation.bootstrap.domain||info.version!==2)throw Error('IDENTITY_INVALID');
   await this.store.change({apply:s=>{s.journal=bindAgentJournalV2(s.journal,info.coordinatorId,info.epoch);}});
   const socket=webSocket.createWebSocket();this.socket=socket;this.sent.clear();this.welcomed=false;
   socket.on('message',(_error,data)=>{if(typeof data!=='string'){void socket.close();return;}this.work=this.work.then(()=>this.message(JSON.parse(data) as MessageEnvelopeV2)).catch((e:Error)=>{this.error(e as Error);void socket.close();});});
   socket.on('close',()=>{this.ready=false;if(this.socket===socket)this.socket=null;this.sent.clear();});
   socket.on('error',()=>{this.ready=false;void socket.close();});
   await this.transport.connect(socket);
   await this.store.change({apply:s=>{s.journal.outbox=s.journal.outbox.filter(x=>x.type!=='Hello');const m=this.enqueue(s,'Hello',helloPayload());this.helloId=m.messageId;}});await this.flush();
  }finally{this.connecting=false;}
 }
 private async message(m:MessageEnvelopeV2):Promise<void>{
  const saved=this.store.read(),j=saved.journal;
  if(!validMessageEnvelopeV2(m,[])||m.groupId!==saved.state.groupId||m.senderInstanceId!==j.coordinatorId||m.coordinatorEpoch!==j.epoch)throw Error('SERVER_MESSAGE_INVALID');
  if(m.type==='Ack'){
   const payload=JSON.parse(m.payload) as AckPayload;if(Object.keys(payload).join('|')!=='messageId'||payload.messageId!==m.ackOf)throw Error('ACK_INVALID');
   const old=j.outbox.find(x=>x.messageId===payload.messageId);if(payload.messageId===this.helloId)this.welcomed=true;
   await this.store.change({apply:s=>{s.journal.outbox=s.journal.outbox.filter(x=>x.messageId!==payload.messageId);if(payload.messageId===this.helloId)this.enqueue(s,'RecoveryRequest',{} as Record<string,Object>);}});
   if(old?.type==='RecoveryRequest'){this.ready=true;AppStorage.setOrCreate('agentStatus','已连接 · 前台贡献');void this.tick().catch((e:Error)=>this.error(e as Error));}
  }else if(m.type==='AttemptStatusQuery'){
   await this.store.change({apply:s=>{const fresh=receiveAgentMessageV2(s.journal,m,s.state.groupId,factory);if(fresh)this.enqueue(s,'AttemptStatusReply',statusPayloadV2(m,s.state.groupId,s.state.holderInstanceId,s.state.entries.map(e=>e.record)),m.messageId);this.enqueue(s,'Ack',{messageId:m.messageId} as AckPayload,m.messageId);}});
  }else if(m.type==='EvaluationChanged'){if(this.ready)void this.calibrate().catch((e:Error)=>this.error(e as Error));}
  else if(m.type==='DispatchOffer'){if(this.ready)void this.dispatch(m).catch((e:Error)=>this.error(e as Error));}
  else throw Error('SERVER_MESSAGE_UNSUPPORTED');await this.flush();
 }
 private async renew():Promise<void>{
  if(this.grantBusy||!this.ready)return;this.grantBusy=true;
  try{
   const id=factory.id();await this.store.change({apply:s=>{s.state=requestGrantV2(s.state,id,monotonic());}});const state=this.store.read().state;
   const request:GrantRequest={ledgerEpoch:state.ledgerEpoch,leaseRequestId:id,leaseMs:60000,base:[],extra:[{resourcePoolId:'cpu',amount:this.contribution.maxCpuThreads},{resourcePoolId:'ram',amount:this.contribution.maxMemoryBytes}]};const grant=await this.transport.json('/v2/allotments/request',request) as AllotmentGrantV2;
   const verified=this.transport.verify(grant);await this.store.change({apply:s=>{s.state=installGrantV2(s.state,grant,verified,monotonic());}});await this.ackQuota();
  }finally{this.grantBusy=false;}
 }
 private async ackQuota():Promise<void>{const state=this.store.read().state,g=state.grant;if(g===null)return;const ack:AllotmentAckV2={allotmentId:g.allotmentId,holderInstanceId:state.holderInstanceId,ledgerEpoch:g.ledgerEpoch,coordinatorEpoch:g.coordinatorEpoch,version:g.version,persisted:true,settlementSeq:state.settlementSeq,occupied:occupiedV2(state)};const signed:SignedAck={ack,signature:await this.transport.ackSignature(ack)};await this.transport.json('/v2/allotments/ack',signed);}
 private sample(value:number|null,unit:string,source:string='PRIOR'):NumericSampleV2{return {value,unit,source:value===null?'UNKNOWN':source,sampledAt:this.transport.now(),ttlMs:15000};}
 private status(value:string|null):StateSampleV2{return {value,unit:'state',source:value===null?'UNKNOWN':'PRIOR',sampledAt:this.transport.now(),ttlMs:15000};}
 private credits(limits:ResourceAmountV2[],used:ResourceAmountV2[]):CreditV2[]{const demands=new Map<string,ResourceAmountV2[]>();for(const priority of ['ORIGIN_INTERACTIVE','REMOTE_INTERACTIVE','REMOTE_BATCH'])demands.set(priority,this.packs[0].manifest.resourceLimit);return this.queue.credits(demands,limits,used,this.idle());}
 private executors():ExecutorV2[]{return this.packs.map(pack=>({target:{targetId:'harmony-'+hash(bytes(this.installation.paired.peer.holderInstanceId+':'+pack.manifest.contract.capability)).slice(0,32),deviceId:this.installation.paired.peer.deviceId,executorId:'harmony.cpu.v1',executorVersion:'1',backend:'CPU',resourcePoolIds:['cpu','ram'],stableExecutionId:'harmony.cpu.v1'},contract:pack.manifest.contract,model:null,resources:pack.manifest.resourceLimit,configurations:[pack.cases[0].config],compute:this.sample(this.costs.get(pack.manifest.contract.capability)??null,'ms',this.installation.bootstrap.domain==='REAL'?'MEASURED':'SIMULATED'),queue:this.sample(0,'ms'),cold:this.sample(0,'ms'),publish:this.sample(0,'ms'),uncertainty:this.sample(0,'ms')} as ExecutorV2));}
  private async profile():Promise<void>{
  await this.store.change({apply:s=>{
   if(s.journal.outbox.some(m=>m.type==='DeviceProfile'))return;const used=occupiedV2(s.state),limits=this.limits();
   const profile:DeviceProfileV2={deviceId:s.state.deviceId,deviceInstanceId:this.instance,holderInstanceId:s.state.holderInstanceId,ledgerEpoch:s.state.ledgerEpoch,sequence:s.journal.sequence+1,domain:this.installation.bootstrap.domain,
    ownerActivity:this.status(this.idle()?'IDLE':'ACTIVE'),foreground:this.status(this.foreground&&this.lifecycleForeground()?'FOREGROUND':'BACKGROUND'),charging:this.status(null),powerSave:this.status(this.powerSaving),battery:this.sample(null,'percent'),temperature:this.sample(null,'level'),
    pools:limits.map((r:ResourceAmountV2):PoolV2=>({resourcePoolId:r.resourcePoolId,kind:r.resourcePoolId==='cpu'?'CPU_SLOTS':'RAM_BYTES',exclusive:false,total:this.sample(r.resourcePoolId==='cpu'?this.contribution.maxCpuThreads:this.totalRam,r.resourcePoolId==='cpu'?'slots':'bytes',r.resourcePoolId==='cpu'?'PRIOR':this.installation.bootstrap.domain==='REAL'?'MEASURED':'SIMULATED'),ownerReserved:0,contributionLimit:r.resourcePoolId==='cpu'?this.contribution.maxCpuThreads:this.contribution.maxMemoryBytes,admissionLimit:this.sample(r.amount,r.resourcePoolId==='cpu'?'slots':'bytes'),occupied:this.sample(used.find(x=>x.resourcePoolId===r.resourcePoolId)?.amount??0,r.resourcePoolId==='cpu'?'slots':'bytes'),draining:(used.find(x=>x.resourcePoolId===r.resourcePoolId)?.amount??0)>r.amount,drainMs:this.sample(null,'ms')})),
    executors:this.executors(),links:this.links,credits:this.credits(limits,used)};
   if(!validDeviceProfileV2(profile))throw Error('PROFILE_INVALID');this.enqueue(s,'DeviceProfile',profile);
  }});await this.flush();
 }
 private async probeLinks():Promise<void>{
  const epoch=factory.id(),links:LinkV2[]=[];
  for(const mode of ['upload','download']){
   const rows:Observation[]=[];let relay='';
   for(const size of [1024,8192,32768]){const start=monotonic();const payload:ProbePayload={mode,bytes:size};if(mode==='upload')payload.padding='x'.repeat(size);const reply=await this.transport.json('/v2/link-probe',payload) as Probe;if(reply.padding!==(mode==='upload'?'':'x'.repeat(size))||relay!==''&&relay!==reply.relayId)throw Error('LINK_PROBE_INVALID');relay=reply.relayId;rows.push({bytes:size,durationMs:monotonic()-start});}
   const n=rows.length,mx=rows.reduce((s,r)=>s+r.bytes,0)/n,my=rows.reduce((s,r)=>s+r.durationMs,0)/n,variance=rows.reduce((s,r)=>s+(r.bytes-mx)**2,0);
   let slope=rows.reduce((s,r)=>s+(r.bytes-mx)*(r.durationMs-my),0)/variance;if(!Number.isFinite(slope)||slope<=0)slope=Math.max(...rows.map(r=>Math.max(1,r.durationMs)/r.bytes));
   const source=this.installation.bootstrap.domain==='REAL'?'MEASURED':'SIMULATED';links.push({from:mode==='upload'?this.installation.paired.peer.deviceId:relay,to:mode==='upload'?relay:this.installation.paired.peer.deviceId,networkEpoch:epoch,via:null,metered:true,fixedMs:this.sample(Math.max(0,...rows.map(r=>r.durationMs-slope*r.bytes)),'ms',source),bytesPerSecond:this.sample(1000/slope,'bytes_per_second',source)});
  }this.links=links;
 }
 private async tick():Promise<void>{
  if(this.stopped||this.refreshing)return;this.refreshing=true;
  try{try{const memory=hidebug.getSystemMemInfo();this.totalRam=Number(memory.totalMem)*1024;this.availableRam=Number(memory.availableMem)*1024;}catch(e){this.totalRam=null;this.availableRam=null;}try{const mode=power.getPowerMode();this.powerSaving=mode===power.DevicePowerMode.MODE_NORMAL||mode===power.DevicePowerMode.MODE_PERFORMANCE?'OFF':'ON';}catch(e){this.powerSaving=null;}await this.connect();if(!this.ready)return;const reply=await this.transport.json('/v2/device-settings',{} as Record<string,Object>) as Settings;const paused=reply.settings?.ownerMode==='paused';if(this.paused!==paused){this.paused=paused;if(!this.idle())await this.yield();}
   this.pumpQueue();try{await this.renew();}catch(e){this.error(e as Error);}if(this.links.length===0||this.links[0].fixedMs.sampledAt+10000<this.transport.now())await this.probeLinks();await this.profile();this.pumpQueue();if(this.idle())void this.calibrate().catch((e:Error)=>this.error(e as Error));
  }finally{this.refreshing=false;}
 }
 setForeground(foreground:boolean):void {this.foreground=foreground;void (async()=>{if(!foreground)await this.yield();if(this.ready)await this.profile();})().catch((e:Error)=>this.error(e as Error));}
 private async yield():Promise<void>{await this.store.change({apply:s=>{for(const id of this.running){const entry=s.state.entries.find(e=>e.record.attemptId===id);if(!entry||entry.record.resourcesSettled||entry.cancelRequested)continue;s.state=cancelAttemptV2(s.state,id);const notice:YieldNoticeV2={attemptId:id,kind:'RESTART',releaseMs:this.sample(null,'ms'),checkpoint:null,reasonCode:'OWNER_ACTIVE'};this.enqueue(s,'YieldNotice',notice);}}});await this.flush();}
 private digest(offer:DispatchOfferV2):string{const t=offer.task;const value:TaskDigest={inputs:t.inputs,contract:t.contract,parameters:t.parameters,allowedTargetIds:t.allowedTargetIds,allowedConfigurations:t.allowedConfigurations};return hash(bytes(canonical(value)));}
 private report(s:AgentSnapshotV2,receipt:ExecutionReceiptV2):void{const record=s.state.entries.find(e=>e.record.attemptId===receipt.attemptId)!.record;const report:ExecutionReportV2={receipt,allotmentId:record.allotmentId,allotmentVersion:record.allotmentVersion,leaseId:record.leaseId,actualModel:null,timings:[]};this.enqueue(s,'ExecutionReceipt',report);}
 private waitTurn(offer:DispatchOfferV2):Promise<void>{const queued=JSON.parse(JSON.stringify(offer)) as DispatchOfferV2;queued.task.budget.deadlineAt=monotonic()+Math.max(0,offer.task.budget.deadlineAt-this.transport.now());this.queue.enqueue(queued,monotonic());return new Promise<void>((resolve,reject)=>{this.waiting.set(offer.task.attemptId,{resolve,reject});this.pumpQueue();});}
 private pumpQueue():void{
  for(const id of this.queue.expired(monotonic())){this.queue.removeWaiting(id);this.waiting.get(id)?.reject(Error('QUEUE_STARVED'));this.waiting.delete(id);}
  if(this.launching||!this.ready||!this.idle())return;
  const chosen=this.queue.choose(this.limits(),occupiedV2(this.store.read().state),monotonic(),this.idle());if(chosen===null)return;
  const waiter=this.waiting.get(chosen.task.attemptId);if(waiter!==undefined){this.launching=true;this.waiting.delete(chosen.task.attemptId);waiter.resolve();}
 }
 private async dispatch(message:MessageEnvelopeV2):Promise<void>{
  const offer=validateAgentOfferV2(message,this.installation.paired.peer.deviceId),id=offer.task.attemptId;
  if(this.offered.has(id))return;this.offered.add(id);
  try{
   const old=this.store.read().state.entries.find(e=>e.record.attemptId===id);
   if(old){
    if(canonical(old.offer)!==canonical(offer)||old.record.executionDigest!==this.digest(offer)){await this.store.change({apply:s=>{const p:ProtocolError={version:2,code:'ATTEMPT_CONFLICT',retryable:false,messageId:message.messageId};this.enqueue(s,'ProtocolError',p);}});await this.flush();return;}
    await this.admit(offer,message,false);await this.flush();return;
   }
   if(!this.idle()||!this.ready)throw Error('OWNER_ACTIVE');
   const queueStart=monotonic();await this.waitTurn(offer);const queueEnd=monotonic();
   const authorization=await this.transport.json('/v2/executions/'+id+'/authorize',{} as Record<string,Object>) as Authorization;
   if(canonical(authorization.offer)!==canonical(offer))throw Error('OFFER_SCOPE');
   const evidence=await this.transport.json('/v2/qualification/'+offer.target.targetId) as Qualification;
   const local=this.executors().find(e=>e.target.targetId===offer.target.targetId);const a=evidence.admission;
   if(local===undefined||!validCapabilityAdmissionV2(a)||a.domain!==this.installation.bootstrap.domain||a.groupId!==offer.task.groupId||a.holderInstanceId!==this.installation.paired.peer.holderInstanceId||!['CANARY','ACTIVE'].includes(a.state)||a.quality.value===null||a.quality.sampledAt+a.quality.ttlMs<=this.transport.now()||canonical(evidence.executor.target)!==canonical(local.target)||canonical(local.contract)!==canonical(offer.task.contract)||canonical(local.resources)!==canonical(offer.resources)||a.identity!==this.executorDigest(local)||offer.allowedConfigs.some(c=>!local.configurations.some(config=>canonical(config)===canonical(c))))throw Error('CAPABILITY_NOT_QUALIFIED');
   const trace=new NativeTrace(offer,message.traceId,authorization.snapshotVersion,this.instance);trace.add('QUEUE',queueStart,queueEnd);await trace.segment('ADMIT',()=>this.admit(offer,message,true));this.queue.start(id,monotonic());this.queueStarted.add(id);this.launching=false;this.pumpQueue();this.running.add(id);await this.flush();await this.execute(offer,authorization.inputTicket,null,trace);
   try{await this.store.change({apply:s=>{this.enqueue(s,'TraceBatch',{spans:trace.spans} as TraceBatch);}});await this.flush();}catch(e){}
  }catch(e){
   if(!this.store.read().state.entries.some(x=>x.record.attemptId===id)){const reason=/^[A-Z_0-9:]+$/.test((e as Error).message)?(e as Error).message:'EXECUTION_REJECTED';await this.store.change({apply:s=>{receiveAgentMessageV2(s.journal,message,s.state.groupId,factory);const reply:AdmissionReplyV2={attemptId:id,holderInstanceId:s.state.holderInstanceId,status:'REJECTED',reasonCode:reason,record:null,wait:this.sample(null,'ms')};this.enqueue(s,'AdmissionReply',reply,message.messageId);this.enqueue(s,'Ack',{messageId:message.messageId} as AckPayload,message.messageId);}});await this.flush();}else this.error(e as Error);
  }finally{this.offered.delete(id);this.running.delete(id);if(this.queueStarted.has(id)){if(this.store.read().state.entries.find(e=>e.record.attemptId===id)?.record.resourcesSettled){this.queue.settle(id,monotonic());this.queueStarted.delete(id);}}else{try{this.queue.removeWaiting(id);}catch(e){}}this.launching=false;this.pumpQueue();}
 }
 private async admit(offer:DispatchOfferV2,message:MessageEnvelopeV2|null,live:boolean):Promise<void>{await this.store.change({apply:s=>{
  const result=admitV2(s.state,offer,{now:monotonic(),coordinatorEpoch:s.journal.epoch,online:live&&this.ready,ownerIdle:live&&this.idle(),admissionLimit:this.limits(),executionDigest:this.digest(offer),leaseId:factory.id()});s.state=result.state;
  if(message!==null){receiveAgentMessageV2(s.journal,message,s.state.groupId,factory);const record=JSON.parse(JSON.stringify(result.entry.record)) as AttemptRecordV2;record.state='ACCEPTED';record.resourcesSettled=false;record.receipt=null;const reply:AdmissionReplyV2={attemptId:record.attemptId,holderInstanceId:s.state.holderInstanceId,status:'ACCEPTED',reasonCode:null,record,wait:this.sample(null,'ms')};this.enqueue(s,'AdmissionReply',reply,message.messageId);this.enqueue(s,'Ack',{messageId:message.messageId} as AckPayload,message.messageId);if(result.entry.record.receipt!==null)this.report(s,result.entry.record.receipt);}
 }});}
 private async engine(capability:string,input:Uint8Array,parameters:string):Promise<EngineResult>{
  if(capability==='image.crop.v1')return {data:await cropImage(input,parameters),schemaId:'image.raster'};
  if(capability==='text.count.v1'){const v=JSON.parse(text(input)) as TextInput;if(Object.keys(v).join('|')!=='text'||typeof v.text!=='string')throw Error('TEXT_INVALID');const output:TextOutput={characters:Array.from(v.text).length,words:v.text.trim()?v.text.trim().split(/\s+/u).length:0,lines:v.text.length?v.text.split(/\r\n|\r|\n/u).length:0};return {data:bytes(JSON.stringify(output)),schemaId:'text.counts'};}
  if(capability==='vector.normalize.v1'){const v=JSON.parse(text(input)) as VectorInput;if(Object.keys(v).sort().join('|')!=='dimension|rows'||!Number.isSafeInteger(v.dimension)||v.dimension<1||v.dimension>65536||!Array.isArray(v.rows)||v.rows.length>100000||v.rows.some(r=>!Array.isArray(r)||r.length!==v.dimension||r.some(n=>!Number.isFinite(n))))throw Error('VECTOR_INVALID');const output:VectorOutput={dimension:v.dimension,rows:[],norms:[]};for(const row of v.rows){const norm=Math.hypot(...row);if(!Number.isFinite(norm))throw Error('VECTOR_NORM_INVALID');output.norms.push(norm);output.rows.push(row.map(n=>norm===0?0:n/norm));}return {data:bytes(JSON.stringify(output)),schemaId:'vector.normalized'};}
  throw Error('CAPABILITY_UNSUPPORTED');
 }
 private cancelled(id:string):boolean{const e=this.store.read().state.entries.find(x=>x.record.attemptId===id);return !e||e.cancelRequested||monotonic()>=e.deadline||!this.idle();}
 private async execute(offer:DispatchOfferV2,ticket:Ticket|null,test:ReferenceCase|null,trace:NativeTrace|null=null):Promise<EvaluationReport|null>{
  const id=offer.task.attemptId,start=monotonic();let outputs:ArtifactRefV2[]=[],state='FAILED',errorCode:string|null=null,report:EvaluationReport|null=null,phase='LOAD',phaseStart=monotonic();
  try{
   let input:Uint8Array;
   if(test!==null)input=base64.decodeSync(test.input);else{if(ticket===null||ticket.operation!=='READ'||canonical(ticket.ref)!==canonical(offer.task.inputs[0]))throw Error('ARTIFACT_SCOPE');input=await this.transport.request('/v2/artifacts/'+ticket.ref.artifactId+'/'+ticket.ref.contentVersion,null,http.RequestMethod.GET,{'Authorization':'Bearer '+ticket.token,'X-Device-Credential':this.transport.credential});if(input.byteLength!==ticket.bytes)throw Error('TRANSFER_SIZE');}
   if(hash(input)!==offer.task.inputs[0].contentHash)throw Error('INPUT_HASH');trace?.add(phase,phaseStart,monotonic());phaseStart=-1;if(this.cancelled(id))throw Error('CANCELLED_SETTLED');
   await this.store.change({apply:s=>{s.state=startAttemptV2(s.state,id,monotonic());}});const computeStart=monotonic();phase='EXECUTE';phaseStart=computeStart;const result=await this.engine(offer.task.contract.capability,input,offer.task.parameters);this.costs.set(offer.task.contract.capability,monotonic()-computeStart);trace?.add(phase,phaseStart,monotonic());phaseStart=-1;if(this.cancelled(id))throw Error('CANCELLED_SETTLED');phase='PUBLISH';phaseStart=monotonic();
   if(test!==null){if(result.data.byteLength>test.maxOutputBytes)throw Error('EVALUATION_OUTPUT_LIMIT');report={settled:true,permitId:id,domain:this.installation.bootstrap.domain,output:base64.encodeToStringSync(result.data),durationMs:monotonic()-start};await this.db.put('evaluation:'+id,JSON.stringify(report));outputs=[{artifactId:id,contentVersion:1,contentHash:hash(result.data),schemaId:result.schemaId,schemaVersion:1}];}
   else{const publish:PublishInput={bytes:result.data.byteLength,contentHash:hash(result.data),schemaId:result.schemaId};const destination=await this.transport.json('/v2/executions/'+id+'/output',publish) as OutputTicket;const t=destination.ticket;if(t.operation!=='WRITE'||t.bytes!==result.data.byteLength||t.ref.contentHash!==hash(result.data)||t.ref.schemaId!==result.schemaId)throw Error('ARTIFACT_SCOPE');await this.transport.request('/v2/artifacts/'+t.ref.artifactId+'/'+t.ref.contentVersion,null,http.RequestMethod.PUT,{'Authorization':'Bearer '+t.token,'X-Device-Credential':this.transport.credential,'Content-Type':'application/octet-stream'},result.data);outputs=[t.ref];}
   trace?.add(phase,phaseStart,monotonic());phaseStart=-1;state='SUCCEEDED';
  }catch(e){if(phaseStart>=0)trace?.add(phase,phaseStart,monotonic(),'PHASE_FAILED');errorCode=/^[A-Z_]+$/.test((e as Error).message)?(e as Error).message:'EXECUTION_FAILED';if(this.cancelled(id)||errorCode==='CANCELLED_SETTLED')state='CANCELLED_SETTLED';}
  await this.store.change({apply:s=>{const entry=s.state.entries.find(x=>x.record.attemptId===id)!;const receipt:ExecutionReceiptV2={attemptId:id,coordinatorEpoch:offer.task.coordinatorEpoch,planRevision:offer.task.planRevision,fence:entry.record.fence,state,resourcesSettled:true,outputs,actualTarget:offer.target,actualConfiguration:offer.allowedConfigs[0].id,errorCode};s.state=settleAttemptV2(s.state,receipt);if(test===null)this.report(s,receipt);}});
  await this.ackQuota();await this.flush();return report;
 }
 private executorDigest(e:ExecutorV2):string{const value:ExecutorDigest={target:e.target,contract:e.contract,model:e.model,resources:e.resources,configurations:e.configurations};return hash(bytes(canonical(value)));}
 private async calibrate():Promise<void>{
  if(this.calibrating||!this.ready||!this.idle()||this.store.read().state.grant===null)return;this.calibrating=true;
  try{
   const work=(await this.transport.json('/v2/evaluations/claim',{} as Record<string,Object>) as Claim).work;if(work===null)return;
   const permit=work.permit,pack=this.packs.find(x=>x.digest===permit.packDigest),test=pack?.cases.find(x=>x.id===permit.caseId),state=this.store.read().state;
   if(pack===undefined||test===undefined||permit.groupId!==state.groupId||permit.holderInstanceId!==state.holderInstanceId||permit.domain!==this.installation.bootstrap.domain||permit.identity!==this.executorDigest(work.executor)||hash(base64.decodeSync(test.input))!==permit.inputHash||canonical(permit.config)!==canonical(test.config)||permit.maxOutputBytes!==test.maxOutputBytes||work.deviceInstanceId!==this.instance||work.ledgerEpoch!==state.ledgerEpoch)throw Error('EVALUATION_UNAUTHORIZED');
   const old=state.entries.find(x=>x.record.attemptId===permit.id);let report:EvaluationReport|null=null;
   if(old?.record.resourcesSettled){const saved=await this.db.get('evaluation:'+permit.id);if(saved!==null)report=JSON.parse(saved) as EvaluationReport;else report={settled:true,permitId:permit.id,domain:permit.domain,output:'',durationMs:0};}
   else if(work.mode==='RUN'&&old===undefined){
    const g=state.grant!;
    const offer:DispatchOfferV2={task:{groupId:state.groupId,sessionId:null,originDeviceId:state.deviceId,resultDestination:state.deviceId,workflowId:'eval-'+permit.id,nodeId:'reference',attemptId:permit.id,coordinatorEpoch:work.coordinatorEpoch,planRevision:1,app:{groupId:state.groupId,principalId:state.holderInstanceId,appId:state.holderInstanceId,appInstanceId:state.holderInstanceId,allowedContracts:[pack.manifest.contract.contractId]},contract:pack.manifest.contract,budget:{remainingMs:permit.timeoutMs,deadlineAt:work.expiresAt},inputs:[{artifactId:'eval-input-'+permit.id,contentVersion:1,contentHash:permit.inputHash,schemaId:pack.manifest.contract.inputSchemas[0],schemaVersion:1}],allowedTargetIds:[work.executor.target.targetId],qualityTarget:'reference',privacy:'LOCAL_ONLY',priority:'REMOTE_BATCH',parameters:test.parameters,allowedConfigurations:[test.config.id],businessIdempotencyKey:null},target:work.executor.target,resources:work.executor.resources,allowedConfigs:[test.config],allotmentId:g.allotmentId,allotmentVersion:g.version,leaseMs:Math.min(permit.timeoutMs,Math.max(1,work.expiresAt-this.transport.now())),transferPlan:[],dependencies:[],reasonCode:'REFERENCE_EVALUATION'};
    try{await this.admit(offer,null,true);this.running.add(permit.id);report=await this.execute(offer,null,test);}catch(e){if(!this.store.read().state.entries.some(x=>x.record.attemptId===permit.id)){report={settled:true,permitId:permit.id,domain:permit.domain,output:'',durationMs:0};await this.db.put('evaluation:'+permit.id,JSON.stringify(report));}else throw Error('EVALUATION_SETTLEMENT_UNKNOWN');}finally{this.running.delete(permit.id);}
   }
   if(report!==null)await this.transport.json('/v2/evaluations/'+permit.id+'/report',report);
  }finally{this.calibrating=false;}
 }
 async close():Promise<void>{this.stopped=true;clearInterval(this.timer);this.foreground=false;await this.yield();await this.socket?.close();await this.store.drained();}
}

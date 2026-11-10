import {photoVulkanExecutorId} from './photo-accelerator';
import {ArtifactDescriptor,directTransfer,SignedTransfer,transfer} from '@harmony/resource-transport';
import {ImageEncoder,imageExecutorId,cudaExecutorId} from './image-encoder';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AppIdentityV2, canonical, DeviceProfileV2, DispatchOfferV2, ExecutorV2, NumericSampleV2, occupiedV2, ResourceAmountV2 } from '@harmony/scheduler-core';
import {cpuRegistry} from './executors/registry';
import { ReferencePack, builtinReferencePacks, cpuResources, cpuConfiguration, packDigest, digest } from '@harmony/reference-capabilities';
import { DurableLedger } from './durable-ledger';
import { PcAgent } from './agent';
import { CalibrationExecutor } from './calibration-executor';
import { RecoveryConnection } from './recovery-client';
import { allotmentTransport } from './allotment-client';
import { artifactPorts } from './artifact-client';
import { collectSystemResources, windowsOwnerActivity } from './system-resources';
import { RelayLinks } from './relay-links';
import { appRequest, nodeSdkPort } from '@harmony/scheduler-client/dist/node';
import { SchedulerSdk, SdkInput } from '@harmony/scheduler-client';
import {openDataHost,discoverDataHost,DataHostConfig} from './data-host';
import {networkInterfaces} from 'node:os';
import {PeerLinks} from './peer-links';
import {cpuSchemas} from '@harmony/reference-capabilities';
import {performance} from 'node:perf_hooks';
import {pcTraceClockDomainId} from './execution-trace';

/** A capability provided by a logical service (its own catalogue, index or model). The host that
 * installs the adapter is an ordinary execution target; placement stays with the planner. */
export interface ServiceExecutionContext {/** Reference evaluation: write capabilities must run in the service's dry-run mode. */evaluation:boolean;idempotencyKey:string|null;}
export interface ServiceAdapter {pack:ReferencePack;execute(input:Buffer,parameters:string,signal:AbortSignal,context:ServiceExecutionContext):Promise<{bytes:Buffer;schemaId:string}>;}
export interface CpuHostConfig {
  dataEndpoint?:DataHostConfig|false;
  imageEncoder?:ImageEncoder;
  services?:ServiceAdapter[];
  controlIntervalMs?:number;
  directory:string;identity:{groupId:string;deviceId:string;holderInstanceId:string;appInstanceId:string|null};connection:RecoveryConnection;
  contribution:{ownerMode:'dedicated'|'windows-idle'|'paused';maxCpuThreads:number;maxMemoryBytes:number;maxVramBytes?:number;reserveMemoryBytes:number;idleThresholdMs?:number};
}
/** Standalone CPU host assembled from paired identity, owner policy, installed packs and network services. */
export class CpuHost {
  private readonly packs:ReferencePack[];
  private stopped=false;private timer:NodeJS.Timeout|undefined;private pending:Promise<void>|undefined;
  private limits:ResourceAmountV2[]=[];private owner:'IDLE'|'ACTIVE'|'UNKNOWN'='UNKNOWN';
  private readonly instance=randomUUID();
  private readonly costs=new Map<string,{value:number;overhead?:number;at:number}>();
  private clockOffset=0;
  private readonly relayLinks:RelayLinks;
  private readonly peerLinks:PeerLinks;
  private dataHost:Awaited<ReturnType<typeof openDataHost>>|undefined;
  private networkPending:Promise<void>|undefined;
  private readonly transferTelemetry=new Set<Promise<unknown>>();
  private endpointCoordinatorEpoch=0;
  private endpointNetwork='';
  private endpointRetryAt=0;
  private appPolicy:{offlineBase:ResourceAmountV2[];onlineExtra:ResourceAmountV2[];identity:AppIdentityV2}|undefined;
  readonly agent:PcAgent;
  /** App-private, content-addressed input storage; registration never sends these bytes. */
  sdk(){
    if(!this.appPolicy)throw Error('APP_HOST_REQUIRED');
    return new SchedulerSdk({...nodeSdkPort(this.config.connection),connected:()=>this.agent.ready&&!this.stopped,read:async ticket=>{
      if(ticket.operation!=='READ')throw Error('SDK_TICKET_INVALID');
      if(!/^[a-f0-9]{64}$/.test(ticket.ref.contentHash))throw Error('INPUT_HASH');
      const file=path.join(this.config.directory,'inputs',ticket.ref.contentHash);
      if(fs.existsSync(file))return fs.readFileSync(file);
      return nodeSdkPort(this.config.connection).read(ticket);
    },stageInput:(input,bytes)=>this.stageInput(input,bytes)});
  }
  private async stageInput(input:SdkInput,bytes:Uint8Array):Promise<void>{
      if(digest(Buffer.from(bytes))!==input.contentHash||bytes.length!==input.bytes)throw Error('INPUT_HASH');
      const directory=path.join(this.config.directory,'inputs');fs.mkdirSync(directory,{recursive:true});
      const target=path.join(directory,input.contentHash);
      if(fs.existsSync(target)){if(digest(fs.readFileSync(target))!==input.contentHash)throw Error('INPUT_HASH');return;}
      const used=fs.readdirSync(directory).reduce((sum,name)=>sum+fs.statSync(path.join(directory,name)).size,0);
      if(used+bytes.length>67108864)throw Error('SDK_INPUT_CACHE_FULL');
      const temporary=path.join(directory,randomUUID()+'.tmp'),fd=fs.openSync(temporary,'wx',0o600);
      try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      fs.renameSync(temporary,target);
  }
  private constructor(readonly ledger:DurableLedger,private readonly config:CpuHostConfig,private readonly onError:(e:unknown)=>void,builtins:ReferencePack[]){
    this.packs=[...builtins.filter(p=>p.manifest.contract.capability!==config.imageEncoder?.pack.manifest.contract.capability&&(!p.manifest.contract.capability.startsWith('photo.')||cpuRegistry.has(p.manifest.contract.capability))),...(config.imageEncoder?[config.imageEncoder.pack]:[]),...(config.services??[]).map(s=>s.pack)];
    if(new Set(this.packs.map(p=>p.manifest.contract.capability)).size!==this.packs.length)throw Error('SERVICE_CAPABILITY_CONFLICT');
    const request=allotmentTransport(config.connection),packs=this.packs,byDigest=new Map(packs.map(p=>[packDigest(p),p])),installed=new Map([...byDigest].flatMap(([hash,p])=>p.cases.map(c=>[hash+':'+c.id,c] as const)));
    this.relayLinks=new RelayLinks(config.identity.deviceId,config.connection.domain,request);
    this.peerLinks=new PeerLinks(config.identity.deviceId,request);
    const context=async()=>{
      if(!this.agent.ready||this.owner!=='IDLE')throw Error('HOST_NOT_AVAILABLE');
      return {coordinatorEpoch:this.agent.coordinatorEpoch,online:true,ownerIdle:true,admissionLimit:this.limits};
    };
    const evaluator=new CalibrationExecutor(ledger,path.join(config.directory,'calibration'),config.connection.domain,installed,async(permit,executor)=>{
      const state=ledger.snapshot(),grant=state.grant,pack=byDigest.get(permit.packDigest),test=pack?.cases.find(c=>c.id===permit.caseId);
      if(!grant||!test)throw Error('CALIBRATION_NOT_READY');
      const offer:DispatchOfferV2={task:{groupId:state.groupId,sessionId:null,originDeviceId:state.deviceId,resultDestination:state.deviceId,
        workflowId:'eval-'+permit.id,nodeId:'reference',attemptId:permit.id,coordinatorEpoch:this.agent.coordinatorEpoch,planRevision:1,
        app:this.appPolicy?.identity??{groupId:state.groupId,principalId:state.holderInstanceId,appId:state.holderInstanceId,appInstanceId:state.holderInstanceId,allowedContracts:[executor.contract.contractId]},
        contract:executor.contract,budget:{remainingMs:permit.timeoutMs,deadlineAt:Date.now()+permit.timeoutMs},inputs:[{artifactId:'eval-input-'+permit.id,contentVersion:1,contentHash:permit.inputHash,schemaId:executor.contract.inputSchemas[0],schemaVersion:1}],
        allowedTargetIds:[executor.target.targetId],qualityTarget:'reference',privacy:'LOCAL_ONLY',priority:'REMOTE_BATCH',parameters:test.parameters,allowedConfigurations:[permit.config.id],businessIdempotencyKey:executor.contract.sideEffectPolicy==='PURE'?null:'eval-'+permit.id},
        target:executor.target,resources:executor.resources,allowedConfigs:[permit.config],allotmentId:grant.allotmentId,allotmentVersion:grant.version,leaseMs:permit.timeoutMs,transferPlan:[],dependencies:[],reasonCode:'TRUSTED_REFERENCE'};
      return offer;
    },context,(offer,input,signal)=>this.executeService(offer,input,signal),config.imageEncoder);
    const run=evaluator.runInstalled.bind(evaluator);
    evaluator.runInstalled=async(permit,executor,signal)=>{const result=await run(permit,executor,signal);if(result.output.length)this.costs.set(executor.contract.capability,{value:result.durationMs-(result.overheadMs??0),overhead:result.overheadMs,at:Date.now()});return result;};
    // Authorization and the input ticket share one authenticated response. Consume once;
    // older coordinators keep using the separate input endpoint.
    const inputTickets=new Map<string,any>();
    const authorizations=new Map<string,DispatchOfferV2>();
    const authorize=async(offer:DispatchOfferV2)=>{
      const id=offer.task.attemptId;inputTickets.delete(id);
      const reply=await request('/v2/executions/'+id+'/authorize',{}) as {offer:DispatchOfferV2;inputTicket?:unknown;snapshotVersion?:number};
      if(canonical(reply.offer)!==canonical(offer))throw Error('OFFER_SCOPE');
      if(reply.inputTicket){if(inputTickets.size>=8)inputTickets.delete(inputTickets.keys().next().value!);inputTickets.set(id,reply.inputTicket);}
      return reply;
    };
    const route=async(offer:DispatchOfferV2,action:string,body:unknown={})=>{
      const reply=await request('/v2/executions/'+offer.task.attemptId+'/'+action,body) as any;
      return {endpoint:config.connection,ticket:reply.ticket,credential:config.connection.credential};
    };
    const remotePorts=artifactPorts({read:async(_ref,offer)=>{
      const id=offer.task.attemptId,ticket=inputTickets.get(id);inputTickets.delete(id);
      return ticket?{endpoint:config.connection,ticket,credential:config.connection.credential}:route(offer,'input');
    },write:async(bytes,schemaId,offer)=>route(offer,'output',{bytes:bytes.length,contentHash:digest(bytes),schemaId})});
    this.agent=new PcAgent(ledger,{connection:config.connection,deviceInstanceId:this.instance,
      queuePolicy:{shares:[.5,.3,.2],agingMs:1000,maxConsecutive:2,yieldDeadlineMs:1000},select:o=>o.allowedConfigs[0],snapshotVersion:async offer=>{
        const reply=await authorize(offer);if(authorizations.size>=8)authorizations.delete(authorizations.keys().next().value!);authorizations.set(offer.task.attemptId,reply.offer);
        return Number.isSafeInteger(reply.snapshotVersion)&&reply.snapshotVersion!>0?reply.snapshotVersion!:null;
      },
      ports:{...remotePorts,imageEncoder:config.imageEncoder,service:(offer,input,signal)=>this.executeService(offer,input,signal),publish:async(bytes,schemaId,offer,trace)=>{
        const reply=await request('/v2/executions/'+offer.task.attemptId+'/output',{bytes:bytes.length,contentHash:digest(bytes),schemaId}) as {ticket:Parameters<typeof transfer>[1];delivery:string;descriptor?:ArtifactDescriptor;endpoint?:{id:string;epoch:string}};
        if(reply.delivery==='RETAINED'){
          const host=this.dataHost,endpoint=host?.identity(),descriptor=reply.descriptor;
          if(!host||!endpoint||endpoint.id!==reply.endpoint?.id||endpoint.epoch!==reply.endpoint?.epoch||!descriptor||
            descriptor.groupId!==offer.task.groupId||descriptor.ownerPrincipalId!==offer.task.app.principalId||descriptor.bytes!==bytes.length||
            descriptor.ref.schemaId!==schemaId||descriptor.ref.contentHash!==digest(bytes)||descriptor.ref.artifactId!=='out-'+offer.task.attemptId)throw Error('ARTIFACT_ROUTE_SCOPE');
          host.channel.register(descriptor);
          try{await host.channel.writeForControl(descriptor,bytes);}catch(error){
            if(!(error instanceof Error)||error.message!=='ARTIFACT_CACHE_FULL')throw error;
            const fallback=await request('/v2/executions/'+offer.task.attemptId+'/output',{bytes:bytes.length,contentHash:digest(bytes),schemaId,retentionFailure:'ARTIFACT_CACHE_FULL'}).catch(()=>{throw Error('ARTIFACT_CACHE_FULL');}) as {delivery:string;ticket:Parameters<typeof transfer>[1]};
            if(fallback.delivery!=='RELAY'||fallback.ticket.operation!=='WRITE'||canonical(fallback.ticket.ref)!==canonical(descriptor.ref)||fallback.ticket.bytes!==bytes.length)throw Error('ARTIFACT_ROUTE_SCOPE');
            const send=()=>transfer(config.connection,fallback.ticket,config.connection.credential,bytes);await (trace?trace.transfer('WRITE',send):send());host.channel.forget(descriptor);return descriptor.ref;
          }
          await request('/v2/executions/'+offer.task.attemptId+'/retained',descriptor);return descriptor.ref;
        }
        if(reply.delivery==='RELAY'){
          const ticket=reply.ticket;
          if(ticket.operation!=='WRITE'||ticket.bytes!==bytes.length||ticket.ref.schemaId!==schemaId||ticket.ref.contentHash!==digest(bytes))throw Error('ARTIFACT_ROUTE_SCOPE');
          const send=()=>transfer(config.connection,ticket,config.connection.credential,bytes);await (trace?trace.transfer('WRITE',send):send());return ticket.ref;
        }
        const t=reply.ticket;if(reply.delivery!=='LOCAL'||t.operation!=='WRITE'||t.bytes!==bytes.length||t.ref.contentHash!==digest(bytes)||t.ref.schemaId!==schemaId)throw Error('ARTIFACT_ROUTE_SCOPE');
        await this.stageInput({contentHash:t.ref.contentHash,bytes:bytes.length,schemaId,schemaVersion:1},bytes);return t.ref;
      },read:async(ref,offer,trace)=>{
        const cached=this.dataHost?.channel.lookup(offer.task.groupId,ref);
        if(cached&&cached.ownerPrincipalId===offer.task.app.principalId&&this.dataHost!.channel.available(cached))return this.dataHost!.channel.readForControl(cached);
        if(offer.transferPlan.length===0&&this.appPolicy){
          if(offer.task.app.appInstanceId!==config.identity.appInstanceId||offer.task.originDeviceId!==config.identity.deviceId||!/^[a-f0-9]{64}$/.test(ref.contentHash))throw Error('LOCAL_INPUT_SCOPE');
          inputTickets.delete(offer.task.attemptId);
          return fs.promises.readFile(path.join(config.directory,'inputs',ref.contentHash));
        }
        return remotePorts.read(ref,offer,trace);
      },
        authorize:async offer=>{
          const id=offer.task.attemptId,cached=authorizations.get(id);authorizations.delete(id);
          if(cached){if(canonical(cached)!==canonical(offer))throw Error('OFFER_SCOPE');}else await authorize(offer);
          const admitted=await context();
          return admitted;
        }},
      allotments:{policy:()=>({base:this.appPolicy?.offlineBase??[],extra:this.appPolicy?.onlineExtra??[{resourcePoolId:'cpu',amount:config.contribution.maxCpuThreads},{resourcePoolId:'ram',amount:config.contribution.maxMemoryBytes},...(config.imageEncoder?.gpu?[{resourcePoolId:'gpu',amount:1},{resourcePoolId:'vram',amount:Math.min(config.imageEncoder.gpu.limit,config.contribution.maxVramBytes??Infinity)}]:[])],leaseMs:60000}),renewEveryMs:config.controlIntervalMs??20000},
      cancellationRequested:async offer=>(await request('/v2/executions/'+offer.task.attemptId+'/control',{}) as {cancel:boolean}).cancel===true,
      calibration:{executor:evaluator},onYield:()=>{},onExecutionSettled:()=>{void (this.pending??Promise.resolve()).then(()=>this.tick(false)).catch(onError);},onError});
  }
  private async executeService(offer:DispatchOfferV2,input:Buffer,signal:AbortSignal){
    const contract=offer.task.contract,adapter=this.config.services?.find(s=>s.pack.manifest.contract.serviceId===contract.serviceId&&canonical(s.pack.manifest.contract)===canonical(contract));
    // Any registered App may be routed here by the planner; App access is enforced by the coordinator's
    // contract allow-list and authorization, not by binding the service to the submitting host.
    const evaluation=offer.reasonCode==='TRUSTED_REFERENCE';
    if(!adapter||!(contract.sideEffectPolicy==='PURE'||contract.sideEffectPolicy==='IDEMPOTENT_WRITE'&&(evaluation||offer.task.businessIdempotencyKey!==null)))throw Error('SERVICE_SCOPE');
    if(signal.aborted)throw Error('CANCELLED_SETTLED');return adapter.execute(Buffer.from(input),offer.task.parameters,signal,{evaluation,idempotencyKey:offer.task.businessIdempotencyKey});
  }
  static async open(config:CpuHostConfig,onError:(e:unknown)=>void=()=>{}){
    const p=config?.contribution;
    if(config?.services?.some(s=>!s.pack.manifest.contract.serviceId||!['PURE','IDEMPOTENT_WRITE'].includes(s.pack.manifest.contract.sideEffectPolicy)||s.pack.manifest.contract.sideEffectPolicy==='IDEMPOTENT_WRITE'&&s.pack.dryRunEvaluation!==true||s.pack.manifest.contract.interruptibility!=='CANCEL_RESTART'))throw Error('SERVICE_CONFIG_INVALID');
    if(!config||config.controlIntervalMs!==undefined&&(!Number.isSafeInteger(config.controlIntervalMs)||config.controlIntervalMs<100||config.controlIntervalMs>=60000)||!path.isAbsolute(config.directory)||!fs.existsSync(path.join(config.directory,'ledger.initialized'))||!p||!['dedicated','windows-idle','paused'].includes(p.ownerMode)||
      !Number.isSafeInteger(p.maxCpuThreads)||p.maxCpuThreads<1||!Number.isSafeInteger(p.maxMemoryBytes)||p.maxMemoryBytes<67108864||!Number.isSafeInteger(p.reserveMemoryBytes)||p.reserveMemoryBytes<0)throw Error('HOST_CONFIG_INVALID');
    const ledger=await DurableLedger.open(config.directory,config.identity,config.connection.certificate);
    try{
      const host=new CpuHost(ledger,config,onError,await builtinReferencePacks());
      if(config.identity.appInstanceId!==null){
        const policy=JSON.parse(await appRequest(config.connection)('/v2/apps/me',null)) as NonNullable<CpuHost['appPolicy']> & {identity:{appInstanceId:string;groupId:string;allowedContracts:string[]}};
        if(policy.identity.appInstanceId!==config.identity.appInstanceId||policy.identity.groupId!==config.identity.groupId)throw Error('APP_HOST_IDENTITY_MISMATCH');
        host.appPolicy=policy;
      }
      return host;
    }catch(error){await ledger.close();throw error;}
  }
  private executor(capability:string,now:number):ExecutorV2{
    const pack=this.packs.find(p=>p.manifest.contract.capability===capability)!,cost=this.costs.get(capability);
    const prior=(value:number|null,sampledAt=now):NumericSampleV2=>({value,source:value===null?'UNKNOWN':'PRIOR',sampledAt,ttlMs:3600000,unit:'ms'});
    const gpu=pack===this.config.imageEncoder?.pack&&!!this.config.imageEncoder.gpu;
    const resources=pack.manifest.resourceLimit.filter(r=>gpu||!['gpu','vram'].includes(r.resourcePoolId));
    const executorId=pack===this.config.imageEncoder?.pack?(gpu?(this.config.imageEncoder?.backend==='VULKAN'?photoVulkanExecutorId:cudaExecutorId):imageExecutorId):pack.manifest.contract.serviceId?pack.manifest.executorIds[0]:(cpuRegistry.executorId(capability)??'node.cpu.v1');
    return {startup:pack.manifest.contract.serviceId?"UNKNOWN":"COLD",target:{targetId:(gpu?'cuda-':'cpu-')+createHash('sha256').update(this.config.identity.holderInstanceId+':'+capability).digest('hex').slice(0,32),deviceId:this.config.identity.deviceId,
      executorId,executorVersion:'1',backend:gpu?(this.config.imageEncoder?.backend??'CUDA'):pack.manifest.contract.serviceId?'SERVICE':'CPU',resourcePoolIds:resources.map(r=>r.resourcePoolId),stableExecutionId:executorId},contract:pack.manifest.contract,model:pack.manifest.model,
      resources:structuredClone(resources),configurations:[{...pack.cases[0].config}],compute:prior(cost?.value??null,cost?cost.at+this.clockOffset:now),queue:prior(null),cold:prior(cost?.overhead??0,cost?cost.at+this.clockOffset:now),publish:prior(0),uncertainty:prior(null)};
  }
  private async sample(syncSettings=true){
    try{
      if(this.agent.ready&&syncSettings&&!this.appPolicy){
        // HTTPS Date is rounded down to seconds. Anchor at receipt time so telemetry is conservatively
        // aged by network delay, never moved into the coordinator's future by a fast device wall clock.
        const reply=await allotmentTransport(this.config.connection,time=>{this.clockOffset=time-Date.now();})('/v2/device-settings',{} ) as {settings:CpuHostConfig['contribution']|null};
        const settings=reply.settings;
        if(settings&&['dedicated','windows-idle','paused'].includes(settings.ownerMode)){
          // Cloud preferences may pause/yield this installation; original local ceilings remain authoritative.
          this.config.contribution.ownerMode=settings.ownerMode;
          this.config.contribution.reserveMemoryBytes=Math.max(this.config.contribution.reserveMemoryBytes,settings.reserveMemoryBytes);
        }
      }
      const links=this.agent.ready?await this.relayLinks.sample(Date.now()+this.clockOffset):[];
      const system=collectSystemResources(),p=this.config.contribution,before=occupiedV2(this.ledger.snapshot());
      const owner=p.ownerMode==='dedicated'?'IDLE':p.ownerMode==='paused'?'ACTIVE':await windowsOwnerActivity(p.idleThresholdMs??60000);
      if(this.stopped)return;
      const ownRam=before.find(r=>r.resourcePoolId==='ram')?.amount??0;
      this.owner=owner;this.limits=[{resourcePoolId:'cpu',amount:Math.min(system.cpuThreads,p.maxCpuThreads)},
        {resourcePoolId:'ram',amount:Math.min(p.maxMemoryBytes,system.totalMemoryBytes,ownRam+Math.max(0,system.freeMemoryBytes-p.reserveMemoryBytes))}];
      const gpu=this.config.imageEncoder?.gpu;
      if(gpu){const free=await gpu.freeBytes();this.limits.push({resourcePoolId:'gpu',amount:free>0?1:0},{resourcePoolId:'vram',amount:Math.min(gpu.limit,p.maxVramBytes??Infinity,free)});}
      if(owner!=='IDLE')this.limits=this.limits.map(r=>({...r,amount:0}));
      await this.agent.updateResources(this.limits,owner);
      const state=this.ledger.snapshot(),occupied=occupiedV2(state),now=Date.now()+this.clockOffset;
      if(!this.agent.ready||!state.grant||this.ledger.pendingMessages().some(m=>m.type==='DeviceProfile'))return;
      const source=this.config.connection.domain==='REAL'?'MEASURED':'SIMULATED';
      const numeric=(value:number,unit:string):NumericSampleV2=>({value,source,sampledAt:system.sampledAt+this.clockOffset,ttlMs:15000,unit});
      const unknown=(unit:string)=>({value:null,source:'UNKNOWN',sampledAt:now,ttlMs:15000,unit});
      const status=(value:string,source='PRIOR')=>({value,source,sampledAt:now,ttlMs:15000,unit:'state'});
      const executors=this.packs.filter(pack=>!this.appPolicy||this.appPolicy.identity.allowedContracts.includes(pack.manifest.contract.contractId)).map(pack=>this.executor(pack.manifest.contract.capability,now));
      const profile:Omit<DeviceProfileV2,'sequence'>={deviceId:state.deviceId,deviceInstanceId:this.instance,holderInstanceId:state.holderInstanceId,ledgerEpoch:state.ledgerEpoch,domain:this.config.connection.domain,
        ownerActivity:owner==='UNKNOWN'?unknown('state'):status(owner,p.ownerMode==='windows-idle'?source:'PRIOR'),foreground:status('FOREGROUND'),powerSave:status('OFF'),charging:unknown('state'),battery:unknown('percent'),temperature:unknown('level'),
        pools:[{id:'cpu',kind:'CPU_SLOTS',unit:'slots',total:system.cpuThreads,limit:p.maxCpuThreads},{id:'ram',kind:'RAM_BYTES',unit:'bytes',total:system.totalMemoryBytes,limit:p.maxMemoryBytes},...(gpu?[{id:'gpu',kind:'GPU_SLOTS',unit:'slots',total:1,limit:1},{id:'vram',kind:'VRAM_BYTES',unit:'bytes',total:gpu.totalBytes,limit:Math.min(gpu.limit,p.maxVramBytes??Infinity)}]:[])].map(pool=>({resourcePoolId:pool.id,kind:pool.kind,exclusive:pool.id==='gpu',total:numeric(pool.total,pool.unit),ownerReserved:Math.max(0,pool.total-pool.limit),contributionLimit:pool.limit,
          admissionLimit:numeric(this.limits.find(r=>r.resourcePoolId===pool.id)!.amount,pool.unit),occupied:numeric(occupied.find(r=>r.resourcePoolId===pool.id)?.amount??0,pool.unit),draining:(occupied.find(r=>r.resourcePoolId===pool.id)?.amount??0)>this.limits.find(r=>r.resourcePoolId===pool.id)!.amount,drainMs:unknown('ms')})),
        executors,links,credits:this.agent.scheduler.capacityCredits(executors.map(e=>e.resources),occupied)};
      const facts=this.ledger.inFlight(state,now,profile.domain);if(facts)profile.inFlight=facts;
      const queued=this.agent.scheduler.queuedFacts(now,profile.domain);if(queued)profile.queued=queued;
      // Reporting failure is not a failed local resource/owner measurement.
      // Keep already admitted work under its existing lease; stale coordinator
      // telemetry still blocks new remote admissions. Cancelling here restarts
      // real inference whenever a profile ACK is delayed by the control channel.
      try{await this.agent.publishProfile(profile);}catch(error){this.onError(error);}
    }catch(error){this.onError(error);this.owner='UNKNOWN';this.limits=[];await this.agent.updateResources([],'UNKNOWN');}
  }
  private async network(){
    if(!this.agent.ready){this.peerLinks.invalidate();return;}
    const epoch=this.ledger.snapshot().grant?.coordinatorEpoch??0;
    const network=canonical(networkInterfaces());
    if(this.config.dataEndpoint!==false&&(!this.dataHost||network!==this.endpointNetwork)&&Date.now()>=this.endpointRetryAt){
      await this.dataHost?.close();this.dataHost=undefined;this.endpointRetryAt=Date.now()+30000;
      try{this.dataHost=await openDataHost(this.config.directory,this.config.connection,this.config.dataEndpoint??await discoverDataHost(this.config.connection),cpuSchemas);this.endpointNetwork=network;this.endpointCoordinatorEpoch=epoch;}
      catch(error){this.onError(error);}this.peerLinks.invalidate();
    }
    if(this.dataHost&&(!this.dataHost.identity()||epoch!==this.endpointCoordinatorEpoch)){await this.dataHost.register();this.endpointCoordinatorEpoch=epoch;this.peerLinks.invalidate();}
    await this.peerLinks.sample();await this.collectReleased();await this.deliver();
  }
  private async collectReleased(){
    const host=this.dataHost,endpoint=host?.identity();if(!host||!endpoint)return;
    host.channel.sweep();const before=host.channel.snapshot(endpoint.groupId),request=allotmentTransport(this.config.connection);
    for(let offset=0;offset<before.objects.length;offset+=64)await request('/v2/data/cache/inventory',{epoch:endpoint.epoch,objects:before.objects.slice(offset,offset+64).map(d=>({ref:d.ref,bytes:d.bytes,expiresAt:d.expiresAt}))});
    const plan=await request('/v2/data/retention',null) as {endpointId:string;epoch:string;release:{id:string;ref:ArtifactDescriptor['ref'];epoch:string}[]};
    if(plan.endpointId!==endpoint.id||plan.epoch!==endpoint.epoch)throw Error('RELEASE_SCOPE');
    let generation=before.generation;
    for(const item of plan.release){
      const cached=before.objects.find(d=>canonical(d.ref)===canonical(item.ref));
      if(cached&&!host.channel.forget(cached,generation))continue;
      if(cached)generation++;
      await request('/v2/data/releases',item);
    }
  }
  private async deliver(){
    const host=this.dataHost,identity=host?.identity();if(!host||!identity)return;
    const connection=this.config.connection,request=allotmentTransport(connection);
    const pending=await request('/v2/data/deliveries',null) as {attemptId:string;deliveryId:string;producerAttemptId:string;endpointId:string;ref:ArtifactDescriptor['ref'];bytes:number}[];
    for(const item of pending){
      const cached=host.channel.lookup(identity.groupId,item.ref);if(!cached||cached.bytes!==item.bytes||!host.channel.available(cached)){await request('/v2/data/deliveries/missing',{attemptId:item.attemptId,deliveryId:item.deliveryId,ref:item.ref});continue;}
      const grant=await request('/v2/data/authorizations',{attemptId:item.attemptId,deliveryId:item.deliveryId,endpointId:item.endpointId,operation:'WRITE'}) as {signed:SignedTransfer;proof:string};
      const a=grant.signed.authorization;
      if(a.version!==2||a.operation!=='WRITE'||a.producerAttemptId!==item.producerAttemptId||a.attemptId!==item.attemptId||a.deliveryId!==item.deliveryId||a.endpoint.id!==item.endpointId||a.senderHolderId!==identity.holderInstanceId||a.ownerPrincipalId!==cached.ownerPrincipalId||canonical(a.ref)!==canonical(cached.ref)||a.bytes!==cached.bytes)throw Error('DELIVERY_SCOPE');
      try{
        const bytes=await host.channel.readForControl(cached),startMono=performance.now();
        const observation=await directTransfer(grant,connection.certificate,connection.domain,bytes),endMono=performance.now();
        if(this.transferTelemetry.size<16){const report=request('/v2/data/traces',{authorizationId:a.id,side:'SENDER',interval:{clockDomainId:pcTraceClockDomainId,startMono,endMono}}).catch(()=>{}).finally(()=>this.transferTelemetry.delete(report));this.transferTelemetry.add(report);}
        await request('/v2/data/observations',{authorizationId:a.id,durationMs:observation.durationMs});
      }catch(error){await request('/v2/data/deliveries/failed',{authorizationId:a.id});this.onError(error);}

    }
  }
  tick(syncSettings=true){
    if(!this.networkPending&&!this.stopped)this.networkPending=this.network().catch(error=>{this.peerLinks.invalidate();this.onError(error);}).finally(()=>{this.networkPending=undefined;});
    if(!this.pending&&!this.stopped)this.pending=this.sample(syncSettings).finally(()=>{this.pending=undefined;});return this.pending??Promise.resolve();
  }
  start(){if(this.timer||this.stopped)throw Error('HOST_STARTED');this.agent.start();this.timer=setInterval(()=>{void this.tick().catch(this.onError);},2000);void this.tick().catch(this.onError);}
  async close(){if(this.stopped)return;this.stopped=true;this.peerLinks.close();if(this.timer)clearInterval(this.timer);await this.agent.close();await this.pending;await this.networkPending;await Promise.allSettled(this.transferTelemetry);await this.dataHost?.close();await this.ledger.close();}
}

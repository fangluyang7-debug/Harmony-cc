import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AppIdentityV2, canonical, DeviceProfileV2, DispatchOfferV2, ExecutorV2, NumericSampleV2, occupiedV2, ResourceAmountV2 } from '@harmony/scheduler-core';
import { ReferencePack, builtinCpuPacks, cpuResources, cpuConfiguration, packDigest, digest } from '@harmony/reference-capabilities';
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

export interface FixedServiceAdapter {pack:ReferencePack;execute(input:Buffer,parameters:string,signal:AbortSignal):Promise<{bytes:Buffer;schemaId:string}>;}
export interface CpuHostConfig {
  dataEndpoint?:DataHostConfig|false;
  fixedServices?:FixedServiceAdapter[];
  controlIntervalMs?:number;
  directory:string;identity:{groupId:string;deviceId:string;holderInstanceId:string;appInstanceId:string|null};connection:RecoveryConnection;
  contribution:{ownerMode:'dedicated'|'windows-idle'|'paused';maxCpuThreads:number;maxMemoryBytes:number;reserveMemoryBytes:number;idleThresholdMs?:number};
}
/** Standalone CPU host assembled from paired identity, owner policy, installed packs and network services. */
export class CpuHost {
  private readonly packs:ReferencePack[];
  private stopped=false;private timer:NodeJS.Timeout|undefined;private pending:Promise<void>|undefined;
  private limits:ResourceAmountV2[]=[];private owner:'IDLE'|'ACTIVE'|'UNKNOWN'='UNKNOWN';
  private readonly instance=randomUUID();
  private readonly costs=new Map<string,{value:number;at:number}>();
  private clockOffset=0;
  private readonly relayLinks:RelayLinks;
  private readonly peerLinks:PeerLinks;
  private dataHost:Awaited<ReturnType<typeof openDataHost>>|undefined;
  private networkPending:Promise<void>|undefined;
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
  private constructor(readonly ledger:DurableLedger,private readonly config:CpuHostConfig,private readonly onError:(e:unknown)=>void){
    this.packs=[...builtinCpuPacks(),...(config.fixedServices??[]).map(s=>s.pack)];
    if(new Set(this.packs.map(p=>p.manifest.contract.capability)).size!==this.packs.length)throw Error('SERVICE_CAPABILITY_CONFLICT');
    const request=allotmentTransport(config.connection),packs=this.packs,installed=new Map(packs.flatMap(p=>p.cases.map(c=>[packDigest(p)+':'+c.id,c] as const)));
    this.relayLinks=new RelayLinks(config.identity.deviceId,config.connection.domain,request);
    this.peerLinks=new PeerLinks(config.identity.deviceId,request);
    const context=async()=>{
      if(!this.agent.ready||this.owner!=='IDLE')throw Error('HOST_NOT_AVAILABLE');
      return {coordinatorEpoch:this.agent.coordinatorEpoch,online:true,ownerIdle:true,admissionLimit:this.limits};
    };
    const evaluator=new CalibrationExecutor(ledger,path.join(config.directory,'calibration'),config.connection.domain,installed,async(permit,executor)=>{
      const state=ledger.snapshot(),grant=state.grant,pack=packs.find(p=>packDigest(p)===permit.packDigest),test=pack?.cases.find(c=>c.id===permit.caseId);
      if(!grant||!test)throw Error('CALIBRATION_NOT_READY');
      const offer:DispatchOfferV2={task:{groupId:state.groupId,sessionId:null,originDeviceId:state.deviceId,resultDestination:state.deviceId,
        workflowId:'eval-'+permit.id,nodeId:'reference',attemptId:permit.id,coordinatorEpoch:this.agent.coordinatorEpoch,planRevision:1,
        app:this.appPolicy?.identity??{groupId:state.groupId,principalId:state.holderInstanceId,appId:state.holderInstanceId,appInstanceId:state.holderInstanceId,allowedContracts:[executor.contract.contractId]},
        contract:executor.contract,budget:{remainingMs:permit.timeoutMs,deadlineAt:Date.now()+permit.timeoutMs},inputs:[{artifactId:'eval-input-'+permit.id,contentVersion:1,contentHash:permit.inputHash,schemaId:executor.contract.inputSchemas[0],schemaVersion:1}],
        allowedTargetIds:[executor.target.targetId],qualityTarget:'reference',privacy:'LOCAL_ONLY',priority:'REMOTE_BATCH',parameters:test.parameters,allowedConfigurations:[permit.config.id],businessIdempotencyKey:null},
        target:executor.target,resources:executor.resources,allowedConfigs:[permit.config],allotmentId:grant.allotmentId,allotmentVersion:grant.version,leaseMs:permit.timeoutMs,transferPlan:[],dependencies:[],reasonCode:'TRUSTED_REFERENCE'};
      return offer;
    },context,(offer,input,signal)=>this.executeService(offer,input,signal));
    const run=evaluator.runInstalled.bind(evaluator);
    evaluator.runInstalled=async(permit,executor,signal)=>{const result=await run(permit,executor,signal);if(result.output.length)this.costs.set(executor.contract.capability,{value:result.durationMs,at:Date.now()});return result;};
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
      ports:{...remotePorts,fixedService:(offer,input,signal)=>this.executeService(offer,input,signal),publish:async(bytes,schemaId,offer)=>{
        if(!this.appPolicy)return remotePorts.publish(bytes,schemaId,offer);
        const reply=await request('/v2/executions/'+offer.task.attemptId+'/output',{bytes:bytes.length,contentHash:digest(bytes),schemaId}) as {ticket:{operation:string;bytes:number;ref:any};delivery:string};
        if(reply.delivery==='RELAY')return remotePorts.publish(bytes,schemaId,offer);
        const t=reply.ticket;if(reply.delivery!=='LOCAL'||t.operation!=='WRITE'||t.bytes!==bytes.length||t.ref.contentHash!==digest(bytes)||t.ref.schemaId!==schemaId)throw Error('ARTIFACT_ROUTE_SCOPE');
        await this.stageInput({contentHash:t.ref.contentHash,bytes:bytes.length,schemaId,schemaVersion:1},bytes);return t.ref;
      },read:async(ref,offer)=>{
        const cached=this.dataHost?.channel.lookup(offer.task.groupId,ref);
        if(cached&&cached.ownerPrincipalId===offer.task.app.principalId&&this.dataHost!.channel.available(cached))return this.dataHost!.channel.readForControl(cached);
        if(offer.transferPlan.length===0&&this.appPolicy){
          if(offer.task.app.appInstanceId!==config.identity.appInstanceId||offer.task.originDeviceId!==config.identity.deviceId||!/^[a-f0-9]{64}$/.test(ref.contentHash))throw Error('LOCAL_INPUT_SCOPE');
          inputTickets.delete(offer.task.attemptId);
          return fs.promises.readFile(path.join(config.directory,'inputs',ref.contentHash));
        }
        return remotePorts.read(ref,offer);
      },
        authorize:async offer=>{
          const id=offer.task.attemptId,cached=authorizations.get(id);authorizations.delete(id);
          if(cached){if(canonical(cached)!==canonical(offer))throw Error('OFFER_SCOPE');}else await authorize(offer);
          const admitted=await context();
          return admitted;
        }},
      allotments:{policy:()=>({base:this.appPolicy?.offlineBase??[],extra:this.appPolicy?.onlineExtra??[{resourcePoolId:'cpu',amount:config.contribution.maxCpuThreads},{resourcePoolId:'ram',amount:config.contribution.maxMemoryBytes}],leaseMs:60000}),renewEveryMs:config.controlIntervalMs??20000},
      cancellationRequested:async offer=>(await request('/v2/executions/'+offer.task.attemptId+'/control',{}) as {cancel:boolean}).cancel===true,
      calibration:{executor:evaluator},onYield:()=>{},onExecutionSettled:()=>{void (this.pending??Promise.resolve()).then(()=>this.tick(false)).catch(onError);},onError});
  }
  private async executeService(offer:DispatchOfferV2,input:Buffer,signal:AbortSignal){
    const contract=offer.task.contract,adapter=this.config.fixedServices?.find(s=>s.pack.manifest.contract.serviceId===contract.serviceId&&canonical(s.pack.manifest.contract)===canonical(contract));
    if(!adapter||!this.appPolicy||contract.sideEffectPolicy!=='PURE'||offer.task.app.appInstanceId!==this.config.identity.appInstanceId||offer.task.originDeviceId!==this.config.identity.deviceId)throw Error('SERVICE_SCOPE');
    if(signal.aborted)throw Error('CANCELLED_SETTLED');return adapter.execute(Buffer.from(input),offer.task.parameters,signal);
  }
  static async open(config:CpuHostConfig,onError:(e:unknown)=>void=()=>{}){
    const p=config?.contribution;
    if(config?.fixedServices?.some(s=>!s.pack.manifest.contract.serviceId||s.pack.manifest.contract.sideEffectPolicy!=='PURE'||s.pack.manifest.contract.interruptibility!=='CANCEL_RESTART')||config?.fixedServices?.length&&config.identity.appInstanceId===null)throw Error('SERVICE_CONFIG_INVALID');
    if(!config||config.controlIntervalMs!==undefined&&(!Number.isSafeInteger(config.controlIntervalMs)||config.controlIntervalMs<100||config.controlIntervalMs>=60000)||!path.isAbsolute(config.directory)||!fs.existsSync(path.join(config.directory,'ledger.initialized'))||!p||!['dedicated','windows-idle','paused'].includes(p.ownerMode)||
      !Number.isSafeInteger(p.maxCpuThreads)||p.maxCpuThreads<1||!Number.isSafeInteger(p.maxMemoryBytes)||p.maxMemoryBytes<67108864||!Number.isSafeInteger(p.reserveMemoryBytes)||p.reserveMemoryBytes<0)throw Error('HOST_CONFIG_INVALID');
    const ledger=await DurableLedger.open(config.directory,config.identity,config.connection.certificate);
    try{
      const host=new CpuHost(ledger,config,onError);
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
    return {target:{targetId:'cpu-'+createHash('sha256').update(this.config.identity.holderInstanceId+':'+capability).digest('hex').slice(0,32),deviceId:this.config.identity.deviceId,
      executorId:'node.cpu.v1',executorVersion:'1',backend:pack.manifest.contract.serviceId?'SERVICE':'CPU',resourcePoolIds:['cpu','ram'],stableExecutionId:'node.cpu.v1'},contract:pack.manifest.contract,model:null,
      resources:structuredClone(pack.manifest.resourceLimit),configurations:[{...pack.cases[0].config}],compute:prior(cost?.value??null,cost?cost.at+this.clockOffset:now),queue:prior(0),cold:prior(0),publish:prior(0),uncertainty:prior(0)};
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
      const system=collectSystemResources(),p=this.config.contribution,state=this.ledger.snapshot(),occupied=occupiedV2(state),now=Date.now()+this.clockOffset;
      const owner=p.ownerMode==='dedicated'?'IDLE':p.ownerMode==='paused'?'ACTIVE':await windowsOwnerActivity(p.idleThresholdMs??60000);
      if(this.stopped)return;
      const ownRam=occupied.find(r=>r.resourcePoolId==='ram')?.amount??0;
      this.owner=owner;this.limits=[{resourcePoolId:'cpu',amount:Math.min(system.cpuThreads,p.maxCpuThreads)},
        {resourcePoolId:'ram',amount:Math.min(p.maxMemoryBytes,system.totalMemoryBytes,ownRam+Math.max(0,system.freeMemoryBytes-p.reserveMemoryBytes))}];
      if(owner!=='IDLE')this.limits=this.limits.map(r=>({...r,amount:0}));
      await this.agent.updateResources(this.limits,owner);
      if(!this.agent.ready||!state.grant||this.ledger.pendingMessages().some(m=>m.type==='DeviceProfile'))return;
      const source=this.config.connection.domain==='REAL'?'MEASURED':'SIMULATED';
      const numeric=(value:number,unit:string):NumericSampleV2=>({value,source,sampledAt:system.sampledAt+this.clockOffset,ttlMs:15000,unit});
      const unknown=(unit:string)=>({value:null,source:'UNKNOWN',sampledAt:now,ttlMs:15000,unit});
      const status=(value:string,source='PRIOR')=>({value,source,sampledAt:now,ttlMs:15000,unit:'state'});
      const profile:Omit<DeviceProfileV2,'sequence'>={deviceId:state.deviceId,deviceInstanceId:this.instance,holderInstanceId:state.holderInstanceId,ledgerEpoch:state.ledgerEpoch,domain:this.config.connection.domain,
        ownerActivity:owner==='UNKNOWN'?unknown('state'):status(owner,p.ownerMode==='windows-idle'?source:'PRIOR'),foreground:status('FOREGROUND'),powerSave:status('OFF'),charging:unknown('state'),battery:unknown('percent'),temperature:unknown('level'),
        pools:[{id:'cpu',kind:'CPU_SLOTS',unit:'slots',total:system.cpuThreads,limit:p.maxCpuThreads},{id:'ram',kind:'RAM_BYTES',unit:'bytes',total:system.totalMemoryBytes,limit:p.maxMemoryBytes}].map(pool=>({resourcePoolId:pool.id,kind:pool.kind,exclusive:false,total:numeric(pool.total,pool.unit),ownerReserved:Math.max(0,pool.total-pool.limit),contributionLimit:pool.limit,
          admissionLimit:numeric(this.limits.find(r=>r.resourcePoolId===pool.id)!.amount,pool.unit),occupied:numeric(occupied.find(r=>r.resourcePoolId===pool.id)?.amount??0,pool.unit),draining:(occupied.find(r=>r.resourcePoolId===pool.id)?.amount??0)>this.limits.find(r=>r.resourcePoolId===pool.id)!.amount,drainMs:unknown('ms')})),
        executors:this.packs.filter(pack=>!this.appPolicy||this.appPolicy.identity.allowedContracts.includes(pack.manifest.contract.contractId)).map(pack=>this.executor(pack.manifest.contract.capability,now)),links,credits:['ORIGIN_INTERACTIVE','REMOTE_INTERACTIVE','REMOTE_BATCH'].map(priority=>({priority,slots:owner==='IDLE'?1:0}))};
      await this.agent.publishProfile(profile);
    }catch(error){this.onError(error);this.owner='UNKNOWN';this.limits=[];await this.agent.updateResources([],'UNKNOWN');}
  }
  private async network(){
    if(!this.agent.ready){this.peerLinks.invalidate();return;}
    const epoch=this.ledger.snapshot().grant?.coordinatorEpoch??0;
    const network=canonical(networkInterfaces());
    if(this.config.dataEndpoint!==false&&network!==this.endpointNetwork&&Date.now()>=this.endpointRetryAt){
      await this.dataHost?.close();this.dataHost=undefined;this.endpointRetryAt=Date.now()+30000;
      try{this.dataHost=await openDataHost(this.config.directory,this.config.connection,this.config.dataEndpoint??await discoverDataHost(this.config.connection),cpuSchemas);this.endpointNetwork=network;this.endpointCoordinatorEpoch=epoch;}
      catch(error){this.onError(error);}this.peerLinks.invalidate();
    }
    if(this.dataHost&&epoch!==this.endpointCoordinatorEpoch){await this.dataHost.register();this.endpointCoordinatorEpoch=epoch;this.peerLinks.invalidate();}
    await this.peerLinks.sample();
  }
  tick(syncSettings=true){
    if(!this.networkPending&&!this.stopped)this.networkPending=this.network().catch(error=>{this.peerLinks.invalidate();this.onError(error);}).finally(()=>{this.networkPending=undefined;});
    if(!this.pending&&!this.stopped)this.pending=this.sample(syncSettings).finally(()=>{this.pending=undefined;});return this.pending??Promise.resolve();
  }
  start(){if(this.timer||this.stopped)throw Error('HOST_STARTED');this.agent.start();this.timer=setInterval(()=>{void this.tick().catch(this.onError);},2000);void this.tick().catch(this.onError);}
  async close(){if(this.stopped)return;this.stopped=true;this.peerLinks.close();if(this.timer)clearInterval(this.timer);await this.agent.close();await this.pending;await this.networkPending;await this.dataHost?.close();await this.ledger.close();}
}

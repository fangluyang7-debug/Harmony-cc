import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { canonical, DeviceProfileV2, DispatchOfferV2, ExecutorV2, NumericSampleV2, occupiedV2, ResourceAmountV2 } from '@harmony/scheduler-core';
import { builtinCpuPacks, cpuResources, cpuConfiguration, packDigest, digest } from '@harmony/reference-capabilities';
import { DurableLedger } from './durable-ledger';
import { PcAgent } from './agent';
import { CalibrationExecutor } from './calibration-executor';
import { RecoveryConnection } from './recovery-client';
import { allotmentTransport } from './allotment-client';
import { artifactPorts } from './artifact-client';
import { collectSystemResources, windowsOwnerActivity } from './system-resources';
import { RelayLinks } from './relay-links';

export interface CpuHostConfig {
  controlIntervalMs?:number;
  directory:string;identity:{groupId:string;deviceId:string;holderInstanceId:string;appInstanceId:string|null};connection:RecoveryConnection;
  contribution:{ownerMode:'dedicated'|'windows-idle'|'paused';maxCpuThreads:number;maxMemoryBytes:number;reserveMemoryBytes:number;idleThresholdMs?:number};
}
/** Standalone CPU host assembled from paired identity, owner policy, installed packs and network services. */
export class CpuHost {
  private stopped=false;private timer:NodeJS.Timeout|undefined;private pending:Promise<void>|undefined;
  private limits:ResourceAmountV2[]=[];private owner:'IDLE'|'ACTIVE'|'UNKNOWN'='UNKNOWN';
  private readonly instance=randomUUID();
  private readonly costs=new Map<string,{value:number;at:number}>();
  private clockOffset=0;
  private readonly relayLinks:RelayLinks;
  readonly agent:PcAgent;
  private constructor(readonly ledger:DurableLedger,private readonly config:CpuHostConfig,private readonly onError:(e:unknown)=>void){
    const request=allotmentTransport(config.connection),packs=builtinCpuPacks(),installed=new Map(packs.flatMap(p=>p.cases.map(c=>[packDigest(p)+':'+c.id,c] as const)));
    this.relayLinks=new RelayLinks(config.identity.deviceId,config.connection.domain,request);
    const context=async()=>{
      if(!this.agent.ready||this.owner!=='IDLE')throw Error('HOST_NOT_AVAILABLE');
      return {coordinatorEpoch:this.agent.coordinatorEpoch,online:true,ownerIdle:true,admissionLimit:this.limits};
    };
    const evaluator=new CalibrationExecutor(ledger,path.join(config.directory,'calibration'),config.connection.domain,installed,async(permit,executor)=>{
      const state=ledger.snapshot(),grant=state.grant,pack=packs.find(p=>packDigest(p)===permit.packDigest),test=pack?.cases.find(c=>c.id===permit.caseId);
      if(!grant||!test)throw Error('CALIBRATION_NOT_READY');
      const offer:DispatchOfferV2={task:{groupId:state.groupId,sessionId:null,originDeviceId:state.deviceId,resultDestination:state.deviceId,
        workflowId:'eval-'+permit.id,nodeId:'reference',attemptId:permit.id,coordinatorEpoch:this.agent.coordinatorEpoch,planRevision:1,
        app:{groupId:state.groupId,principalId:state.holderInstanceId,appId:state.holderInstanceId,appInstanceId:state.holderInstanceId,allowedContracts:[executor.contract.contractId]},
        contract:executor.contract,budget:{remainingMs:permit.timeoutMs,deadlineAt:Date.now()+permit.timeoutMs},inputs:[{artifactId:'eval-input-'+permit.id,contentVersion:1,contentHash:permit.inputHash,schemaId:executor.contract.inputSchemas[0],schemaVersion:1}],
        allowedTargetIds:[executor.target.targetId],qualityTarget:'reference',privacy:'LOCAL_ONLY',priority:'REMOTE_BATCH',parameters:test.parameters,allowedConfigurations:[permit.config.id],businessIdempotencyKey:null},
        target:executor.target,resources:executor.resources,allowedConfigs:[permit.config],allotmentId:grant.allotmentId,allotmentVersion:grant.version,leaseMs:permit.timeoutMs,transferPlan:[],dependencies:[],reasonCode:'TRUSTED_REFERENCE'};
      return offer;
    },context);
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
    this.agent=new PcAgent(ledger,{connection:config.connection,deviceInstanceId:this.instance,
      queuePolicy:{shares:[.5,.3,.2],agingMs:1000,maxConsecutive:2,yieldDeadlineMs:1000},select:o=>o.allowedConfigs[0],snapshotVersion:async offer=>{
        const reply=await authorize(offer);if(authorizations.size>=8)authorizations.delete(authorizations.keys().next().value!);authorizations.set(offer.task.attemptId,reply.offer);
        return Number.isSafeInteger(reply.snapshotVersion)&&reply.snapshotVersion!>0?reply.snapshotVersion!:null;
      },
      ports:{...artifactPorts({read:async(_ref,offer)=>{
        const id=offer.task.attemptId,ticket=inputTickets.get(id);inputTickets.delete(id);
        return ticket?{endpoint:config.connection,ticket,credential:config.connection.credential}:route(offer,'input');
      },write:async(bytes,schemaId,offer)=>route(offer,'output',{bytes:bytes.length,contentHash:digest(bytes),schemaId})}),
        authorize:async offer=>{
          const id=offer.task.attemptId,cached=authorizations.get(id);authorizations.delete(id);
          if(cached){if(canonical(cached)!==canonical(offer))throw Error('OFFER_SCOPE');}else await authorize(offer);
          const admitted=await context();
          return admitted;
        }},
      allotments:{policy:()=>({base:[],extra:[{resourcePoolId:'cpu',amount:config.contribution.maxCpuThreads},{resourcePoolId:'ram',amount:config.contribution.maxMemoryBytes}],leaseMs:60000}),renewEveryMs:config.controlIntervalMs??20000},
      calibration:{executor:evaluator},onYield:()=>{},onExecutionSettled:()=>{void (this.pending??Promise.resolve()).then(()=>this.tick(false)).catch(onError);},onError});
  }
  static async open(config:CpuHostConfig,onError:(e:unknown)=>void=()=>{}){
    const p=config?.contribution;
    if(!config||config.controlIntervalMs!==undefined&&(!Number.isSafeInteger(config.controlIntervalMs)||config.controlIntervalMs<100||config.controlIntervalMs>=60000)||!path.isAbsolute(config.directory)||!fs.existsSync(path.join(config.directory,'ledger.initialized'))||!p||!['dedicated','windows-idle','paused'].includes(p.ownerMode)||
      !Number.isSafeInteger(p.maxCpuThreads)||p.maxCpuThreads<1||!Number.isSafeInteger(p.maxMemoryBytes)||p.maxMemoryBytes<67108864||!Number.isSafeInteger(p.reserveMemoryBytes)||p.reserveMemoryBytes<0)throw Error('HOST_CONFIG_INVALID');
    const ledger=await DurableLedger.open(config.directory,config.identity,config.connection.certificate);
    try{return new CpuHost(ledger,config,onError);}catch(error){await ledger.close();throw error;}
  }
  private executor(capability:string,now:number):ExecutorV2{
    const pack=builtinCpuPacks().find(p=>p.manifest.contract.capability===capability)!,cost=this.costs.get(capability);
    const prior=(value:number|null,sampledAt=now):NumericSampleV2=>({value,source:value===null?'UNKNOWN':'PRIOR',sampledAt,ttlMs:3600000,unit:'ms'});
    return {target:{targetId:'cpu-'+createHash('sha256').update(this.config.identity.holderInstanceId+':'+capability).digest('hex').slice(0,32),deviceId:this.config.identity.deviceId,
      executorId:'node.cpu.v1',executorVersion:'1',backend:'CPU',resourcePoolIds:['cpu','ram'],stableExecutionId:'node.cpu.v1'},contract:pack.manifest.contract,model:null,
      resources:structuredClone(cpuResources),configurations:[{...cpuConfiguration}],compute:prior(cost?.value??null,cost?cost.at+this.clockOffset:now),queue:prior(0),cold:prior(0),publish:prior(0),uncertainty:prior(0)};
  }
  private async sample(syncSettings=true){
    try{
      if(this.agent.ready&&syncSettings){
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
        executors:builtinCpuPacks().map(pack=>this.executor(pack.manifest.contract.capability,now)),links,credits:['ORIGIN_INTERACTIVE','REMOTE_INTERACTIVE','REMOTE_BATCH'].map(priority=>({priority,slots:owner==='IDLE'?1:0}))};
      await this.agent.publishProfile(profile);
    }catch(error){this.onError(error);this.owner='UNKNOWN';this.limits=[];await this.agent.updateResources([],'UNKNOWN');}
  }
  tick(syncSettings=true){if(!this.pending&&!this.stopped)this.pending=this.sample(syncSettings).finally(()=>{this.pending=undefined;});return this.pending??Promise.resolve();}
  start(){if(this.timer||this.stopped)throw Error('HOST_STARTED');this.agent.start();this.timer=setInterval(()=>{void this.tick().catch(this.onError);},2000);void this.tick().catch(this.onError);}
  async close(){if(this.stopped)return;this.stopped=true;if(this.timer)clearInterval(this.timer);await this.agent.close();await this.pending;await this.ledger.close();}
}

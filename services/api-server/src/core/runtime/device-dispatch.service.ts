import { RuntimeExecutionContext } from './executor-registry.service';
import { DeviceDirectoryService, ResourceProfile } from './device-directory.service';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import { chooseRecovery } from './recovery-policy';
import { PerformanceRegistryService } from './performance-registry.service';
import { Injectable, Optional, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { RuntimeWorkScope } from './runtime-work-scope';
import { WorkflowPlacementPlanner, PlacementCandidate, PlacementRollout, PlacementLink, authorizePlacement } from './workflow-placement-planner';
import { ArtifactRef } from './scheduling-protocol';
import { QueryImageCropResult } from '../../modules/sessions/application/query-image-content-adapter.interface';
import { MacroSchedulerService, DeviceCandidate, TaskGraph, SchedulingContext, SchedulingDecision, TaskSpec } from './macro-scheduler.service';

export interface CloudTaskExecution {
  task: TaskSpec;
  inputs: TaskGraph['inputs'];
  macroContext: SchedulingDecision['macroContext'];
  signal: AbortSignal;
}
export interface DispatchOptions {
  remoteExecutors?: Array<{candidate:DeviceCandidate; execute:(request:CloudTaskExecution)=>Promise<any>}>;
  // Call-scoped implementations: business state and credentials stay out of task graphs.
  cloudExecutors?: Record<string, (request: CloudTaskExecution) => Promise<any>>;
  // Business orchestration stages are not portable compute payloads.
  remoteAllowed?: boolean;
}

interface DeviceConfiguration { deviceId:string;endpoint:string;tokenEnv:string;enabled:boolean;qualityVerified:boolean;cropPriorMs:number; }
interface Descriptor {protocolVersion:number;deviceId:string;instanceId:string;adapterVersion:string;capabilities:string[];capacity:{slots:number;memoryBytes:number};profile?:ResourceProfile;}
interface Receipt {leaseId:string;fencingToken:number;state:string;settled:boolean;stopRequested:boolean;executionMs:number|null;errorCode:string|null;
  output:null|{artifact:ArtifactRef;metadata:QueryImageCropResult['metadata'];cropRegionPx:QueryImageCropResult['cropRegionPx'];strategy:string;inputHash:string;};}
interface Sample {bytes?:number;count:number;mean:number;deviation:number;failures:number;observedAt:number;}

@Injectable()
export class DeviceDispatchService {
  private readonly logger=new Logger(DeviceDispatchService.name);
  constructor(
    @Optional() private readonly performanceRegistry?: PerformanceRegistryService,
    @Optional() private readonly macroScheduler?: MacroSchedulerService,
    @Optional() private readonly directory?: DeviceDirectoryService,
    @Optional() private readonly prisma?: PrismaService
  ) {}
  private readonly samples=new Map<string,Sample>();
  private readonly planner=new WorkflowPlacementPlanner();
  private readonly circuits=new Map<string,{failures:number;retryAt:number}>();
  private readonly decisions:unknown[]=[];
  async onModuleInit():Promise<void> {
    if (!this.prisma) return;
    const rows = await this.prisma.runtimeCostSample.findMany({where:{observedAt:{gt:new Date(Date.now()-300000)}},take:256,orderBy:{observedAt:'desc'}});
    for (const row of rows) this.samples.set(row.id,JSON.parse(row.sampleJson));
  }
  recentDecisions():unknown[]{return this.decisions.slice();}
  private async devices():Promise<DeviceConfiguration[]> {
    const values=JSON.parse(process.env.RUNTIME_DEVICES_JSON??'[]') as DeviceConfiguration[];
    if(!Array.isArray(values)||values.length>32)throw new Error('DEVICE_CONFIG_INVALID');
    const seen=new Set<string>();
    const legacy = values.filter(value=>value.enabled).map(value=>{
      const url=new URL(value.endpoint);
      if(!/^[\w.-]{1,128}$/.test(value.deviceId)||seen.has(value.deviceId)||!/^\w{1,128}$/.test(value.tokenEnv)||
        (url.protocol!=='https:'&&!(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname)))||url.username||url.password||url.search||url.hash||
        !Number.isFinite(value.cropPriorMs)||value.cropPriorMs<=0)throw new Error('DEVICE_CONFIG_INVALID');
      seen.add(value.deviceId);return {...value,endpoint:value.endpoint.replace(/\/$/,'')};
    });
    return this.directory ? this.directory.workers(legacy) : legacy;
  }
  private async call<T>(device:DeviceConfiguration,ownerId:string,path:string,body:unknown,signal:AbortSignal,binary=false,schemaId='shopping.image'):Promise<T> {
    const token=process.env[device.tokenEnv];if(!token||token.length<32)throw new Error('DEVICE_CREDENTIAL_MISSING');
    const response=await fetch(device.endpoint+'/v1/'+path,{method:path==='descriptor'?'GET':'POST',redirect:'error',signal,
      headers:{Authorization:'Bearer '+token,'x-owner-id':ownerId,'Content-Type':binary?'application/octet-stream':'application/json','x-schema-id':schemaId},
      body:path==='descriptor'?undefined:binary?new Uint8Array(body as Uint8Array).buffer:JSON.stringify(body)});
    if(!response.ok){const failure=await response.json() as {error?:string};throw new Error(failure.error&&/^[A-Z0-9_]{1,100}$/.test(failure.error)?failure.error:'DEVICE_HTTP_FAILED');}
    return (path==='artifacts/resolve'?Buffer.from(await response.arrayBuffer()):await response.json()) as T;
  }
  private key(deviceId:string,bytes:number,parameters:unknown):string{return `crop:v1:${deviceId}:${Math.floor(Math.log2(Math.max(1,bytes)))}:${createHash('sha256').update(JSON.stringify(parameters)).digest('hex').slice(0,16)}`;}
  private observe(key:string,ms:number,success:boolean,bytes?:number):void {
    if(!Number.isFinite(ms)||ms<0)return;
    const old=this.samples.get(key)??{count:0,mean:ms,deviation:0,failures:0,observedAt:Date.now()};
    if(success){old.deviation=.75*old.deviation+.25*Math.abs(ms-old.mean);old.mean=.75*old.mean+.25*ms;old.count++;}else old.failures++;
    if(bytes!==undefined) old.bytes=bytes;
    old.observedAt=Date.now();this.samples.set(key,old);if(this.samples.size>256)this.samples.delete(this.samples.keys().next().value!);
    if (this.prisma) {
      const sampleJson=JSON.stringify(old),observedAt=new Date(old.observedAt);
      // Cancellation must not prevent settlement telemetry. Track persistence before leaving the scope.
      RuntimeWorkScope.track(RuntimeWorkScope.settlement(async()=> {
        await this.prisma!.runtimeCostSample.upsert({where:{id:key},create:{id:key,sampleJson,observedAt},update:{sampleJson,observedAt}});
        await this.prisma!.runtimeCostSample.deleteMany({where:{observedAt:{lt:new Date(Date.now()-86400000)}}});
      }).catch(()=> { this.logger.warn('DISPATCH_FEEDBACK_PERSISTENCE_FAILED'); }));
    }
  }
  async crop<T extends QueryImageCropResult>(bytes:Buffer,parameters:{box:{x:number;y:number;width:number;height:number};paddingRatio:number;targetSize:number;jpegQuality:number},
    local:()=>Promise<T>):Promise<QueryImageCropResult> {
    parameters = { box: parameters.box, paddingRatio: parameters.paddingRatio, targetSize: parameters.targetSize, jpegQuality: parameters.jpegQuality };
    const devices=await this.devices(),ownerId=RuntimeWorkScope.ownerId();
    const baseline=async()=>{const start=performance.now();try{const value=await local();this.observe(this.key('cloud-runtime',bytes.length,parameters),performance.now()-start,true);return value;}
      catch(error){this.observe(this.key('cloud-runtime',bytes.length,parameters),performance.now()-start,false);throw error;}};
    if(!ownerId||!devices.length)return baseline();
    const budget = RuntimeWorkScope.remainingBudget(60000);
    if (budget <= 0) throw new Error('DEADLINE_EXCEEDED');
    const signal=RuntimeWorkScope.signal(Math.max(1,Math.ceil(budget))),now=Date.now();
    const config:PlacementRollout=JSON.parse(process.env.PLACEMENT_POLICY_JSON??JSON.stringify({mode:'OBSERVE',policyVersion:'placement-v1',expiresAt:0,killSwitch:true,
      allowedDevices:[],allowedCapabilities:[],sampleCount:0,minimumSamples:30,qualityPassed:false,nonInferiorityPassed:false,failureRate:0,maximumFailureRate:0.05,cohortAllowed:false}));
    const localSample=this.samples.get(this.key('cloud-runtime',bytes.length,parameters));
    if(!localSample||localSample.count<3) { RuntimeWorkScope.recordPlacement({actualDeviceId:'cloud-runtime',reason:'BASELINE_COST_CALIBRATION',mode:config.mode}); return baseline(); }
    const candidates:PlacementCandidate[]=[{deviceId:'cloud-runtime',executorId:'zeabur-shopping-workflow',capability:'image.crop.v1',trusted:true,source:'REAL',observedAt:now,ttlMs:3000,
      availableSlots:1,availableMemoryBytes:256*1024*1024,quality:1,computeMs:localSample?.mean??60000,queueMs:0,coldMs:0,uncertaintyMs:localSample?2*localSample.deviation:0,publishMs:0}];
    const links:Parameters<WorkflowPlacementPlanner['plan']>[0]['links']=[];
    for(const device of devices){
      const circuit=this.circuits.get(device.deviceId);
      if(circuit&&circuit.failures>=3&&now<circuit.retryAt)continue;
      try {
        const before=performance.now(),descriptor=await this.call<Descriptor>(device,ownerId,'descriptor',null,AbortSignal.any([signal,AbortSignal.timeout(1500)]));
        const rtt=performance.now()-before;
        this.circuits.delete(device.deviceId);
        if(descriptor.protocolVersion!==1||descriptor.deviceId!==device.deviceId||descriptor.adapterVersion!=='1'||!descriptor.capabilities.includes('image.crop.v1'))continue;
        const sample=this.samples.get(this.key(device.deviceId,bytes.length,parameters));
        candidates.push({deviceId:device.deviceId,executorId:'cpu-worker',capability:'image.crop.v1',trusted:true,source:'REAL',observedAt:now,ttlMs:3000,
          availableSlots:descriptor.capacity.slots,availableMemoryBytes:descriptor.capacity.memoryBytes,quality:device.qualityVerified?1:null,
          computeMs:sample?.mean??device.cropPriorMs,queueMs:0,coldMs:0,uncertaintyMs:sample?sample.deviation*2:device.cropPriorMs,publishMs:0});
        // No bandwidth is inferred from a small handshake. Only confirmed transfer samples authorize a route.
        const transfer=this.samples.get(this.key(device.deviceId+':transfer',bytes.length,parameters));
        if(transfer&&transfer.count>=3&&now-transfer.observedAt<30000){
          links.push({from:'cloud-runtime',to:device.deviceId,bytesPerSecond:bytes.length/Math.max(1,transfer.mean)*1000,fixedMs:rtt,effective:true,source:'REAL',observedAt:transfer.observedAt,ttlMs:30000});
          const download=this.samples.get(this.key(device.deviceId+':download',bytes.length,parameters));
          if(download&&download.count>=3)links.push({from:device.deviceId,to:'cloud-runtime',bytesPerSecond:(download.bytes??bytes.length)/Math.max(1,download.mean)*1000,fixedMs:rtt,effective:true,source:'REAL',observedAt:download.observedAt,ttlMs:30000});
        }
      }catch{this.circuits.set(device.deviceId,{failures:(this.circuits.get(device.deviceId)?.failures??0)+1,retryAt:now+30000});}
    }
    const nodes: Parameters<WorkflowPlacementPlanner['plan']>[0]['nodes']=[{id:'crop',capability:'image.crop.v1',dependencies:[],inputs:['image'],
      output:{id:'crop-image',bytes:parameters.targetSize*parameters.targetSize*4+65536},baselineDeviceId:'cloud-runtime',memoryBytes:128*1024*1024,minimumQuality:1,candidates}];
    // The current image graph is serial. Keep the committed prefix fixed and price the entire remaining suffix.
    // Downstream costs must come from confirmed executions, never the crop's timing or a handshake.
    let downstreamKnown=true,previous='crop',previousOutput='crop-image';
    for (const stage of ['category','product-profile','embedding','vector-search','price-stock','rank','answer','result']) {
      const sample=this.performanceRegistry?.get('shopping.stage.'+stage,'zeabur-shopping-workflow');
      if(!sample||sample.sampleCount<3||sample.p95LatencyMs===null||Date.now()-Date.parse(sample.measuredAt)>300000){downstreamKnown=false;break;}
      nodes.push({id:stage,capability:'shopping.stage.'+stage,dependencies:[previous],inputs:[previousOutput],output:{id:stage+'-output',bytes:1024*1024},
        baselineDeviceId:'cloud-runtime',memoryBytes:0,minimumQuality:0,candidates:[{...candidates[0],capability:'shopping.stage.'+stage,computeMs:sample.p95LatencyMs,uncertaintyMs:sample.p95LatencyMs*.15}]});
      previous=stage;previousOutput=stage+'-output';
    }
    const decision=this.planner.plan({nodes,artifacts:[{id:'image',bytes:bytes.length,replicas:[{deviceId:'cloud-runtime',readMs:0}]}],
      links,remainingBudgetMs:RuntimeWorkScope.remainingBudget(60000),networkAllowed:true,privacy:'AUTHORIZED_REMOTE',localDeviceId:'cloud-runtime',now,
      committedNodeIds:[],committedArtifacts:[],finalDestination:'cloud-runtime'});
    const gated=downstreamKnown?config:{...config,mode:'SHADOW' as const};
    const actual=authorizePlacement(decision,gated,'image.crop.v1',now)?.[0];
    RuntimeWorkScope.recordPlacement({decision,actualDeviceId:actual?.deviceId??null,policyVersion:config.policyVersion,mode:config.mode,
      dispatchBlockedReason:downstreamKnown?null:'SUFFIX_COST_SAMPLES_MISSING',outputSizeSource:'schema-and-crop-upper-bound'});
    this.decisions.push({decision,actualDeviceId:actual?.deviceId??null,policyVersion:config.policyVersion,mode:config.mode});if(this.decisions.length>64)this.decisions.shift();
    if(!actual)throw new Error('NO_LEGAL_PLACEMENT');
    if(actual.deviceId==='cloud-runtime')return baseline();
    const device=devices.find(d=>d.deviceId===actual.deviceId)!;
    try { return await this.executeCrop(device,ownerId,bytes,parameters,signal,{
      baselineDevice: decision.baseline?.[0]?.deviceId ?? 'cloud-runtime',
      selectedReason: decision.reason, urgency: RuntimeWorkScope.scheduling().userWaiting,
      budgetMs: RuntimeWorkScope.remainingBudget(60000)
    }); }
    catch (error) {
      signal.throwIfAborted();
      if ((error as Error).message === 'CAPACITY_FULL') return baseline();
      if (process.env.WORKFLOW_RECOVERY_ENABLED !== 'true') throw error;
      const recovery=chooseRecovery({committed:false,cancelled:signal.aborted,remainingBudgetMs:RuntimeWorkScope.remainingBudget(0),attempts:0,
        maximumAttempts:config.maximumRecoveryAttempts??0,options:[{action:'RECOMPUTE',checkpointAvailable:false,compatible:true,replaySafe:true,additionalMs:0,
          placement:{...decision,status:decision.baseline?'ready':'blocked',suggestion:decision.baseline,suggestionMs:decision.baselineMs}}]});
      RuntimeWorkScope.recordPlacement({recovery,capability:'image.crop.v1',oldReservation:'target retains until physical settlement'});
      if(recovery.action==='RECOMPUTE')return baseline();
      throw error;
    }
  }
  // Explicit calibration uses real work but cannot update business state. Called by an operator/test harness.
  async calibrate(deviceId:string,ownerId:string,bytes:Buffer,parameters:Parameters<DeviceDispatchService['crop']>[1],signal:AbortSignal):Promise<QueryImageCropResult>{
    const device=(await this.devices()).find(d=>d.deviceId===deviceId);if(!device)throw new Error('DEVICE_NOT_REGISTERED');
    return this.executeCrop(device,ownerId,bytes,parameters,signal);
  }
  private async executeCrop(device:DeviceConfiguration,ownerId:string,bytes:Buffer,parameters:Parameters<DeviceDispatchService['crop']>[1],signal:AbortSignal,macroContext:SchedulingDecision['macroContext']={baselineDevice:'cloud-runtime',selectedReason:'EXPLICIT_CALIBRATION',urgency:false,budgetMs:RuntimeWorkScope.remainingBudget(60000)}):Promise<QueryImageCropResult>{
    const budget=RuntimeWorkScope.remainingBudget(60000),began=performance.now();let lease:Receipt|undefined,settled=false;
    try {
      const start=performance.now(),input=await this.call<ArtifactRef>(device,ownerId,'artifacts',bytes,signal,true);
      if(input.contentHash!==createHash('sha256').update(bytes).digest('hex'))throw new Error('INPUT_HASH_MISMATCH');
      this.observe(this.key(device.deviceId+':transfer',bytes.length,parameters),performance.now()-start,true);
      lease=await this.call<Receipt>(device,ownerId,'leases',{attemptId:'attempt_'+randomUUID(),memoryBytes:128*1024*1024,remainingBudgetMs:Math.max(0,budget-(performance.now()-began))},signal);
      await this.call(device,ownerId,'execute',{leaseId:lease.leaseId,fencingToken:lease.fencingToken,capability:'image.crop.v1',input,parameters,privacy:'AUTHORIZED_REMOTE',networkAllowed:true,macroContext:{...macroContext,budgetMs:Math.max(0,Math.min(macroContext.budgetMs,budget)-(performance.now()-began))}},signal);
      while(performance.now()-began<budget){
        if (!(await this.devices()).some(d=>d.deviceId===device.deviceId&&d.endpoint===device.endpoint&&d.tokenEnv===device.tokenEnv)) throw new Error('DEVICE_REVOKED');
        const receipt=await this.call<Receipt>(device,ownerId,'query',{leaseId:lease.leaseId},signal);
        if(receipt.settled){settled=true;if(receipt.errorCode||receipt.stopRequested||!receipt.output)throw new Error(receipt.errorCode??'WORKER_STOPPED');
          const downloadAt=performance.now(),output=await this.call<Buffer>(device,ownerId,'artifacts/resolve',receipt.output.artifact,signal);
          if(createHash('sha256').update(output).digest('hex')!==receipt.output.artifact.contentHash||receipt.output.inputHash!==input.contentHash)throw new Error('OUTPUT_HASH_MISMATCH');
          // Size-specific sample, never a simulated latency label.
          this.observe(this.key(device.deviceId+':download',bytes.length,parameters),performance.now()-downloadAt,true,output.length);
          this.observe(this.key(device.deviceId,bytes.length,parameters),receipt.executionMs??performance.now()-began,true);
          return {buffer:output,metadata:receipt.output.metadata,cropRegionPx:receipt.output.cropRegionPx,strategy:receipt.output.strategy};}
        await new Promise(resolve=>setTimeout(resolve,20));signal.throwIfAborted();
      }throw new Error('WORKER_STOP_UNCONFIRMED');
    }catch(error){this.observe(this.key(device.deviceId,bytes.length,parameters),performance.now()-began,false);throw error;}
    finally {
      if(lease){const cleanup=AbortSignal.timeout(3000);try{if(!settled)await this.call(device,ownerId,'cancel',{leaseId:lease.leaseId},cleanup);
        else await this.call(device,ownerId,'release',{leaseId:lease.leaseId},cleanup);}catch{/* Keep unconfirmed reservations at the target; never claim they were released. */}}
    }
  }

  /**
   * 通用派发方法 - 不限于裁剪
   *
   * 这是新的通用入口，使用MacroScheduler进行设备选择
   * 逐步替代crop()方法的业务绑定逻辑
   *
   * @param graph 任务图
   * @param context 调度上下文
   * @returns 执行结果
   */
  async dispatch(graph: TaskGraph, context: SchedulingContext, options: DispatchOptions = {}): Promise<any> {
    graph={...graph,workflowId:graph.workflowId??'workflow_'+randomUUID()};
    if (!this.macroScheduler) throw new Error('MACRO_SCHEDULER_NOT_AVAILABLE');
    if (!RuntimeWorkScope.ownerId()) throw new Error('OWNER_ID_REQUIRED');
    const started = performance.now();
    const totalBudget = Math.min(context.budgetMs, RuntimeWorkScope.remainingBudget(context.budgetMs));
    if (!Number.isFinite(totalBudget) || totalBudget <= 0) throw new Error('DEADLINE_EXCEEDED');
    const signal = RuntimeWorkScope.signal(Math.ceil(totalBudget));
    signal.throwIfAborted();
    const ordered = this.orderTasks(graph);
    const candidates = new Map<string, DeviceCandidate>();
    // Query every node capability, not the workflow's business label.
    for (const capability of new Set(ordered.map(task => task.capability))) {
      signal.throwIfAborted();
      for (const candidate of await this.queryCandidates(capability, signal,
        options.remoteAllowed !== false && context.networkAllowed && context.privacyLevel === 'AUTHORIZED_REMOTE')) {
        candidates.set(candidate.deviceId, candidate);
      }
    }
    const cloud = candidates.get('cloud-runtime');
    if (options.remoteAllowed !== false && context.networkAllowed && context.privacyLevel === 'AUTHORIZED_REMOTE') {
      for (const adapter of options.remoteExecutors ?? []) {
        if (adapter.candidate.deviceId === 'cloud-runtime' || candidates.has(adapter.candidate.deviceId)) throw new Error('DUPLICATE_DEVICE_ADAPTER');
        candidates.set(adapter.candidate.deviceId,adapter.candidate);
      }
    }
    if (cloud) {
      cloud.capabilities = Object.keys(options.cloudExecutors ?? {});
      if (!cloud.capabilities.length) candidates.delete('cloud-runtime');
    }
    const remaining = () => {
      signal.throwIfAborted();
      const budget = Math.min(totalBudget - (performance.now() - started), RuntimeWorkScope.remainingBudget(totalBudget));
      if (budget <= 0) throw new Error('DEADLINE_EXCEEDED');
      return budget;
    };
    for (const candidate of candidates.values()) {
      candidate.taskHistory = {};
      for (const task of ordered) {
        const inputs = graph.inputs.filter(input=>task.inputs.includes(input.artifactId));
        if (inputs.length !== task.inputs.length) continue; // Actual dependent-output size is not known yet.
        const sample = this.samples.get(this.taskSampleKey(task.capability,candidate.deviceId,inputs,task.parameters));
        if (sample?.count && Date.now()-sample.observedAt < 300000 && candidate.history) {
          candidate.taskHistory[task.id] = {quality:candidate.history.quality,meanMs:sample.mean,
            stddevMs:Math.max(2*sample.deviation,sample.mean*0.15),sampleCount:sample.count};
        }
      }
    }
    const links = context.links ?? this.measuredLinks(graph, [...candidates.keys()]);
    const decision = await this.macroScheduler.schedule({...graph, tasks:ordered}, [...candidates.values()],
      {...context,links,budgetMs:remaining(),materializeOutputsAt:'cloud-runtime'});
    let assignments = decision.assignments;
    let actualMode = decision.mode, actualReason = decision.reason;
    if (assignments?.some(a=>a.deviceId !== 'cloud-runtime')) {
      const rollout: PlacementRollout = JSON.parse(process.env.PLACEMENT_POLICY_JSON ?? '{}');
      const plan = {status:'ready' as const,baseline:decision.baselineAssignments,suggestion:assignments,
        baselineMs:decision.baseline.estimatedMs,suggestionMs:decision.estimatedMs,rejections:[],truncated:0,planningMs:decision.planningMs,reason:decision.reason};
      if (ordered.some(task=>authorizePlacement(plan,rollout,task.capability,Date.now()) !== assignments)) {
        assignments = decision.baselineAssignments;
        actualMode = 'BASELINE';actualReason = 'PLACEMENT_ROLLOUT_BASELINE';
      }
    }
    if (!assignments || assignments.length !== ordered.length || new Set(assignments.map(a => a.nodeId)).size !== ordered.length ||
      ordered.some(task => !assignments.some(a => a.nodeId === task.id))) throw new Error('DISPATCH_INCOMPLETE_PLAN');
    for (const task of ordered) {
      const assignment = assignments.find(a => a.nodeId === task.id)!;
      if (assignment.deviceId === 'cloud-runtime' && !options.cloudExecutors?.[task.capability]) throw new Error('CLOUD_EXECUTOR_NOT_REGISTERED');
      if (assignment.deviceId !== 'cloud-runtime' && (!context.networkAllowed || context.privacyLevel !== 'AUTHORIZED_REMOTE' || options.remoteAllowed === false)) {
        throw new Error('TRANSFER_NOT_AUTHORIZED');
      }
    }
    const artifacts = new Map(graph.inputs.map(input => [input.artifactId, input]));
    const outputs: Record<string, any> = Object.create(null);
    for (const task of ordered) {
      const assignment = assignments.find(a => a.nodeId === task.id)!;
      const inputIds = task.inputs.length ? task.inputs : ordered.length === 1 ? graph.inputs.map(input => input.artifactId) : [];
      const inputs = inputIds.map(id => {
        const ref = artifacts.get(id);
        if (!ref) throw new Error('TASK_INPUT_UNAVAILABLE');
        return ref;
      });
      const budgetMs = remaining();
      const macroContext = {...decision.macroContext, selectedReason:actualReason, budgetMs,
        workflowId:graph.workflowId,taskId:task.id,attemptId:'attempt_'+randomUUID(),
        baselineDevice: decision.baselineAssignments?.find(a => a.nodeId === task.id)?.deviceId ?? decision.macroContext.baselineDevice};
      RuntimeWorkScope.recordPlacement({nodeId:task.id, capability:task.capability, actualDeviceId:assignment.deviceId,
        reason:actualReason,mode:actualMode,estimatedMs:decision.estimatedMs});
      // Dependencies have settled; send a single physical operation per lease.
      const nodeGraph = {capability:task.capability,inputs,tasks:[{...task,dependencies:[],inputs:inputs.map(i=>i.artifactId)}]};
      const began = performance.now();
      let result: any;
      try {
        const adapter = options.remoteExecutors?.find(a=>a.candidate.deviceId===assignment.deviceId);
        result = assignment.deviceId === 'cloud-runtime' ?
          await this.executeOnCloud(nodeGraph, macroContext, options, signal) : adapter ?
          await adapter.execute({task:nodeGraph.tasks[0],inputs,macroContext,signal}) :
          await this.executeOnWorker(assignment.deviceId, nodeGraph, macroContext, {...context,budgetMs});
        signal.throwIfAborted();
        if (assignment.deviceId === 'cloud-runtime') {
          this.observe(this.taskSampleKey(task.capability,assignment.deviceId,inputs,task.parameters),performance.now()-began,true);
        }
      } catch (error) {
        this.observe(this.taskSampleKey(task.capability,assignment.deviceId,inputs,task.parameters),performance.now()-began,false);
        throw error;
      }
      outputs[task.id] = result;
      const outputId = task.id + '-output';
      if (ordered.some(next => next.inputs.includes(outputId))) {
        if (!result || !Buffer.isBuffer(result.buffer)) throw new Error('TASK_OUTPUT_ARTIFACT_REQUIRED');
        const data = result.buffer as Buffer;
        const contentHash = createHash('sha256').update(data).digest('hex');
        if (result.artifact && result.artifact.contentHash !== contentHash) throw new Error('OUTPUT_HASH_MISMATCH');
        // A graph-local logical ID maps to an immutable, hash-checked output. The next target uploads the bytes.
        artifacts.set(outputId, {artifactId:outputId,contentHash,contentVersion:1,
          schemaId:result.artifact?.schemaId ?? task.outputSchemaId ?? inputs[0]?.schemaId ?? 'application.octet-stream',
          schemaVersion:1,data,sizeBytes:data.length});
      }
      const suffix=ordered.slice(ordered.indexOf(task)+1);
      if(suffix.length) {
        // Replan only unexecuted nodes with actual output sizes and the original remaining budget.
        // Completed nodes and their effects are never replayed by this boundary.
        const pending=new Set(suffix.map(node=>node.id));
        const rest=await this.dispatch({...graph,inputs:[...artifacts.values()],
          tasks:suffix.map(node=>({...node,dependencies:node.dependencies.filter(id=>pending.has(id))}))},
          {...context,budgetMs:remaining()},options);
        if(suffix.length===1) {outputs[suffix[0].id]=rest;return {output:rest,outputs};}
        return {output:rest.output,outputs:{...outputs,...rest.outputs}};
      }
    }
    const output = outputs[ordered[ordered.length - 1].id];
    return ordered.length === 1 ? output : {output,outputs};
  }

  // Keep RuntimeRunner's dependency, commit and cancellation ownership. Each business stage
  // supplies its already-authorized executor; portable operations use dispatch() with artifact inputs.
  async dispatchRuntimeStage(context:RuntimeExecutionContext, execute:()=>Promise<unknown>):Promise<unknown> {
    const capability = context.task.toolId;
    const budgetMs = RuntimeWorkScope.remainingBudget(context.task.constraints?.maxLatencyMs ?? 60000);
    const semantic = RuntimeWorkScope.scheduling();
    return this.dispatch({capability,inputs:[],tasks:[{id:context.task.taskId,capability,dependencies:[],inputs:[],
      outputBytes:0,memoryMB:0,minQuality:context.task.constraints?.minimumQuality ?? 0}]},
      {budgetMs,networkAllowed:false,privacyLevel:'LOCAL_ONLY',...semantic},
      {remoteAllowed:false,cloudExecutors:{[capability]:async()=>execute()}});
  }

  private measuredLinks(graph:TaskGraph,deviceIds:string[]):PlacementLink[] {
    // Calibration measures full transfer time; do not add the handshake a second time.
    // Until samples exist, the planner cannot authorize a remote data transfer.
    const links:PlacementLink[] = [];
    if (graph.tasks.length !== 1 || graph.inputs.length !== 1) return links;
    const bytes = graph.inputs[0].data?.byteLength ?? graph.inputs[0].sizeBytes ?? 0;
    for (const deviceId of deviceIds.filter(id=>id!=='cloud-runtime')) {
      for (const direction of ['transfer','download']) {
        const sample = this.samples.get(this.key(deviceId+':'+direction,bytes,graph.tasks[0].parameters ?? {}));
        if (!sample || sample.count < 3 || Date.now()-sample.observedAt >= 30000) continue;
        const size = direction === 'transfer' ? bytes : sample.bytes;
        if (!size) continue;
        links.push({from:direction==='transfer'?'cloud-runtime':deviceId,to:direction==='transfer'?deviceId:'cloud-runtime',
          bytesPerSecond:size/Math.max(1,sample.mean)*1000,fixedMs:0,effective:true,source:'REAL',observedAt:sample.observedAt,ttlMs:30000});
      }
    }
    return links;
  }

  private taskSampleKey(capability:string,deviceId:string,inputs:TaskGraph['inputs'],parameters:unknown):string {
    const bytes = inputs.reduce((sum,input)=>sum+(input.data?.byteLength ?? input.sizeBytes ?? 0),0);
    return `task:${capability}:${this.key(deviceId,bytes,parameters ?? {})}`;
  }

  private orderTasks(graph:TaskGraph):TaskSpec[] {
    if (!graph.tasks.length || graph.tasks.length > 64 || new Set(graph.tasks.map(t=>t.id)).size !== graph.tasks.length ||
      new Set(graph.inputs.map(i=>i.artifactId)).size !== graph.inputs.length) throw new Error('TASK_GRAPH_INVALID');
    const pending = [...graph.tasks], ordered:TaskSpec[] = [], known = new Set<string>();
    while (pending.length) {
      const index = pending.findIndex(task=>task.dependencies.every(id=>known.has(id)));
      if (index < 0) throw new Error('TASK_GRAPH_DEPENDENCY_INVALID');
      const task = pending.splice(index,1)[0];
      if (!task.id || !task.capability || !Number.isFinite(task.memoryMB) || task.memoryMB < 0 ||
        !Number.isFinite(task.outputBytes) || task.outputBytes < 0) throw new Error('TASK_GRAPH_INVALID');
      if (task.contract && (task.contract.protocolVersion !== 1 || task.contract.capability !== task.capability ||
          task.inputs.some(id=>{const input=graph.inputs.find(i=>i.artifactId===id);return input&&!task.contract!.inputSchemas.includes(input.schemaId);}))) {
        throw new Error('TASK_CONTRACT_MISMATCH');
      }
      const ancestors = new Set<string>(task.dependencies);
      for (const earlier of [...ordered].reverse()) if (ancestors.has(earlier.id)) earlier.dependencies.forEach(id=>ancestors.add(id));
      for (const id of task.inputs) {
        if (!graph.inputs.some(input=>input.artifactId===id) && ![...ancestors].some(parent=>parent+'-output'===id)) {
          throw new Error('TASK_INPUT_DEPENDENCY_INVALID');
        }
      }
      if (graph.inputs.some(input=>input.artifactId===task.id+'-output')) throw new Error('TASK_GRAPH_INVALID');
      ordered.push(task);known.add(task.id);
    }
    return ordered;
  }

  /**
   * 查询支持特定capability的候选设备
   */
  private async queryCandidates(capability: string, parentSignal?: AbortSignal, remoteAllowed = true): Promise<DeviceCandidate[]> {
    const candidates: DeviceCandidate[] = [];
    const now = Date.now();
    const ownerId = RuntimeWorkScope.ownerId() ?? 'system';

    // 1. Cloud总是可用(兜底)
    const cloudSample = this.samples.get(`crop:v1:cloud-runtime:*:*`);
    candidates.push({
      deviceId: 'cloud-runtime',
      deviceType: 'CLOUD',
      executorId: 'zeabur-shopping-workflow',
      capabilities: ['*'], // Cloud支持所有
      trusted: true,
      observedAt: now,
      ttlMs: 60000,
      resourceSnapshot: {
        availableSlots: 10,
        availableMemoryMB: 2048,
        queueLength: 0
      },
      history: cloudSample ? {
        quality: 1,
        meanMs: cloudSample.mean,
        stddevMs: cloudSample.deviation,
        sampleCount: cloudSample.count
      } : { quality: 1, meanMs: 1000, stddevMs: 200, sampleCount: 0 }
    });

    // 2. 查询Worker设备
    const devices = remoteAllowed ? await this.devices() : [];
    const signal = parentSignal ? AbortSignal.any([parentSignal,AbortSignal.timeout(2000)]) : AbortSignal.timeout(2000);

    for (const device of devices) {
      const circuit = this.circuits.get(device.deviceId);
      if (circuit && circuit.failures >= 3 && now < circuit.retryAt) {
        continue; // 断路器打开
      }

      try {
        const descriptor = await this.call<Descriptor>(
          device,
          ownerId,
          'descriptor',
          null,
          signal
        );

        this.circuits.delete(device.deviceId);
        if (descriptor.protocolVersion !== 1 || descriptor.deviceId !== device.deviceId || descriptor.adapterVersion !== '1') continue;
        if (descriptor.profile && (descriptor.profile.thermalLevel === 'CRITICAL' ||
            (descriptor.profile.cpuUsage !== null && descriptor.profile.cpuUsage > 90))) continue;

        // 检查是否支持该capability
        if (!descriptor.capabilities.includes(capability) &&
            !descriptor.capabilities.includes('*')) {
          continue;
        }

        const sample = this.samples.get(this.key(device.deviceId, 0, {}));

        candidates.push({
          deviceId: device.deviceId,
          deviceType: 'WORKER',
          executorId: 'cpu-worker',
          capabilities: descriptor.capabilities,
          trusted: true,
          observedAt: now,
          ttlMs: 30000,
          resourceSnapshot: {
            availableSlots: descriptor.capacity.slots,
            availableMemoryMB: descriptor.capacity.memoryBytes / (1024 * 1024),
            queueLength: descriptor.profile?.queueLength ?? 0
          },
          history: sample ? {
            quality: device.qualityVerified ? 1 : 0.95,
            meanMs: sample.mean,
            stddevMs: sample.deviation,
            sampleCount: sample.count
          } : device.qualityVerified ? { quality: 1, meanMs: device.cropPriorMs, stddevMs: device.cropPriorMs, sampleCount: 0 } : undefined
        });
      } catch (error) {
        this.circuits.set(device.deviceId, {
          failures: (this.circuits.get(device.deviceId)?.failures ?? 0) + 1,
          retryAt: now + 30000
        });
      }
    }

    return candidates;
  }

  /**
   * 在Worker上执行任务
   */
  private async executeOnWorker(
    deviceId: string,
    graph: TaskGraph,
    macroContext: SchedulingDecision['macroContext'],
    context: SchedulingContext
  ): Promise<any> {
    const device = (await this.devices()).find(d => d.deviceId === deviceId);
    if (!device) throw new Error('WORKER_NOT_FOUND');
    const ownerId = RuntimeWorkScope.ownerId();
    if (!ownerId) throw new Error('OWNER_ID_REQUIRED');
    if (!context.networkAllowed || context.privacyLevel !== 'AUTHORIZED_REMOTE') throw new Error('TRANSFER_NOT_AUTHORIZED');
    // The current Worker protocol executes one capability per lease.
    if (graph.tasks.length !== 1 || graph.tasks[0].dependencies.length !== 0) throw new Error('WORKER_GRAPH_UNSUPPORTED');
    const task = graph.tasks[0];
    const source = task.inputs.length === 1 ? graph.inputs.find(input => input.artifactId === task.inputs[0]) :
      task.inputs.length === 0 && graph.inputs.length === 1 ? graph.inputs[0] : undefined;
    if (!source) throw new Error('WORKER_INPUT_REQUIRED');
    const budget = Math.min(context.budgetMs, macroContext.budgetMs, RuntimeWorkScope.remainingBudget(context.budgetMs));
    if (!Number.isFinite(budget) || budget <= 0) throw new Error('DEADLINE_EXCEEDED');
    const signal = RuntimeWorkScope.signal(Math.ceil(budget));
    const began = performance.now();
    let lease: Receipt | undefined;
    let settled = false;
    try {
      signal.throwIfAborted();
      let input: ArtifactRef = source;
      if (source.data !== undefined) {
        const bytes = Buffer.from(source.data);
        if (createHash('sha256').update(bytes).digest('hex') !== source.contentHash) throw new Error('INPUT_HASH_MISMATCH');
        input = await this.call<ArtifactRef>(device, ownerId, 'artifacts', bytes, signal, true, source.schemaId);
        if (input.contentHash !== source.contentHash) throw new Error('INPUT_HASH_MISMATCH');
      } else {
        // References without bytes must already belong to this Worker and owner.
        await this.call<Buffer>(device, ownerId, 'artifacts/resolve', input, signal);
      }
      lease = await this.call<Receipt>(device, ownerId, 'leases', {
        attemptId: macroContext.attemptId ?? 'attempt_' + randomUUID(), memoryBytes: task.memoryMB * 1024 * 1024,
        remainingBudgetMs: Math.max(0, budget - (performance.now() - began))
      }, signal);
      await this.call(device, ownerId, 'execute', {
        leaseId: lease.leaseId, fencingToken: lease.fencingToken, capability: task.capability,
        input, parameters: task.parameters ?? {}, privacy: context.privacyLevel,
        networkAllowed: context.networkAllowed,
        macroContext: {...macroContext,budgetMs:Math.max(0,budget-(performance.now()-began))}
      }, signal);
      while (performance.now() - began < budget) {
        signal.throwIfAborted();
        if (!(await this.devices()).some(d => d.deviceId === deviceId && d.endpoint === device.endpoint && d.tokenEnv === device.tokenEnv)) throw new Error('DEVICE_REVOKED');
        const receipt = await this.call<Receipt>(device, ownerId, 'query', { leaseId: lease.leaseId }, signal);
        if (receipt.settled) {
          settled = true;
          if (receipt.errorCode || receipt.stopRequested || !receipt.output) throw new Error(receipt.errorCode ?? 'WORKER_STOPPED');
          if (receipt.output.inputHash !== input.contentHash) throw new Error('OUTPUT_HASH_MISMATCH');
          if (!receipt.output.artifact) return receipt.output;
          const buffer = await this.call<Buffer>(device, ownerId, 'artifacts/resolve', receipt.output.artifact, signal);
          if (createHash('sha256').update(buffer).digest('hex') !== receipt.output.artifact.contentHash) throw new Error('OUTPUT_HASH_MISMATCH');
          // Network costs are modeled separately; do not train compute with end-to-end latency.
          if (receipt.executionMs !== null) this.observe(this.taskSampleKey(task.capability,deviceId,graph.inputs,task.parameters),receipt.executionMs,true);
          return { ...receipt.output, buffer };
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('DEADLINE_EXCEEDED');
    } finally {
      if (lease) {
        try {
          await this.call(device, ownerId, settled ? 'release' : 'cancel', { leaseId: lease.leaseId }, AbortSignal.timeout(3000));
        } catch { /* The target retains reservations until physical settlement. */ }
      }
    }
  }

  /**
   * 在云端执行任务
   */
  private async executeOnCloud(
    graph: TaskGraph,
    macroContext: SchedulingDecision['macroContext'],
    options: DispatchOptions,
    signal: AbortSignal
  ): Promise<any> {
    const task = graph.tasks[0];
    const execute = options.cloudExecutors?.[task.capability];
    if (!execute) throw new Error('CLOUD_EXECUTOR_NOT_REGISTERED');
    signal.throwIfAborted();
    const result = await execute({task,inputs:graph.inputs,macroContext,signal});
    signal.throwIfAborted();
    return result;
  }
}

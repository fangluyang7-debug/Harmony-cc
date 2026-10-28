import { IMAGE_CROP_CONTRACT } from '../../modules/sessions/domain/image-crop-contract';
import { CapabilityCostModel } from './capability-cost-model';
import { admissionEvidence } from './placement-admission-evidence';
import { RuntimeCostStore, costKey, networkIdentity, SampleSource } from './runtime-cost-store';
import { CropQualityEvaluator } from './crop-quality-evaluator';
import { selectionPolicy } from './scheduling-selection-policy';
import { RuntimeExecutionContext } from './executor-registry.service';
import { DeviceDirectoryService, ResourceProfile } from './device-directory.service';
import { PrismaService } from '../../persistence/prisma/prisma.service';
import { chooseRecovery } from './recovery-policy';
import { PerformanceRegistryService } from './performance-registry.service';
import { Injectable, Optional } from '@nestjs/common';
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

@Injectable()
export class DeviceDispatchService {
  constructor(
    @Optional() private readonly performanceRegistry?: PerformanceRegistryService,
    @Optional() private readonly macroScheduler?: MacroSchedulerService,
    @Optional() private readonly directory?: DeviceDirectoryService,
    @Optional() private readonly prisma?: PrismaService,
    @Optional() sharedCostStore?:RuntimeCostStore
  ) { this.costStore=sharedCostStore??RuntimeCostStore.shared(this.prisma); }
  private readonly costStore:RuntimeCostStore;
  private readonly qualityEvaluator = new CropQualityEvaluator(this.prisma);
  private readonly profiles = new Map<string,{networkId:string;executorVersion:string}>();
  private readonly planner=new WorkflowPlacementPlanner();
  private readonly circuits=new Map<string,{failures:number;retryAt:number}>();
  private readonly decisions:unknown[]=[];
  async onModuleInit():Promise<void> { await this.costStore.load(); }
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
  private key(deviceId:string,bytes:number,parameters:unknown,capability='image.crop.v1'):string {
    const match=deviceId.match(/:(transfer|download)$/);
    const id=match?deviceId.slice(0,-match[0].length):deviceId;
    const profile=this.profiles.get(id);
    return costKey(capability,id,bytes,parameters,match?(match[1]==='transfer'?'upload':'download'):'execution',
      profile?.executorVersion??'1',profile?.networkId??'unknown',IMAGE_CROP_CONTRACT.costModel);
  }
  private observe(key:string,ms:number,success:boolean,bytes?:number,source:SampleSource='BUSINESS',errorClass?:string):void {
    this.costStore.record(key,ms,success,bytes,source,errorClass);
  }
  private async rolloutEvidence(rollout:PlacementRollout,capability:string,deviceId:string,candidate?:DeviceCandidate,trialKey='',calibrating=false,canaryEligible=false):Promise<PlacementRollout> {
    const evidence=await this.costStore.evidence(capability,deviceId,
      candidate?.costScope==='coordinator-roundtrip'?'roundtrip':'execution',candidate?.executorVersion??this.profiles.get(deviceId)?.executorVersion??'1',
      candidate?.networkId??'unknown');
    const quality=capability==='image.crop.v1'&&await this.qualityEvaluator.approved(deviceId,candidate?.executorVersion??this.profiles.get(deviceId)?.executorVersion??'1');
    return {...admissionEvidence(rollout,evidence,trialKey,calibrating,canaryEligible),qualityPassed:capability==='image.crop.v1'&&process.env.CROP_QUALITY_POLICY_JSON?quality:rollout.qualityPassed===true};
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
    const localSample=await this.costStore.get(this.key('cloud-runtime',bytes.length,parameters));
    if(!localSample||localSample.count<3) { RuntimeWorkScope.recordPlacement({actualDeviceId:'cloud-runtime',reason:'BASELINE_COST_CALIBRATION',mode:config.mode}); return baseline(); }
    const candidates:PlacementCandidate[]=[{deviceId:'cloud-runtime',executorId:'zeabur-shopping-workflow',capability:'image.crop.v1',trusted:true,source:'REAL',observedAt:now,ttlMs:3000,
      availableSlots:1,availableMemoryBytes:256*1024*1024,quality:1,computeMs:localSample?.mean??60000,queueMs:0,coldMs:0,uncertaintyMs:localSample?2*localSample.deviation:0,publishMs:0}];
    const links:Parameters<WorkflowPlacementPlanner['plan']>[0]['links']=[];
    for(const device of devices){
      const circuit=this.circuits.get(device.deviceId);
      if(circuit&&circuit.failures>=3&&now<circuit.retryAt)continue;
      try {
        const descriptor=await this.call<Descriptor>(device,ownerId,'descriptor',null,AbortSignal.any([signal,AbortSignal.timeout(1500)]));
        this.circuits.delete(device.deviceId);
        if(descriptor.protocolVersion!==1||descriptor.deviceId!==device.deviceId||descriptor.adapterVersion!=='1'||!descriptor.capabilities.includes('image.crop.v1'))continue;
        this.profiles.set(device.deviceId,{networkId:networkIdentity(descriptor.profile?.networkId),executorVersion:descriptor.profile?.executorVersion??descriptor.adapterVersion});
        const sample=await this.costStore.get(this.key(device.deviceId,bytes.length,parameters));
        candidates.push({deviceId:device.deviceId,executorId:'cpu-worker',capability:'image.crop.v1',trusted:true,source:'REAL',observedAt:now,ttlMs:3000,
          availableSlots:descriptor.capacity.slots,availableMemoryBytes:descriptor.capacity.memoryBytes,quality:(process.env.CROP_QUALITY_POLICY_JSON?await this.qualityEvaluator.approved(device.deviceId,this.profiles.get(device.deviceId)!.executorVersion):device.qualityVerified)?1:null,
          computeMs:sample?.mean??device.cropPriorMs,queueMs:0,coldMs:0,uncertaintyMs:sample?sample.deviation*2:device.cropPriorMs,publishMs:0});
        links.push(...await this.measuredLinks({capability:'image.crop.v1',tasks:[],inputs:[]},[device.deviceId]));
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
    const remote=decision.suggestion?.find(a=>a.deviceId!=='cloud-runtime');
    const admission=remote?await this.rolloutEvidence(gated,'image.crop.v1',remote.deviceId,undefined,randomUUID(),false,true):gated;
    const actual=authorizePlacement(decision,admission,'image.crop.v1',now)?.[0];
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
  async calibrate(deviceId:string,ownerId:string,bytes:Buffer,parameters:Parameters<DeviceDispatchService['crop']>[1],signal:AbortSignal,expectedExecutorVersion?:string):Promise<QueryImageCropResult>{
    const device=(await this.devices()).find(d=>d.deviceId===deviceId);if(!device)throw new Error('DEVICE_NOT_REGISTERED');
    await this.costStore.consumeCalibration(ownerId,deviceId);
    const descriptor=await this.call<Descriptor>(device,ownerId,'descriptor',null,signal);
    if(descriptor.deviceId!==deviceId||descriptor.protocolVersion!==1||!descriptor.capabilities.includes('image.crop.v1'))throw new Error('DEVICE_DESCRIPTOR_INVALID');
    this.profiles.set(deviceId,{networkId:networkIdentity(descriptor.profile?.networkId),executorVersion:descriptor.profile?.executorVersion??descriptor.adapterVersion});
    if(expectedExecutorVersion&&this.profiles.get(deviceId)!.executorVersion!==expectedExecutorVersion)throw new Error('CALIBRATION_EXECUTOR_VERSION_MISMATCH');
    return this.executeCrop(device,ownerId,bytes,parameters,signal);
  }
  private async executeCrop(device:DeviceConfiguration,ownerId:string,bytes:Buffer,parameters:Parameters<DeviceDispatchService['crop']>[1],signal:AbortSignal,macroContext:SchedulingDecision['macroContext']={baselineDevice:'cloud-runtime',selectedReason:'EXPLICIT_CALIBRATION',urgency:false,budgetMs:RuntimeWorkScope.remainingBudget(60000)}):Promise<QueryImageCropResult>{
    const source:SampleSource=macroContext.selectedReason==='EXPLICIT_CALIBRATION'?'CALIBRATION':'BUSINESS';
    const uploadKey=this.key(device.deviceId+':transfer',bytes.length,parameters);
    const downloadKey=this.key(device.deviceId+':download',bytes.length,parameters);
    const executionKey=this.key(device.deviceId,bytes.length,parameters);
    const budget=RuntimeWorkScope.remainingBudget(60000),began=performance.now();let lease:Receipt|undefined,settled=false;
    try {
      const start=performance.now(),input=await this.call<ArtifactRef>(device,ownerId,'artifacts',bytes,signal,true);
      if(input.contentHash!==createHash('sha256').update(bytes).digest('hex'))throw new Error('INPUT_HASH_MISMATCH');
      this.observe(uploadKey,performance.now()-start,true,bytes.length,source);
      lease=await this.call<Receipt>(device,ownerId,'leases',{attemptId:'attempt_'+randomUUID(),memoryBytes:128*1024*1024,remainingBudgetMs:Math.max(0,budget-(performance.now()-began))},signal);
      await this.call(device,ownerId,'execute',{leaseId:lease.leaseId,fencingToken:lease.fencingToken,capability:'image.crop.v1',input,parameters,privacy:'AUTHORIZED_REMOTE',networkAllowed:true,macroContext:{...macroContext,budgetMs:Math.max(0,Math.min(macroContext.budgetMs,budget)-(performance.now()-began))}},signal);
      while(performance.now()-began<budget){
        if (!(await this.devices()).some(d=>d.deviceId===device.deviceId&&d.endpoint===device.endpoint&&d.tokenEnv===device.tokenEnv)) throw new Error('DEVICE_REVOKED');
        const receipt=await this.call<Receipt>(device,ownerId,'query',{leaseId:lease.leaseId},signal);
        if(receipt.settled){settled=true;if(receipt.errorCode||receipt.stopRequested||!receipt.output)throw new Error(receipt.errorCode??'WORKER_STOPPED');
          const downloadAt=performance.now(),output=await this.call<Buffer>(device,ownerId,'artifacts/resolve',receipt.output.artifact,signal);
          if(createHash('sha256').update(output).digest('hex')!==receipt.output.artifact.contentHash||receipt.output.inputHash!==input.contentHash)throw new Error('OUTPUT_HASH_MISMATCH');
          // Size-specific sample, never a simulated latency label.
          this.observe(downloadKey,performance.now()-downloadAt,true,output.length,source);
          if(Number.isFinite(receipt.executionMs))this.observe(executionKey,receipt.executionMs!,true,undefined,source);
          return {buffer:output,metadata:receipt.output.metadata,cropRegionPx:receipt.output.cropRegionPx,strategy:receipt.output.strategy};}
        await new Promise(resolve=>setTimeout(resolve,20));signal.throwIfAborted();
      }throw new Error('WORKER_STOP_UNCONFIRMED');
    }catch(error){this.observe(executionKey,performance.now()-began,false,undefined,source,(error as Error).message);throw error;}
    finally {
      if(lease){const cleanup=AbortSignal.timeout(3000);try{if(!settled)await this.call(device,ownerId,'cancel',{leaseId:lease.leaseId},cleanup);
        else await this.call(device,ownerId,'release',{leaseId:lease.leaseId},cleanup);}catch{/* Keep unconfirmed reservations at the target; never claim they were released. */}}
      await this.costStore.flush();
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
        const sample = await this.costStore.get(this.taskSampleKey(task.capability,candidate.deviceId,inputs,task.parameters,candidate,task.contract?.costModel));
        if (sample?.count) {
          candidate.taskHistory[task.id] = {quality:candidate.contractQuality??candidate.history?.quality??null,meanMs:sample.mean,
            stddevMs:Math.max(2*sample.deviation,sample.mean*0.15),sampleCount:sample.count};
        }
      }
    }
    if (context.calibrationDeviceId) {
      if (selectionPolicy() !== 'BACKGROUND_CALIBRATION' || context.userWaiting ||
          graph.tasks.length !== 1 || graph.tasks[0].capability !== 'image.crop.v1' ||
          !context.networkAllowed || context.privacyLevel !== 'AUTHORIZED_REMOTE' || options.remoteAllowed === false) {
        throw new Error('CALIBRATION_SCOPE_INVALID');
      }
    }
    const links = context.links ?? await this.measuredLinks(graph, [...candidates.keys()]);
    const decision = await this.macroScheduler.schedule({...graph, tasks:ordered}, [...candidates.values()],
      {...context,links,budgetMs:remaining(),materializeOutputsAt:'cloud-runtime'});
    let assignments = decision.assignments;
    let actualMode = decision.mode, actualReason = decision.reason;
    if (assignments?.some(a=>a.deviceId !== 'cloud-runtime')) {
      const rollout: PlacementRollout = JSON.parse(process.env.PLACEMENT_POLICY_JSON ?? '{}');
      // Check remote permission independently of fallback: baseline and suggestion may be the same array.
      const plan = {status:'ready' as const,baseline:null,suggestion:assignments,
        baselineMs:decision.baseline.estimatedMs,suggestionMs:decision.estimatedMs,rejections:[],truncated:0,planningMs:decision.planningMs,reason:decision.reason};
      const calibrating = decision.reason === 'BACKGROUND_CALIBRATION' && !!context.calibrationDeviceId;
      // Calibration establishes speed evidence; it must not require an existing speed advantage.
      // All quality, allowlist, expiry, failure-rate and kill-switch checks remain authoritative.
      let authorized=true;
      for (const assignment of assignments.filter(a=>a.deviceId!=='cloud-runtime')) {
        const task=ordered.find(t=>t.id===assignment.nodeId)!;
        let admission=await this.rolloutEvidence(rollout,task.capability,assignment.deviceId,candidates.get(assignment.deviceId),graph.workflowId+':'+assignment.deviceId,calibrating,task.contract?.sideEffectPolicy==='PURE');
        if(calibrating)admission={...admission,sampleCount:rollout.minimumSamples,nonInferiorityPassed:true};
        // Check each assigned device's own capability/scope evidence, never a global count.
        const single={...plan,suggestion:[assignment]};
        if(authorizePlacement(single,admission,task.capability,Date.now())!==single.suggestion)authorized=false;
      }
      if (!authorized) {
        if (calibrating) throw new Error('CALIBRATION_NOT_AUTHORIZED');
        if (!decision.baselineAssignments.length || decision.baselineAssignments.some(a=>a.deviceId!=='cloud-runtime')) {
          throw new Error('NO_AUTHORIZED_PLAN');
        }
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
    if (context.calibrationDeviceId) {
      await this.costStore.consumeCalibration(RuntimeWorkScope.ownerId()??'',context.calibrationDeviceId);
    }
    const artifacts = new Map(graph.inputs.map(input => [input.artifactId, input]));
    const outputs: Record<string, any> = Object.create(null);
    for (const task of ordered) {
      const assignment = assignments.find(a => a.nodeId === task.id)!;
      const inputIds = task.inputs.length ? task.inputs : ordered.length === 1 ? graph.inputs.map(input => input.artifactId) : [];
      const inputs = inputIds.map(id => {
        const ref = artifacts.get(id);
        if (!ref) throw new Error('TASK_INPUT_UNAVAILABLE');
        if(ref.data!==undefined&&createHash('sha256').update(ref.data).digest('hex')!==ref.contentHash)throw new Error('INPUT_HASH_MISMATCH');
        return ref;
      });
      const budgetMs = remaining();
      if(task.contract && inputs.some(input=>!task.contract!.inputSchemas.includes(input.schemaId)))throw new Error('TASK_CONTRACT_MISMATCH');
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
          this.observe(this.taskSampleKey(task.capability,assignment.deviceId,inputs,task.parameters,undefined,task.contract?.costModel),performance.now()-began,true);
        }
      } catch (error) {
        if(!options.remoteExecutors?.some(a=>a.candidate.deviceId===assignment.deviceId)) this.observe(this.taskSampleKey(task.capability,assignment.deviceId,inputs,task.parameters,candidates.get(assignment.deviceId),task.contract?.costModel),performance.now()-began,false,undefined,context.calibrationDeviceId?'CALIBRATION':'BUSINESS',(error as Error).message);
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
          {...context,links,budgetMs:remaining()},options);
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
    return this.dispatch({workflowId:context.runId,capability,inputs:[],tasks:[{id:context.task.taskId,capability,dependencies:[],inputs:[],
      outputBytes:0,memoryMB:0,minQuality:context.task.constraints?.minimumQuality ?? 0}]},
      {budgetMs,...semantic,networkAllowed:false,privacyLevel:'LOCAL_ONLY'},
      {remoteAllowed:false,cloudExecutors:{[capability]:async()=>execute()}});
  }

  private async measuredLinks(_graph:TaskGraph,deviceIds:string[]):Promise<PlacementLink[]> {
    const links:PlacementLink[]=[];
    for(const deviceId of deviceIds.filter(id=>id!=='cloud-runtime'))for(const scope of ['upload','download'] as const){
      const model=this.costStore.link(deviceId,scope,this.profiles.get(deviceId)?.networkId??'unknown');
      if(model)links.push({from:scope==='upload'?'cloud-runtime':deviceId,to:scope==='upload'?deviceId:'cloud-runtime',
        ...model,effective:false,source:'REAL'});
    }
    return links;
  }

  private taskSampleKey(capability:string,deviceId:string,inputs:TaskGraph['inputs'],parameters:unknown,candidate?:DeviceCandidate,model?:CapabilityCostModel):string {
    const bytes = inputs.reduce((sum,input)=>sum+(input.data?.byteLength ?? input.sizeBytes ?? 0),0);
    return costKey(capability,deviceId,bytes,parameters,candidate?.costScope==='coordinator-roundtrip'?'roundtrip':'execution',
      candidate?.executorVersion??this.profiles.get(deviceId)?.executorVersion??'1',candidate?.networkId??'unknown',model);
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
      contractQuality:1,
      history: { quality: 1, meanMs: 1000, stddevMs: 200, sampleCount: 0 }
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

        const executorVersion=descriptor.profile?.executorVersion??descriptor.adapterVersion;
        const networkId=networkIdentity(descriptor.profile?.networkId);
        this.profiles.set(device.deviceId,{executorVersion,networkId});
        const quality=(capability==='image.crop.v1'&&process.env.CROP_QUALITY_POLICY_JSON?await this.qualityEvaluator.approved(device.deviceId,executorVersion):device.qualityVerified)?1:null;

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
            availableMemoryMB: Math.min(descriptor.capacity.memoryBytes / (1024 * 1024),descriptor.profile?.availableMemoryMB??Infinity),
            queueLength: descriptor.profile?.queueLength ?? 0
          },
          executorVersion,networkId,contractQuality:quality,
          history:{quality,meanMs:device.cropPriorMs,stddevMs:device.cropPriorMs,sampleCount:0}
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
    const sourceBytes=source.data?.byteLength??source.sizeBytes??0;
    const uploadKey=this.key(deviceId+':transfer',sourceBytes,task.parameters??{},task.capability);
    const downloadKey=this.key(deviceId+':download',sourceBytes,task.parameters??{},task.capability);
    const executionKey=this.taskSampleKey(task.capability,deviceId,graph.inputs,task.parameters,undefined,task.contract?.costModel);
    const sourceKind:SampleSource=macroContext.selectedReason==='BACKGROUND_CALIBRATION'?'CALIBRATION':'BUSINESS';
    const began = performance.now();
    let lease: Receipt | undefined;
    let settled = false;
    try {
      signal.throwIfAborted();
      let input: ArtifactRef = source;
      if (source.data !== undefined) {
        const bytes = Buffer.from(source.data);
        if (createHash('sha256').update(bytes).digest('hex') !== source.contentHash) throw new Error('INPUT_HASH_MISMATCH');
        const uploadAt = performance.now();
        input = await this.call<ArtifactRef>(device, ownerId, 'artifacts', bytes, signal, true, source.schemaId);
        if (input.contentHash !== source.contentHash) throw new Error('INPUT_HASH_MISMATCH');
        this.observe(uploadKey,performance.now()-uploadAt,true,bytes.length,sourceKind);
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
          if (!receipt.output.artifact) {
            if(Number.isFinite(receipt.executionMs))this.observe(executionKey,receipt.executionMs!,true,undefined,sourceKind);
            return receipt.output;
          }
          const downloadAt = performance.now();
          const buffer = await this.call<Buffer>(device, ownerId, 'artifacts/resolve', receipt.output.artifact, signal);
          if (createHash('sha256').update(buffer).digest('hex') !== receipt.output.artifact.contentHash) throw new Error('OUTPUT_HASH_MISMATCH');
          this.observe(downloadKey,performance.now()-downloadAt,true,buffer.length,sourceKind);
          // Network costs are modeled separately; do not train compute with end-to-end latency.
          if (Number.isFinite(receipt.executionMs)) this.observe(executionKey,receipt.executionMs!,true,undefined,sourceKind);
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

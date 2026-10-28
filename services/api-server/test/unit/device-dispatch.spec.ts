import { createHash } from 'node:crypto';
import { RuntimeCostStore } from '../../src/core/runtime/runtime-cost-store';
import { TaskGraph, MacroSchedulerService } from '../../src/core/runtime/macro-scheduler.service';
import { DeviceDispatchService } from '../../src/core/runtime/device-dispatch.service';
import { RuntimeWorkScope } from '../../src/core/runtime/runtime-work-scope';

describe('device dispatch baseline calibration', () => {
  it('collects actual baseline costs without contacting a worker when no baseline sample exists', async () => {
    const previous = process.env.RUNTIME_DEVICES_JSON;
    process.env.RUNTIME_DEVICES_JSON = JSON.stringify([{deviceId:'pc',endpoint:'http://127.0.0.1:1',tokenEnv:'UNSET_TEST_WORKER_TOKEN',enabled:true,qualityVerified:true,cropPriorMs:1}]);
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('MUST_NOT_CONTACT_WORKER'));
    try {
      const service = new DeviceDispatchService();
      const result = {buffer:Buffer.from('actual-baseline'),metadata:{width:1,height:1,format:'jpeg'},cropRegionPx:{left:0,top:0,width:1,height:1},strategy:'test'};
      const local = jest.fn().mockResolvedValue(result);
      const measurements = {storageReadMs:0,storageWriteMs:0,modelMs:0};
      const actual = await RuntimeWorkScope.run(new AbortController().signal, measurements, () => service.crop(Buffer.from('input'),
        {box:{x:0,y:0,width:1,height:1},paddingRatio:0,targetSize:512,jpegQuality:90},local), 'owner', 5000);
      expect(actual).toBe(result);
      expect(local).toHaveBeenCalledTimes(1);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(measurements).toMatchObject({placementDecisions:[{reason:'BASELINE_COST_CALIBRATION',actualDeviceId:'cloud-runtime'}]});
    } finally {
      fetchSpy.mockRestore();
      if(previous === undefined) delete process.env.RUNTIME_DEVICES_JSON; else process.env.RUNTIME_DEVICES_JSON = previous;
    }
  });
});

describe('macro Worker dispatch', () => {
  const macroContext = {baselineDevice:'cloud-runtime',selectedReason:'TEST',urgency:true,budgetMs:1000};
  const context = {budgetMs:1000,networkAllowed:true,privacyLevel:'AUTHORIZED_REMOTE' as const,userWaiting:true,importance:1};
  const bytes = Buffer.from('input');
  const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
  const input = {artifactId:'input',contentVersion:1,contentHash:hash(bytes),schemaId:'shopping.image',schemaVersion:1};
  const outputBytes = Buffer.from('output');
  const output = {artifact:{...input,artifactId:'output',contentHash:hash(outputBytes)},inputHash:input.contentHash,metadata:{width:1,height:1}};
  const graph: TaskGraph = {capability:'image.crop.v1',inputs:[{...input,data:bytes}],tasks:[{
    id:'crop',capability:'image.crop.v1',dependencies:[],inputs:['input'],outputBytes:10,memoryMB:128,minQuality:1,
    parameters:{targetSize:48}
  }]};
  let service: DeviceDispatchService, call: jest.SpyInstance, previous: string | undefined, previousPolicy: string | undefined;
  beforeEach(() => {
    previous = process.env.RUNTIME_DEVICES_JSON;
    previousPolicy = process.env.PLACEMENT_POLICY_JSON;
    process.env.PLACEMENT_POLICY_JSON = JSON.stringify({mode:'ACTIVE',policyVersion:'test',expiresAt:Date.now()+60000,killSwitch:false,
      allowedDevices:['pc','cloud-runtime'],allowedCapabilities:['image.crop.v1'],sampleCount:30,minimumSamples:30,
      qualityPassed:true,nonInferiorityPassed:true,failureRate:0,maximumFailureRate:0.05,cohortAllowed:true});
    process.env.RUNTIME_DEVICES_JSON = JSON.stringify([{deviceId:'pc',endpoint:'http://127.0.0.1:1',tokenEnv:'TEST_TOKEN',enabled:true,qualityVerified:true,cropPriorMs:1}]);
    service = new DeviceDispatchService(undefined, {schedule:jest.fn().mockResolvedValue({deviceId:'pc',macroContext,mode:'OPTIMIZED',reason:'TEST',estimatedMs:10,baseline:{estimatedMs:100},assignments:[{nodeId:'crop',deviceId:'pc',executorId:'cpu-worker'}],baselineAssignments:[{nodeId:'crop',deviceId:'cloud-runtime',executorId:'cloud'}]})} as unknown as MacroSchedulerService);
    for(let i=0;i<30;i++) (service as any).observe((service as any).taskSampleKey('image.crop.v1','pc',graph.inputs,graph.tasks[0].parameters),1,true);
    jest.spyOn(service as any,'queryCandidates').mockResolvedValue([]);
    call = jest.spyOn(service as any,'call').mockImplementation(async (...args: any[]) => {
      switch(args[2]) {
        case 'artifacts': return input;
        case 'leases': return {leaseId:'lease',fencingToken:7};
        case 'query': return {settled:true,output,executionMs:1};
        case 'artifacts/resolve': return outputBytes;
        default: return {};
      }
    });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if(previousPolicy===undefined)delete process.env.PLACEMENT_POLICY_JSON;else process.env.PLACEMENT_POLICY_JSON=previousPolicy;
    if(previous === undefined) delete process.env.RUNTIME_DEVICES_JSON; else process.env.RUNTIME_DEVICES_JSON=previous;
  });
  const run = (service: DeviceDispatchService, signal = new AbortController().signal, request = graph, options = context) =>
    RuntimeWorkScope.run(signal,{storageReadMs:0,storageWriteMs:0,modelMs:0},()=>service.dispatch(request,options,{cloudExecutors:{'image.crop.v1':async()=>({...output,buffer:outputBytes})}}),'owner',options.budgetMs);
  it('uploads data, forwards task parameters and macroContext, verifies output and releases lease',async()=>{
    const result = await run(service);
    expect(result.buffer).toEqual(outputBytes);
    expect(call.mock.calls.find(args=>args[2]==='execute')?.[3]).toEqual(expect.objectContaining({
      macroContext:expect.objectContaining({urgency:true,baselineDevice:'cloud-runtime',selectedReason:'TEST'}),parameters:{targetSize:48},input,leaseId:'lease',fencingToken:7
    }));
    expect(call.mock.calls.find(args=>args[2]==='leases')?.[3]).toEqual(expect.objectContaining({memoryBytes:128*1024*1024}));
    expect(call.mock.calls.at(-1)?.[2]).toBe('release');
  });
  it('ignores hand-written admission counts when no observations exist',async()=>{
    (service as any).costStore=new RuntimeCostStore();
    await run(service);
    expect(call).not.toHaveBeenCalled();
  });
  it('uses observed failures even when the configured failure rate is zero',async()=>{
    for(let i=0;i<3;i++)(service as any).observe((service as any).taskSampleKey('image.crop.v1','pc',graph.inputs,graph.tasks[0].parameters),25000,false);
    await run(service);
    expect(call).not.toHaveBeenCalled();
  });
  it('fills task timing without manufacturing quality approval',async()=>{
    const candidate={deviceId:'pc',capabilities:['image.crop.v1'],contractQuality:null};
    (service as any).queryCandidates.mockResolvedValue([candidate]);
    await run(service);
    expect((candidate as any).taskHistory.crop).toMatchObject({meanMs:1,sampleCount:30,quality:null});
  });
  it('feeds verified upload and download samples back to the generic link planner',async()=>{
    for(let i=0;i<3;i++)await run(service);
    const links=await (service as any).measuredLinks(graph,['cloud-runtime','pc']);
    expect(links).toHaveLength(2);
    expect(links.map((link:any)=>[link.from,link.to])).toEqual([['cloud-runtime','pc'],['pc','cloud-runtime']]);
    expect(links.every((link:any)=>Number.isFinite(link.bytesPerSecond)&&link.bytesPerSecond>0)).toBe(true);
  });
  it('keeps in-flight measurements on their captured network when another request updates the profile',async()=>{
    const original=call.getMockImplementation()!;
    call.mockImplementation(async(...args:any[])=>{
      if(args[2]==='artifacts')(service as any).profiles.set('pc',{networkId:'new-network',executorVersion:'1'});
      return original(...args);
    });
    for(let i=0;i<3;i++){
      (service as any).profiles.set('pc',{networkId:'old-network',executorVersion:'1'});
      await run(service);
    }
    expect((service as any).costStore.link('pc','upload','old-network')).toBeDefined();
    expect((service as any).costStore.link('pc','download','old-network')).toBeDefined();
    expect((service as any).costStore.link('pc','upload','new-network')).toBeUndefined();
  });
  it('calibration admits initial speed samples, caps attempts, and respects kill switch',async()=>{
    const previousSelection=process.env.SCHEDULING_SELECTION_POLICY;
    process.env.SCHEDULING_SELECTION_POLICY='BACKGROUND_CALIBRATION';
    const scheduler=(service as any).macroScheduler.schedule;
    const decision=await scheduler();
    scheduler.mockResolvedValue({...decision,reason:'BACKGROUND_CALIBRATION'});
    const policy=JSON.parse(process.env.PLACEMENT_POLICY_JSON!);
    process.env.PLACEMENT_POLICY_JSON=JSON.stringify({...policy,sampleCount:0,nonInferiorityPassed:false});
    try {
      const calibration={...context,userWaiting:false,calibrationDeviceId:'pc'};
      for(let i=0;i<5;i++)await run(service,undefined,graph,calibration);
      await expect(run(service,undefined,graph,calibration)).rejects.toThrow('CALIBRATION_QUOTA_EXHAUSTED');
      expect(call.mock.calls.filter(args=>args[2]==='execute')).toHaveLength(5);
      process.env.PLACEMENT_POLICY_JSON=JSON.stringify({...policy,killSwitch:true});
      await expect(run(service,undefined,graph,calibration)).rejects.toThrow('CALIBRATION_NOT_AUTHORIZED');
    } finally {
      if(previousSelection===undefined)delete process.env.SCHEDULING_SELECTION_POLICY;else process.env.SCHEDULING_SELECTION_POLICY=previousSelection;
    }
  });
  it('does not silently execute an unauthorized peer when no baseline exists',async()=>{
    const scheduler=(service as any).macroScheduler.schedule;
    scheduler.mockResolvedValue({...await scheduler(),baselineAssignments:[],baseline:{deviceId:null,estimatedMs:null}});
    process.env.PLACEMENT_POLICY_JSON='{}';
    await expect(run(service)).rejects.toThrow('NO_AUTHORIZED_PLAN');
    expect(call).not.toHaveBeenCalled();
  });
  it('does not mistake the same remote baseline array for rollout approval',async()=>{
    const scheduler=(service as any).macroScheduler.schedule;
    const decision=await scheduler();
    scheduler.mockResolvedValue({...decision,baselineAssignments:decision.assignments});
    process.env.PLACEMENT_POLICY_JSON='{}';
    await expect(run(service)).rejects.toThrow('NO_AUTHORIZED_PLAN');
    expect(call).not.toHaveBeenCalled();
  });
  it('dispatches through the real macro scheduler using verified cold-start candidates',async()=>{
    (service as any).queryCandidates.mockRestore();
    (service as any).macroScheduler = new MacroSchedulerService();
    const original = call.getMockImplementation()!;
    call.mockImplementation(async (...args:any[])=>args[2]==='descriptor'?{
      protocolVersion:1,deviceId:'pc',adapterVersion:'1',capabilities:['image.crop.v1'],capacity:{slots:1,memoryBytes:256*1024*1024}
    }:original(...args));
    const actual = await run(service,undefined,graph,{...context,budgetMs:5000,links:[{from:'cloud-runtime',to:'pc',bytesPerSecond:1e8,fixedMs:0,effective:true,source:'REAL',observedAt:Date.now(),ttlMs:10000},{from:'pc',to:'cloud-runtime',bytesPerSecond:1e8,fixedMs:0,effective:true,source:'REAL',observedAt:Date.now(),ttlMs:10000}]} as any);
    expect(actual.buffer).toEqual(outputBytes);
    const sent = call.mock.calls.find(args=>args[2]==='execute')?.[3] as any;
    expect(sent.macroContext).toMatchObject({baselineDevice:'cloud-runtime',urgency:true});
    expect(sent.macroContext.budgetMs).toBeGreaterThan(0);
  });
  it('propagates Worker errors and releases settled leases',async()=>{
    const original = call.getMockImplementation()!;
    call.mockImplementation(async (...args:any[])=>args[2]==='query'?{settled:true,errorCode:'CROP_INVALID'}:original(...args));
    await expect(run(service)).rejects.toThrow('CROP_INVALID');
    expect(call.mock.calls.at(-1)?.[2]).toBe('release');
  });
  it('cancels an unconfirmed lease when execute is rejected',async()=>{
    const original = call.getMockImplementation()!;
    call.mockImplementation(async (...args:any[])=>{if(args[2]==='execute')throw new Error('CAPACITY_FULL');return original(...args);});
    await expect(run(service)).rejects.toThrow('CAPACITY_FULL');
    expect(call.mock.calls.at(-1)?.[2]).toBe('cancel');
  });
  it('rejects corrupted outputs',async()=>{
    const original = call.getMockImplementation()!;
    call.mockImplementation(async (...args:any[])=>args[2]==='artifacts/resolve'?Buffer.from('corrupt'):original(...args));
    await expect(run(service)).rejects.toThrow('OUTPUT_HASH_MISMATCH');
  });
  it('honors cancellation while polling and cancels the lease',async()=>{
    const controller = new AbortController();
    const original = call.getMockImplementation()!;
    call.mockImplementation(async (...args:any[])=>{
      if(args[2]==='query'){controller.abort(new Error('CANCELLED'));return {settled:false};}
      return original(...args);
    });
    await expect(run(service,controller.signal)).rejects.toThrow('CANCELLED');
    expect(call.mock.calls.at(-1)?.[2]).toBe('cancel');
  });
  it('enforces network authorization before upload',async()=>{
    await expect(run(service,undefined,graph,{...context,networkAllowed:false})).rejects.toThrow('TRANSFER_NOT_AUTHORIZED');
    expect(call).not.toHaveBeenCalled();
  });
  it('rejects missing dependencies before execution',async()=>{
    await expect(run(service,undefined,{...graph,tasks:[...graph.tasks,{...graph.tasks[0],id:'next',dependencies:['missing']}]})).rejects.toThrow('TASK_GRAPH_DEPENDENCY_INVALID');
    expect(call).not.toHaveBeenCalled();
  });
});

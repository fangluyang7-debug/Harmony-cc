import { DeviceDispatchService } from '../../src/core/runtime/device-dispatch.service';
import { MacroSchedulerService, TaskGraph } from '../../src/core/runtime/macro-scheduler.service';
import { RuntimeWorkScope } from '../../src/core/runtime/runtime-work-scope';
import { createHash } from 'node:crypto';

const context = {budgetMs:5000,networkAllowed:true,privacyLevel:'AUTHORIZED_REMOTE' as const,userWaiting:false,importance:0};
const task = (id:string, capability:string, dependencies:string[]=[], inputs:string[]=[]) =>
  ({id,capability,dependencies,inputs,outputBytes:128,memoryMB:32,minQuality:1});
const assignment = (nodeId:string,deviceId:string,executionMs=10) =>
  ({nodeId,deviceId,executorId:deviceId,inputTransferMs:0,executionMs,uncertaintyMs:0});
const scope = <T>(work:()=>Promise<T>,signal=new AbortController().signal,budget=5000) =>
  RuntimeWorkScope.run(signal,{storageReadMs:0,storageWriteMs:0,modelMs:0},work,'owner',budget);

describe('full workflow placement and dispatch',()=>{
  let previousPolicy:string|undefined;
  beforeEach(()=>{
    previousPolicy=process.env.PLACEMENT_POLICY_JSON;
    process.env.PLACEMENT_POLICY_JSON=JSON.stringify({mode:'ACTIVE',policyVersion:'test',expiresAt:Date.now()+60000,killSwitch:false,
      allowedDevices:['cloud-runtime','worker-a','worker-b'],allowedCapabilities:['prepare','transform','finish'],
      sampleCount:30,minimumSamples:30,qualityPassed:true,nonInferiorityPassed:true,failureRate:0,maximumFailureRate:0.05,cohortAllowed:true});
  });
  afterEach(()=>{
    jest.restoreAllMocks();
    if(previousPolicy===undefined)delete process.env.PLACEMENT_POLICY_JSON;else process.env.PLACEMENT_POLICY_JSON=previousPolicy;
  });
  function fixture() {
    const graph:TaskGraph={capability:'unrelated.application',inputs:[{artifactId:'input',contentHash:createHash('sha256').update('seed').digest('hex'),schemaId:'shopping.image',schemaVersion:1,contentVersion:1,data:Buffer.from('seed')}],tasks:[
      task('a','prepare',[],['input']),task('b','transform',['a'],['a-output']),task('c','finish',['b'],['b-output'])]};
    const assignments=[assignment('a','worker-a'),assignment('b','worker-b'),assignment('c','cloud-runtime')];
    const macro={schedule:jest.fn().mockImplementation(async (remaining?:TaskGraph)=>({assignments:assignments.filter(a=>!remaining||remaining.tasks.some(t=>t.id===a.nodeId)),baselineAssignments:(remaining??graph).tasks.map(t=>assignment(t.id,'cloud-runtime')),
      deviceId:'worker-a',mode:'OPTIMIZED',reason:'TEST',estimatedMs:30,baseline:{estimatedMs:300},
      macroContext:{baselineDevice:'cloud-runtime',selectedReason:'TEST',urgency:false,budgetMs:5000}}))};
    const service=new DeviceDispatchService(undefined,macro as unknown as MacroSchedulerService);
    const query=jest.spyOn(service as any,'queryCandidates').mockResolvedValue([]);
    const cloud=jest.fn(async (request:any)=>({buffer:Buffer.from(request.inputs[0].data.toString()+'C')}));
    const remote=jest.spyOn(service as any,'executeOnWorker').mockImplementation(async (...args:any[])=>{
      const [device,subgraph]=args;
      return {buffer:Buffer.from(device==='worker-a'?'A':Buffer.from(subgraph.inputs[0].data).toString()+'B')};
    });
    const options={cloudExecutors:{prepare:cloud,transform:cloud,finish:cloud}};
    return {service,macro,graph,query,remote,cloud,options};
  }
  it('keeps total workflow savings and every node assignment',()=>{
    const baseline=[assignment('a','cloud-runtime',100),assignment('b','cloud-runtime',400)];
    const suggestion=[assignment('a','worker-a',120),assignment('b','worker-b',80)];
    const result=(new MacroSchedulerService() as any).applyGates({baseline,suggestion,baselineMs:500,suggestionMs:200},context);
    expect(result.mode).toBe('OPTIMIZED');
    expect(result.assignments).toEqual(suggestion);
    expect(result.estimatedMs).toBe(200);
    expect(result.reason).toBe('COST_REDUCTION_300ms');
    expect(()=> (new MacroSchedulerService() as any).applyGates({baseline,suggestion,baselineMs:null,suggestionMs:200},context)).toThrow('NO_BASELINE_PLAN');
  });
  it('executes different nodes on different devices and transfers predecessor output',async()=>{
    const f=fixture();
    // Input order is not execution order: dispatch must topologically sort it.
    f.graph.tasks.reverse();
    const result=await scope(()=>f.service.dispatch(f.graph,context,f.options));
    expect(result.output.buffer.toString()).toBe('ABC');
    expect(Object.keys(result.outputs)).toEqual(['a','b','c']);
    expect(f.remote.mock.calls.map(c=>c[0])).toEqual(['worker-a','worker-b']);
    const subgraph=f.remote.mock.calls[1][1] as TaskGraph;
    expect(subgraph.tasks[0].dependencies).toEqual([]);
    expect(subgraph.inputs[0].contentHash).toBe(createHash('sha256').update('A').digest('hex'));
    expect(f.query.mock.calls.map(c=>c[0])).toEqual(['prepare','transform','finish','transform','finish','finish']);
    expect(f.cloud).toHaveBeenCalledTimes(1);
    expect(f.cloud.mock.calls[0][0].macroContext.urgency).toBe(false);
  });
  it('does not refresh budget between stages',async()=>{
    const f=fixture();
    const original=f.remote.getMockImplementation()!;
    f.remote.mockImplementation(async (...args:any[])=>{
      if(args[0]==='worker-a')await new Promise(resolve=>setTimeout(resolve,30));
      return original(...args);
    });
    await scope(()=>f.service.dispatch(f.graph,context,f.options));
    const first=f.remote.mock.calls[0][2] as {budgetMs:number};
    const second=f.remote.mock.calls[1][2] as {budgetMs:number};
    expect(second.budgetMs).toBeLessThan(first.budgetMs-15);
  });
  it('stops downstream work after a failed node',async()=>{
    const f=fixture();f.remote.mockRejectedValueOnce(new Error('COMPUTE_FAILED'));
    await expect(scope(()=>f.service.dispatch(f.graph,context,f.options))).rejects.toThrow('COMPUTE_FAILED');
    expect(f.remote).toHaveBeenCalledTimes(1);expect(f.cloud).not.toHaveBeenCalled();
  });
  it('rejects cycles before descriptor requests or execution',async()=>{
    const f=fixture();f.graph.tasks[0].dependencies=['c'];
    await expect(scope(()=>f.service.dispatch(f.graph,context,f.options))).rejects.toThrow('TASK_GRAPH_DEPENDENCY_INVALID');
    expect(f.query).not.toHaveBeenCalled();expect(f.remote).not.toHaveBeenCalled();
  });
  it('waits for cloud settlement and never starts downstream after cancellation',async()=>{
    const f=fixture(),controller=new AbortController();
    f.macro.schedule.mockResolvedValue({...await f.macro.schedule(),assignments:f.graph.tasks.map(t=>assignment(t.id,'cloud-runtime'))});
    let finish!:()=>void;
    f.cloud.mockImplementationOnce(async()=>{await new Promise<void>(resolve=>{finish=resolve;});return {buffer:Buffer.from('A')};});
    let settled=false;
    const running=scope(()=>f.service.dispatch(f.graph,context,f.options),controller.signal).finally(()=>{settled=true;});
    const rejection=expect(running).rejects.toThrow('CANCELLED');
    while(!finish)await new Promise(resolve=>setImmediate(resolve));
    controller.abort(new Error('CANCELLED'));
    await new Promise(resolve=>setImmediate(resolve));expect(settled).toBe(false);
    finish();await rejection;expect(f.cloud).toHaveBeenCalledTimes(1);
  });
  it('executes cloud baselines through registered call-scoped capabilities',async()=>{
    const service=new DeviceDispatchService(undefined,new MacroSchedulerService());
    const execute=jest.fn(async()=>({answer:'cloud'}));
    const result=await scope(()=>service.dispatch({capability:'translate',inputs:[],tasks:[task('a','translate')]},context,
      {remoteAllowed:false,cloudExecutors:{translate:execute}}));
    expect(result).toEqual({answer:'cloud'});expect(execute).toHaveBeenCalledTimes(1);
  });
});

import { spawn, ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import sharp = require('sharp');
import { DeviceDispatchService } from '../../src/core/runtime/device-dispatch.service';
import { MacroSchedulerService, TaskGraph } from '../../src/core/runtime/macro-scheduler.service';
import { RuntimeWorkScope } from '../../src/core/runtime/runtime-work-scope';

it('runs a calibrated HTTP Worker DAG and returns its artifacts to a cloud capability',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'harmony-dispatch-test-'));
  const token=randomBytes(32).toString('hex');
  const names=['RUNTIME_DEVICES_JSON','DISPATCH_TEST_TOKEN','PLACEMENT_POLICY_JSON'] as const;
  const previous=names.map(name=>process.env[name]);
  let child:ChildProcess|undefined;
  try {
    child=spawn(process.execPath,[path.resolve(__dirname,'../../../device-worker/server.mjs')],{
      env:{...process.env,WORKER_TOKEN:token,WORKER_DEVICE_ID:'worker-test',WORKER_PORT:'0',WORKER_DATA_DIR:directory},
      stdio:['ignore','pipe','pipe'],windowsHide:true});
    const port=await new Promise<number>((resolve,reject)=>{
      let output='',errors='';
      const timer=setTimeout(()=>reject(new Error('WORKER_START_TIMEOUT '+errors)),10000);
      child!.stderr!.on('data',bytes=>{errors+=bytes;});
      child!.once('error',error=>{clearTimeout(timer);reject(error);});
      child!.once('exit',()=>{clearTimeout(timer);reject(new Error('WORKER_EXITED '+errors));});
      child!.stdout!.on('data',bytes=>{
        output+=bytes;
        if(output.includes('\n')){clearTimeout(timer);resolve(JSON.parse(output.split('\n')[0]).port);}
      });
    });
    process.env.DISPATCH_TEST_TOKEN=token;
    process.env.RUNTIME_DEVICES_JSON=JSON.stringify([{deviceId:'worker-test',endpoint:`http://127.0.0.1:${port}`,
      tokenEnv:'DISPATCH_TEST_TOKEN',enabled:true,qualityVerified:true,cropPriorMs:1}]);
    process.env.PLACEMENT_POLICY_JSON=JSON.stringify({mode:'ACTIVE',policyVersion:'http-test',expiresAt:Date.now()+60000,killSwitch:false,
      allowedDevices:['worker-test','cloud-runtime'],allowedCapabilities:['image.crop.v1','inspect'],sampleCount:30,minimumSamples:30,
      qualityPassed:true,nonInferiorityPassed:true,failureRate:0,maximumFailureRate:0.05,cohortAllowed:true});
    const service=new DeviceDispatchService(undefined,new MacroSchedulerService());
    const call=jest.spyOn(service as any,'call');
    const bytes=await sharp({create:{width:64,height:64,channels:3,background:{r:90,g:120,b:30}}}).png().toBuffer();
    const parameters={box:{x:0,y:0,width:1,height:1},paddingRatio:0,targetSize:48,jpegQuality:90};
    for(let i=0;i<3;i++)await service.calibrate('worker-test','owner',bytes,parameters,AbortSignal.timeout(5000));
    const input={artifactId:'image',contentHash:createHash('sha256').update(bytes).digest('hex'),contentVersion:1,
      schemaId:'shopping.image',schemaVersion:1,data:bytes,sizeBytes:bytes.length};
    const crop={id:'crop',capability:'image.crop.v1',dependencies:[],inputs:['image'],memoryMB:128,outputBytes:10000,minQuality:1,parameters};
    const graph:TaskGraph={capability:'image.processing.pipeline',inputs:[input],tasks:[crop,
      {...crop,id:'recrop',dependencies:['crop'],inputs:['crop-output']},
      {id:'inspect',capability:'inspect',dependencies:['recrop'],inputs:['recrop-output'],memoryMB:32,outputBytes:0,minQuality:1}]};
    // Only use measured calibration observations. Never invent network throughput for this test.
    const links=(service as any).measuredLinks({...graph,tasks:[crop]},['worker-test']);
    expect(links).toHaveLength(2);
    const cloudCrop=jest.fn(async()=>{throw new Error('EXPECTED_WORKER_PLACEMENT');});
    const inspect=jest.fn(async(request:any)=>{
      const metadata=await sharp(Buffer.from(request.inputs[0].data)).metadata();
      return {width:metadata.width,height:metadata.height};
    });
    const measurements={storageReadMs:0,storageWriteMs:0,modelMs:0,placementDecisions:[] as Record<string,unknown>[]};
    const result=await RuntimeWorkScope.run(new AbortController().signal,measurements,()=>service.dispatch(graph,
      {budgetMs:10000,networkAllowed:true,privacyLevel:'AUTHORIZED_REMOTE',userWaiting:true,importance:1,links},
      {cloudExecutors:{'image.crop.v1':cloudCrop,inspect}}),'owner',10000);
    expect(result.output).toEqual({width:48,height:48});
    expect(cloudCrop).not.toHaveBeenCalled();expect(inspect).toHaveBeenCalledTimes(1);
    expect(measurements.placementDecisions.map(d=>d.actualDeviceId)).toEqual(['worker-test','worker-test','cloud-runtime']);
    const executions=call.mock.calls.filter(args=>args[2]==='execute').map(args=>args[3] as any);
    expect(executions).toHaveLength(5);
    expect(executions.slice(0,3).every(request=>request.macroContext.urgency===false)).toBe(true);
    expect(executions.slice(3).every(request=>request.macroContext.urgency===true)).toBe(true);
    expect(result.outputs.crop.executionConfig.priority).toBe('CRITICAL');
    expect(executions[4].input.contentHash).toBe(result.outputs.crop.artifact.contentHash);
    const descriptor=await fetch(`http://127.0.0.1:${port}/v1/descriptor`,{headers:{Authorization:'Bearer '+token,'x-owner-id':'owner'}}).then(r=>r.json());
    expect((descriptor as any).capacity.slots).toBe(1);
  } finally {
    names.forEach((name,i)=>{if(previous[i]===undefined)delete process.env[name];else process.env[name]=previous[i];});
    if(child && child.exitCode===null && child.signalCode===null){
      const exited=new Promise<void>(resolve=>child!.once('exit',()=>resolve()));child.kill();await exited;
    }
    if(path.dirname(path.resolve(directory))===path.resolve(tmpdir())&&path.basename(directory).startsWith('harmony-dispatch-test-')) {
      await rm(directory,{recursive:true,force:true});
    }
    jest.restoreAllMocks();
  }
},30000);

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { runInNewContext } from 'node:vm';
import { RuntimeCostStore, costKey, costIdentity, networkIdentity } from '../../src/core/runtime/runtime-cost-store';
import { PhoneDispatchService } from '../../src/modules/runtime/phone-dispatch.service';
import { MacroSchedulerService } from '../../src/core/runtime/macro-scheduler.service';

describe('terminal measurement and network identity',()=>{
  afterEach(()=>jest.restoreAllMocks());
  const parameters={targetSize:64,jpegQuality:80};
  const input=Buffer.alloc(1000),output=Buffer.alloc(100);
  const url='https://store.example.test/input';
  function fixture(){
    const costs=new RuntimeCostStore(),phone=new PhoneDispatchService(undefined as any,undefined,costs);
    const network=networkIdentity('wifi');
    const record=(timing:any={version:1,executorVersion:'v2',executionMs:30,inputTransferMs:20,networkId:'wifi'})=>
      (phone as any).recordMeasured('terminal',input,parameters,'v2',network,url,100,{result:{buffer:output},timing},'BUSINESS');
    return {costs,phone,network,record};
  }
  it('accounts for the complete roundtrip without mixing computation and transfer',async()=>{
    const {costs,phone,network,record}=fixture();
    for(let i=0;i<3;i++)record();
    const execution=await costs.get((phone as any).phoneSampleKey('terminal',1000,parameters,'v2'));
    const route=(phone as any).transportRoute(url,network);
    const upload=costs.link('terminal','upload',route.networkId)!;
    const relay=costs.link('terminal','relay-return',route.networkId)!;
    expect(execution!.mean).toBe(30);
    expect(execution!.mean+1000/upload.bytesPerSecond*1000+upload.fixedMs+100/relay.bytesPerSecond*1000+relay.fixedMs).toBeCloseTo(100);
    expect(costs.link('terminal','download',route.networkId)).toBeUndefined();
    expect((await costs.evidence('image.crop.v1','terminal','execution','v2','other-network')).sampleCount).toBe(3);
    jest.spyOn(Date,'now').mockReturnValue(Date.now()+11*60000);
    expect((await costs.get((phone as any).phoneSampleKey('terminal',1000,parameters,'v2')))!.mean).toBe(30);
    expect(costs.link('terminal','upload',route.networkId)).toBeUndefined();
    expect((await costs.evidence('image.crop.v1','terminal','execution','v2')).sampleCount).toBe(3);
  });
  it('keeps execution but discards transport measurements after a mid-task network switch',async()=>{
    const {costs,phone,network,record}=fixture();
    for(let i=0;i<3;i++)record({version:1,executorVersion:'v2',executionMs:30,inputTransferMs:20,networkId:'cellular'});
    expect((await costs.evidence('image.crop.v1','terminal','execution','v2')).sampleCount).toBe(3);
    expect(costs.link('terminal','upload',(phone as any).transportRoute(url,network).networkId)).toBeUndefined();
  });
  it('does not reinterpret legacy, impossible or wrong-version timings as execution',async()=>{
    const {costs,record}=fixture();
    record(null);record({version:1,executorVersion:'old',executionMs:1,inputTransferMs:1});
    record({version:1,executorVersion:'v2',executionMs:80,inputTransferMs:80});
    expect((await costs.evidence('image.crop.v1','terminal','execution','v2')).sampleCount).toBe(0);
  });
  it('requires real transfer paths even when terminal computation is very fast',async()=>{
    const {costs,phone,network,record}=fixture();for(let i=0;i<3;i++)record();
    const route=(phone as any).transportRoute(url,network);
    const graph={capability:'generic.image',inputs:[{artifactId:'input',contentHash:'hash',contentVersion:1,schemaVersion:1,schemaId:'image.raster.v1',sizeBytes:1000,
      replicas:[{deviceId:'cloud-runtime',readMs:0},{deviceId:route.sourceId,readMs:0}]}],tasks:[{id:'task',capability:'generic.image',dependencies:[],inputs:['input'],outputBytes:100,memoryMB:1,minQuality:1}]};
    const candidate=(deviceId:string,meanMs:number)=>({deviceId,deviceType:'EDGE' as const,executorId:deviceId,capabilities:['generic.image'],trusted:true,
      observedAt:Date.now(),ttlMs:60000,resourceSnapshot:{availableSlots:1,availableMemoryMB:100,queueLength:0},history:{quality:1,meanMs,stddevMs:0,sampleCount:3}});
    const candidates=[candidate('cloud-runtime',500),candidate('terminal',30)];
    const context={budgetMs:5000,networkAllowed:true,privacyLevel:'AUTHORIZED_REMOTE' as const,userWaiting:true,importance:1,materializeOutputsAt:'cloud-runtime'};
    const scheduler=new MacroSchedulerService();
    expect((await scheduler.schedule(graph,candidates,context)).deviceId).toBe('cloud-runtime');
    const links=[{from:route.sourceId,to:'terminal',...costs.link('terminal','upload',route.networkId)!,effective:false,source:'REAL' as const},
      {from:'terminal',to:'cloud-runtime',...costs.link('terminal','relay-return',route.networkId)!,effective:false,source:'REAL' as const}];
    const selected=await scheduler.schedule(graph,candidates,{...context,links});
    expect(selected.deviceId).toBe('terminal');expect(selected.estimatedMs).toBeCloseTo(100);
  });
  it('parses versioned keys explicitly and rejects unknown key versions',()=>{
    expect(costIdentity(costKey('text','device',1,{})).capability).toBe('text');
    expect(()=>costIdentity('cost:v30:{}')).toThrow('COST_KEY_INVALID');
  });
  it('normalizes IPv4 hosts and IPv6 privacy addresses to stable network prefixes',()=>{
    const source=readFileSync(path.resolve(__dirname,'../../../../apps/harmony/scheduler/src/main/ets/network/NetworkPrefix.ets'),'utf8');
    const output=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
    const exports:any={};runInNewContext(output,{exports});
    const prefix=exports.networkPrefix as (address:string,length:number)=>string|undefined;
    expect(prefix('192.168.3.24',24)).toBe('192.168.3.0/24');
    expect(prefix('192.168.3.198',24)).toBe(prefix('192.168.3.24',24));
    expect(prefix('2001:db8:2:3::abc',64)).toBe(prefix('2001:db8:2:3:1234:5678:9abc:def0',128));
    expect(prefix('2001:db8:2:4::abc',64)).not.toBe(prefix('2001:db8:2:3::abc',64));
    expect(prefix('300.1.2.3',24)).toBeUndefined();expect(prefix('invalid',24)).toBeUndefined();
  });
});

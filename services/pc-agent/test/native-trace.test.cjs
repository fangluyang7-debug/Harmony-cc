const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const ts=require('typescript'),{validTraceSpanV2}=require('@harmony/scheduler-core');
function setup(){
 let tick=0,id=0;const exports={};
 const source=fs.readFileSync(path.resolve(__dirname,'../../../apps/harmony/scheduler/src/main/ets/v2/host/NativeTrace.ets'),'utf8');
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2021,module:ts.ModuleKind.CommonJS}}).outputText,{exports,require:name=>{
  if(name==='./NativePlatform')return {monotonic:()=>++tick,factory:{id:()=>`span${++id}`}};
  if(name==='../protocol/SchedulingProtocolV2')return {validTraceSpanV2};throw Error('UNEXPECTED_IMPORT');
 }});
 const offer=require('../../../contracts/scheduling/v2/fixtures/t2/valid/DispatchOffer.json');
 return new exports.NativeTrace(offer,'trace1',1,'instance1');
}
test('ArkTS trace preserves nested request scope and phase dependencies (transpiled, not native validation)',async()=>{
 const trace=setup();trace.add('ADMIT',0,1);
 await trace.segment('LOAD',()=>trace.transfer('READ',async()=>42));
 await trace.segment('EXECUTE',async()=>42);
 await trace.segment('PUBLISH',()=>trace.transfer('WRITE',async()=>42));
 assert.ok(trace.spans.every(validTraceSpanV2));
 const load=trace.spans.find(s=>s.phase==='LOAD'),execute=trace.spans.find(s=>s.phase==='EXECUTE');
 assert.equal(execute.dependsOn[0],load.spanId);
 const requests=trace.spans.filter(s=>s.transferId);assert.equal(requests.length,2);
 for(const s of requests){const parent=trace.spans.find(p=>p.spanId===s.parentSpanId);assert.ok(parent);assert.ok(s.startMono>=parent.startMono&&s.endMono<=parent.endMono);assert.equal(s.measurementScope,'FULL_TRANSFER');}
});
test('ArkTS failed request and containing LOAD preserve error and failure evidence',async()=>{
 const trace=setup(),error=Error('TRANSFER_HASH');
 await assert.rejects(trace.segment('LOAD',()=>trace.transfer('READ',async()=>{throw error;})),e=>e===error);
 assert.equal(trace.spans.length,2);assert.ok(trace.spans.every(s=>s.reasonCode==='PHASE_FAILED'));
 assert.equal(trace.spans[0].parentSpanId,trace.spans[1].spanId);
});

test('ArkTS and PC micro queues agree on observed resource and policy wait reasons',()=>{
 const core=require('@harmony/scheduler-core'),exports={};
 const source=fs.readFileSync(path.resolve(__dirname,'../../../apps/harmony/scheduler/src/main/ets/v2/core/MicroQueueV2.ets'),'utf8');
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2021,module:ts.ModuleKind.CommonJS}}).outputText,{exports,require:name=>{
  if(name==='../protocol/ResourcesV2'||name==='./LedgerV2')return core;throw Error('UNEXPECTED_IMPORT');
 }});
 const policy={shares:[.5,.3,.2],agingMs:100,maxConsecutive:2,yieldDeadlineMs:1000};
 const offer=structuredClone(require('../../../contracts/scheduling/v2/fixtures/t2/valid/DispatchOffer.json'));
 offer.task.priority='REMOTE_INTERACTIVE';offer.task.budget={remainingMs:10000,deadlineAt:10000};
 const observed=[new core.QueueHistory(),new exports.QueueHistory()];
 const record={attemptId:'occupant',resourcesSettled:false};
 const entries=[{record,offer,resources:offer.resources}];
 const pool=offer.resources[0].resourcePoolId,workflow=offer.task.workflowId;
 for(const history of observed){
  record.resourcesSettled=false;
  history.observe(1,'RESOURCE_CAPACITY',[pool],entries,workflow);
  history.observe(2,'RESOURCE_CAPACITY',[pool],entries,workflow);
  record.resourcesSettled=true;
  history.observe(4,'SELECTED',[],entries,workflow);
  assert.equal(history.samples.length,2);
  assert.equal(history.samples[1].settledAttempts[0],'occupant');
 }
 assert.equal(JSON.stringify(observed[0].samples),JSON.stringify(observed[1].samples));
 const nativeTrace=setup();nativeTrace.add('QUEUE',0,5,'OBSERVED_RESOURCE_CAPACITY',observed[1].samples);
 assert.ok(validTraceSpanV2(nativeTrace.spans[0]));assert.equal(nativeTrace.spans[0].queueSamples.length,2);
 const queues=[new core.MicroQueue(offer.target.deviceId,policy),new exports.MicroQueueV2(offer.target.deviceId,policy)];
 for(const q of queues){q.enqueue(offer,0);const second=structuredClone(offer);second.task.attemptId='second';q.enqueue(second,0);}
 for(const q of queues){
  const cpu=amount=>[{resourcePoolId:'cpu',amount}];
  const credits=q.capacityCredits([cpu(4),cpu(1)],cpu(4),cpu(2),true);
  assert.deepEqual(Array.from(credits,c=>c.slots),[2,2,2]);
  assert.deepEqual(Array.from(q.capacityCredits([cpu(1)],cpu(4),cpu(4),true),c=>c.slots),[0,0,0]);
 }
 for(const q of queues)q.noteWait('second','OWNER_ACTIVE');
 assert.equal(JSON.stringify(queues[0].queuedFacts(5,100,'SIMULATED')),JSON.stringify(queues[1].queuedFacts(5,100,'SIMULATED')));
 for(const [occupied,idle,selected]of [[offer.resources,true,null],[[],false,null],[[],true,offer.task.attemptId],[[],true,null]]){
  const results=queues.map(q=>JSON.stringify(q.waitingReasons(offer.resources,occupied,idle,selected)));
  assert.equal(results[0],results[1]);
 }
});

test('ArkTS and PC running profiles agree on unknown, measured elapsed, and a past successful settlement',()=>{
 const core=require('@harmony/scheduler-core'),exports={};
 const source=fs.readFileSync(path.resolve(__dirname,'../../../apps/harmony/scheduler/src/main/ets/v2/core/LedgerV2.ets'),'utf8');
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2021,module:ts.ModuleKind.CommonJS}}).outputText,{exports,require:()=>core});
 const offer=structuredClone(require('../../../contracts/scheduling/v2/fixtures/t2/valid/DispatchOffer.json'));
 const row={offer,resources:offer.resources,record:{attemptId:'first',state:'RUNNING',resourcesSettled:false},cancelRequested:false};
 const records=[new core.RunTimings(),new exports.RunTimings()].map(t=>{
  t.start('first',10);const first=t.sample([row],20,100,'REAL');
  t.finish({...row,record:{attemptId:'first',state:'SUCCEEDED',resourcesSettled:true}},40);
  const next={...row,record:{...row.record,attemptId:'next'}};t.start('next',60);
  const second=t.sample([next],70,150,'REAL');
  return JSON.parse(JSON.stringify([first,second]));
 });
 assert.deepEqual(records[0],records[1]);assert.equal(records[0][0][0].remaining.value,null);
 assert.equal(records[0][1][0].elapsed.value,10);assert.equal(records[0][1][0].remaining.value,20);
});

test('native host samples power signals and closes new admission until recovery (platform stand-in)',()=>{
 const exports={},batteryInfo={batterySOC:10,chargingStatus:0,batteryCapacityLevel:2,
  BatteryChargeState:{NONE:0,ENABLE:1,DISABLE:2,FULL:3},BatteryCapacityLevel:{LEVEL_LOW:2,LEVEL_WARNING:3,LEVEL_CRITICAL:4}};
 let level=2;
 const thermal={getLevel:()=>level,ThermalLevel:{COOL:0,OVERHEATED:4,ESCAPE:7}};
 const source=fs.readFileSync(path.resolve(__dirname,'../../../apps/harmony/scheduler/src/main/ets/v2/host/NativeAgent.ets'),'utf8');
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2021,module:ts.ModuleKind.CommonJS}}).outputText,{exports,require:name=>
  name==='@kit.BasicServicesKit'?{batteryInfo,thermal}:name==='../core/LedgerV2'?{occupiedV2:()=>[]}:{}});
 const host=Object.create(exports.NativeAgent.prototype);
 Object.assign(host,{powerSaving:'OFF',idle:()=>true,availableRam:2048,contribution:{maxCpuThreads:2,maxMemoryBytes:1024,reserveMemoryBytes:0},store:{read:()=>({state:{}})}});
 const check=(reason,slots)=>{host.sampleEnergy();assert.equal(host.energyGate,reason);assert.equal(host.limits()[0].amount,slots);};
 check('LOW_BATTERY',0);batteryInfo.chargingStatus=1;check(null,2);
 level=4;check('THERMAL_LIMIT',0);level=2;host.powerSaving='ON';check('POWER_SAVE',0);
 host.powerSaving='OFF';check(null,2);assert.equal(host.batteryPercent,10);
});

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

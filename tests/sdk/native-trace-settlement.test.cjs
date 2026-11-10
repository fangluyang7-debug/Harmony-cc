const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
function harness(failure){
 const source=fs.readFileSync(path.resolve(__dirname,'../../apps/harmony/scheduler/src/main/ets/v2/host/NativeAgent.ets'),'utf8');
 const start=source.indexOf(' private async execute('),end=source.indexOf(' private executorDigest(',start);assert.ok(start>0&&end>start);
 const js=require('esbuild').transformSync('class Host {'+source.slice(start,end)+'} module.exports=Host;',{loader:'ts',format:'cjs'}).code;
 const module={exports:{}},state={state:{entries:[],ledgerEpoch:1},journal:[]};let tick=0;
 class HostChange{constructor(apply){this.apply=apply;}}
 new Function('module','HostChange','monotonic','canonical','hash','http','startAttemptV2','settleAttemptV2',js)(module,HostChange,()=>++tick,JSON.stringify,()=> 'hash',{RequestMethod:{GET:'GET',PUT:'PUT'}},s=>s,(s,receipt)=>{s.entries.find(e=>e.record.attemptId===receipt.attemptId).record={...receipt,receipt};return s;});
 const host=new module.exports();Object.assign(host,{store:{read:()=>state,change:async c=>c.apply(state)},inputs:null,installation:{bootstrap:{domain:'SIMULATED'}},cancelled:()=>false,engine:async()=>({data:new Uint8Array([2]),schemaId:'catalog.ranked'}),timings:{start(){},finish(){}},report:(s,r)=>s.journal.push({type:'Receipt',attemptId:r.attemptId}),enqueue:(s,type,payload)=>s.journal.push({type,payload}),ackQuota:async()=>{if(failure==='quota')throw Error('ALLOTMENT_REJECTED');},flush:async()=>{if(failure==='socket')throw Error('SOCKET_CLOSED');},transport:{credential:'fixture',json:async()=>({ticket:{operation:'WRITE',bytes:1,ref:{contentHash:'hash',schemaId:'catalog.ranked',artifactId:'out',contentVersion:1}}}),request:async()=>new Uint8Array([1])}});
 function run(id){const offer={task:{attemptId:id,inputs:[{contentHash:'hash',artifactId:id,contentVersion:1}],contract:{capability:'catalog.filter.v1'},parameters:'{}',budget:{remainingMs:30000},coordinatorEpoch:1,planRevision:1},target:{},allowedConfigs:[{id:'standard'}],leaseMs:30000,transferPlan:[{}]};state.state.entries.push({record:{attemptId:id,ledgerEpoch:1,fence:{}},deadline:30000});const trace={spans:[],add(phase){this.spans.push({attemptId:id,phase});},transfer:async(_op,work)=>work()};return host.execute(offer,{operation:'READ',ref:offer.task.inputs[0],bytes:1},null,trace);}
 return {run,state};
}
for(const failure of ['quota','socket'])test('native completed receipt retains phase trace when '+failure+' acknowledgment fails (transpiled method)',async()=>{
 const {run,state}=harness(failure);await assert.rejects(run('one'),failure==='quota'?/ALLOTMENT_REJECTED/:/SOCKET_CLOSED/);
 assert.equal(state.state.entries[0].record.state,'SUCCEEDED');assert.equal(state.journal.filter(m=>m.type==='Receipt').length,1);const traces=state.journal.filter(m=>m.type==='TraceBatch');assert.equal(traces.length,1);assert.deepEqual(traces[0].payload.spans.map(s=>s.phase),['LOAD','EXECUTE','PUBLISH']);
});
test('concurrent native completions retain separate durable trace batches',async()=>{const {run,state}=harness(null);await Promise.all([run('one'),run('two')]);const batches=state.journal.filter(m=>m.type==='TraceBatch');assert.equal(batches.length,2);assert.deepEqual(new Set(batches.map(b=>b.payload.spans[0].attemptId)),new Set(['one','two']));});

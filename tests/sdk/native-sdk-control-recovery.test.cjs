const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{transformSync}=require('esbuild');
function load(){const m={exports:{}};new Function('module','exports',transformSync(fs.readFileSync('apps/harmony/scheduler/src/main/ets/v2/client/SchedulerSdk.ets','utf8'),{loader:'ts',format:'cjs'}).code)(m,m.exports);return m.exports;}
for(const recover of [true,false])test('SDK start control reconnect '+(recover?'recovers one existing plan':'expires without replanning'),async()=>{
 const {SchedulerSdk}=load();let now=0,plans=0,stages=0,starts=0;
 const ref={contentHash:'a'.repeat(64),bytes:1,schemaId:'image.raster',schemaVersion:1};
 const port={now:()=>now,wait:async ms=>{now+=ms;},digest:async()=>ref.contentHash,stageInput:async()=>{stages++;},request:async(route,body)=>{
  if(route==='/v2/sdk/jobs'){plans++;return JSON.stringify({jobId:'same-job',inputDelivery:'LOCAL',inputTicket:{ref,bytes:1,operation:'WRITE'}});}
  assert.equal(route,'/v2/sdk/jobs/same-job/start');assert.equal(body,'{}');starts++;
  if(!recover||now<1000)throw Error('SDK_COORDINATOR_OFFLINE');return '{}';
 }};
 const sdk=new SchedulerSdk(port),input=await sdk.registerInput(new Uint8Array([1]),ref.schemaId);
 const pending=sdk.submit({nodes:[{id:'analyze',input}],outputNodeId:'analyze'},{requestId:'same-job',budgetMs:180000,inputLocation:'ORIGIN'});
 if(recover)assert.equal((await pending).id,'same-job');else await assert.rejects(pending,/SDK_START_WAIT_TIMEOUT/);
 assert.equal(plans,1);assert.equal(stages,1);assert.ok(starts>1);assert.equal(now,recover?1000:15000);
});

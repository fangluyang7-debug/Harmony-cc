const {test}=require('node:test'),assert=require('node:assert/strict'),{createHash,randomUUID}=require('node:crypto');
const {SchedulerSdk}=require('../dist');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
test('local input avoids upload; only explicit pre-dispatch relay requirement permits upload and another start',async()=>{
 for(const failure of [null,'INPUT_NOT_UPLOADED','SDK_REQUEST_TIMEOUT']){
  const calls=[];let starts=0,input;
  const sdk=new SchedulerSdk({stageInput:async()=>calls.push('stage'),request:async(route)=>{
   if(route==='/v2/sdk/jobs')return JSON.stringify({jobId:'local',inputDelivery:'LOCAL',inputTicket:{operation:'WRITE',bytes:input.bytes,ref:{contentHash:input.contentHash}}});
   calls.push('start');if(starts++===0&&failure)throw Error(failure);return '{}';
  },write:async()=>calls.push('upload'),read:async()=>new Uint8Array(),digest:async bytes=>digest(bytes),now:Date.now,wait:async()=>{}});
  input=await sdk.registerInput(Buffer.from('local'),'text.input');
  const result=sdk.submit({nodes:[{input}]},{requestId:'local',inputLocation:'ORIGIN'});
  await result;
  assert.deepEqual(calls,failure==='INPUT_NOT_UPLOADED'?['stage','start','upload','start']:failure==='SDK_REQUEST_TIMEOUT'?['stage','start','start']:['stage','start']);
 }
});
test('missing input never reserves a server job; releasing input during planning preserves the in-flight snapshot',async()=>{
 const calls=[],id='input-lifetime';let sdk,input;
 const port={request:async(route)=>{
  calls.push(route);
  if(route==='/v2/sdk/jobs'){sdk.releaseInput(input);return JSON.stringify({jobId:id,inputTicket:{operation:'WRITE',ref:{contentHash:input.contentHash},bytes:input.bytes}});}
  return '{}';
 },write:async(_ticket,bytes)=>{assert.equal(Buffer.from(bytes).toString(),'hello');calls.push('write');},read:async()=>new Uint8Array(),digest:async bytes=>digest(bytes),now:Date.now,wait:async()=>{}};
 sdk=new SchedulerSdk(port);input=await sdk.registerInput(Buffer.from('hello'),'text.input');
 const workflow={nodes:[{input}]},options={requestId:id};
 sdk.releaseInput(input);
 await assert.rejects(sdk.submit(workflow,options),/SDK_INPUT_NOT_REGISTERED/);
 assert.deepEqual(calls,[]);
 input=await sdk.registerInput(Buffer.from('hello'),'text.input');
 await sdk.submit(workflow,options);
 assert.deepEqual(calls,['/v2/sdk/jobs','write','/v2/sdk/jobs/'+id+'/start']);
 await assert.rejects(sdk.submit(workflow,options),/SDK_INPUT_NOT_REGISTERED/);
 assert.equal(calls.length,3);
});
test('SDK plans before bytes, snapshots registered input, preserves one request ID, verifies output and invokes callback',async()=>{
 const calls=[],id=randomUUID(),output=Buffer.from('{"characters":5}');let sent;
 const port={request:async(route,body)=>{calls.push(route);if(route==='/v2/sdk/jobs'){const b=JSON.parse(body),input=b.workflow.nodes[0].input;assert.equal(b.options.requestId,id);return JSON.stringify({jobId:id,targetId:'target',deviceId:'device',reason:'PLAN',inputTicket:{operation:'WRITE',ref:{contentHash:input.contentHash},bytes:input.bytes}});}return JSON.stringify({jobId:id,state:'SUCCEEDED',outputTicket:{bytes:output.length,operation:'READ',ref:{contentHash:digest(output)}}});},write:async(_ticket,bytes)=>{calls.push('write');sent=bytes;},read:async()=>{calls.push('read');return output;},digest:async bytes=>digest(bytes),now:Date.now,wait:async()=>{}};
 const client=new SchedulerSdk(port),bytes=Buffer.from('hello'),input=await client.registerInput(bytes,'text.input');bytes.fill(0);
 const task=await client.submit({version:3,id,outputContract:'text.counts',qualityTarget:'reference',nodes:[{id:'compute',capability:'text.count.v1',input,parameters:'{}',dependsOn:[]}]},{requestId:id,budgetMs:30000,resultDestination:'ORIGIN'});
 assert.equal(Buffer.from(sent).toString(),'hello');assert.deepEqual(calls.slice(0,3),['/v2/sdk/jobs','write','/v2/sdk/jobs/'+id+'/start']);
 const result=await new Promise((resolve,reject)=>task.onResult(resolve,reject));assert.equal(result.jobId,id);assert.deepEqual(result.output,output);
 port.read=async()=>Buffer.from('wrong');await assert.rejects(task.result(),/SDK_OUTPUT_INTEGRITY/);
});
test('refused or ambiguous plans never send bytes, dispatch, or retry; timeout does not cancel a live job',async()=>{
 let requests=0,writes=0,time=0;
 const client=new SchedulerSdk({request:async()=>{requests++;throw Error('SDK_REQUEST_TIMEOUT');},write:async()=>{writes++;},read:async()=>new Uint8Array(),digest:async bytes=>digest(bytes),now:()=>time,wait:async ms=>{time+=ms;}});
 const input=await client.registerInput(Buffer.from('x'),'text.input');await assert.rejects(client.submit({nodes:[{input}]},{requestId:'ambiguous'}),/SDK_REQUEST_TIMEOUT/);assert.equal(requests,1);assert.equal(writes,0);
 const task=new SchedulerSdk({request:async route=>{assert.ok(!route.endsWith('/cancel'));return JSON.stringify({jobId:'live',state:'RUNNING',outputTicket:null});},write:async()=>{},read:async()=>new Uint8Array(),digest:async bytes=>digest(bytes),now:()=>time,wait:async ms=>{time+=ms;}}).resume('live');
 await assert.rejects(task.result(500),/SDK_RESULT_WAIT_TIMEOUT/);
});
test('TypeScript and ArkTS SDK submission sources stay identical',()=>{
 const fs=require('node:fs'),path=require('node:path'),root=path.resolve(__dirname,'../../..');
 const ts=fs.readFileSync(path.join(root,'packages/scheduler-client/src/index.ts'),'utf8'),ets=fs.readFileSync(path.join(root,'apps/harmony/scheduler/src/main/ets/v2/client/SchedulerSdk.ets'),'utf8');assert.equal(ts.replaceAll('\r\n','\n'),ets.replaceAll('\r\n','\n'));
});
test('closing a submitter during capacity wait stops metadata retries before any dispatch or transfer',async()=>{
 let requests=0,cancelled=false,time=0;
 const sdk=new SchedulerSdk({cancelled:()=>cancelled,request:async()=>{requests++;throw Error('NO_LEGAL_PLAN');},write:async()=>assert.fail('no upload'),read:async()=>assert.fail('no read'),digest:async bytes=>digest(bytes),now:()=>time,wait:async ms=>{time+=ms;cancelled=true;}});
 await assert.rejects(sdk.plan({id:'waiting'},{requestId:'waiting'}),/SDK_SUBMISSION_CANCELLED/);assert.equal(requests,1);
});
test('server compatibility gateways disable capacity wait so an HTTP caller owns bounded retries',async()=>{
 let calls=0;
 const sdk=new SchedulerSdk({request:async()=>{calls++;throw Error('NO_LEGAL_PLAN');},write:async()=>{},read:async()=>new Uint8Array(),digest:async bytes=>digest(bytes),now:()=>0,wait:async()=>assert.fail('gateway must not wait')},{capacityWaitMs:0});
 await assert.rejects(sdk.plan({id:'no-capacity'},{requestId:'no-capacity'}),/NO_LEGAL_PLAN/);assert.equal(calls,1);
});

test('known disconnected host rejects new planning without transport or automatic local replay',async()=>{
 const sdk=new SchedulerSdk({connected:()=>false,request:async()=>assert.fail('no metadata on disconnected host'),write:async()=>assert.fail('no upload'),read:async()=>assert.fail('no read'),digest:async bytes=>digest(bytes),now:Date.now,wait:async()=>assert.fail('no retry')});
 const input=await sdk.registerInput(Buffer.from('new business'),'text.input');
 await assert.rejects(sdk.submit({nodes:[{input}]},{requestId:'disconnected'}),/SDK_COORDINATOR_OFFLINE/);
});

test('start retries keep the same job, obey the wait bound, and preserve permanent refusals',async()=>{
 for(const code of ['ALLOTMENT_ACK_PENDING','START_BUSY','APP_CONTRACT_FORBIDDEN']){
  let now=0,starts=0;const sdk=new SchedulerSdk({now:()=>now,wait:async ms=>{now+=ms;},request:async route=>{assert.equal(route,'/v2/sdk/jobs/same/start');starts++;throw Error(code);}});
  await assert.rejects(sdk.startJob('same',500),new RegExp(code));
  assert.equal(starts,code==='APP_CONTRACT_FORBIDDEN'?1:3);assert.ok(now<=500);
 }
});

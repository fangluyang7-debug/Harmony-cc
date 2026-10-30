const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DurableLedger,grantSigningText}=require('../dist/durable-ledger'),{PcExecutionRuntime}=require('../dist/execution-runtime'),{DeviceScheduler}=require('../dist/device-scheduler');
const {TraceBuffer}=require('../dist/trace-buffer'),{ExecutionTrace}=require('../dist/execution-trace');
const {occupiedV2,validTraceSpanV2}=require('@harmony/scheduler-core');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
async function setup(){
 const directory=fs.mkdtempSync(path.resolve('../../.test/queue-runtime-')),{privateKey,publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
 const ledger=await DurableLedger.open(directory,{groupId:'g1',deviceId:'device1',holderInstanceId:'h1',appInstanceId:null},publicKey.export({type:'spki',format:'pem'}),()=>0);
 const grant=structuredClone(require('../../../contracts/scheduling/v2/fixtures/t2/valid/AllotmentGrant.json'));grant.leaseMs=30000;grant.signature=crypto.sign('sha256',Buffer.from(grantSigningText(grant)),privateKey).toString('base64');ledger.requestGrant(grant.leaseRequestId);ledger.installGrant(grant);
 const input=Buffer.from('{"dimension":2,"rows":[[3,4]]}'),offer=structuredClone(require('../../../contracts/scheduling/v2/fixtures/t2/valid/DispatchOffer.json'));
 // Real child-process tests exercise lifecycle, not the fixture's one-second performance budget.
 offer.leaseMs=15000;offer.task.budget={remainingMs:15000,deadlineAt:Date.now()+15000};offer.task.priority='REMOTE_INTERACTIVE';offer.task.contract.capability='vector.normalize.v1';offer.task.contract.outputSchemas=['vector.normalized'];offer.task.inputs[0].contentHash=hash(input);offer.task.parameters='{}';
 const ports={authorize:async()=>({coordinatorEpoch:1,online:true,ownerIdle:true,admissionLimit:grant.extra}),read:async()=>input,publish:async(bytes,schemaId)=>({artifactId:'out',contentVersion:1,contentHash:hash(bytes),schemaId,schemaVersion:1})};
 return {ledger,grant,input,offer,ports};
}
test('device queue holds capacity through owner yield and settlement, then admits the next real CPU job',async()=>{
 const x=await setup();let release,entered;const reading=new Promise(resolve=>{entered=resolve;});const gate=new Promise(resolve=>{release=resolve;});let count=0;
 const runtime=new PcExecutionRuntime(x.ledger,{...x.ports,read:async()=>{if(count++===0){entered();await gate;}return x.input;}}),notices=[];
 const scheduler=new DeviceScheduler(x.ledger,runtime,{shares:[.5,.3,.2],agingMs:100,maxConsecutive:2,yieldDeadlineMs:1000},n=>notices.push(n),()=>100);
 try{
  await scheduler.update(x.offer.resources,'IDLE');const first=scheduler.submit(x.offer,x.offer.allowedConfigs[0]);assert.equal(scheduler.submit(x.offer,x.offer.allowedConfigs[0]),first);await reading;
  const next=structuredClone(x.offer);next.task.attemptId='second';const second=scheduler.submit(next,next.allowedConfigs[0]);
  await scheduler.update(x.offer.resources,'ACTIVE');assert.equal(notices[0].kind,'RESTART');assert.ok(occupiedV2(x.ledger.snapshot()).length);assert.equal(x.ledger.status('second'),null);
  release();assert.equal((await first).state,'CANCELLED_SETTLED');await scheduler.update(x.offer.resources,'IDLE');assert.equal((await second).state,'SUCCEEDED');assert.deepEqual(occupiedV2(x.ledger.snapshot()),[]);
 }finally{release();await scheduler.close();await x.ledger.close();}
});
test('cancellation while local authorization is pending settles after admission without starting CPU work',async()=>{
 const x=await setup();let release;const auth=new Promise(resolve=>{release=resolve;});let reads=0;
 const runtime=new PcExecutionRuntime(x.ledger,{...x.ports,authorize:async()=>{await auth;return x.ports.authorize();},read:async()=>{reads++;return x.input;}});
 const scheduler=new DeviceScheduler(x.ledger,runtime,{shares:[.5,.3,.2],agingMs:100,maxConsecutive:2,yieldDeadlineMs:1000},()=>{},()=>100);
 try{await scheduler.update(x.offer.resources,'IDLE');const work=scheduler.submit(x.offer,x.offer.allowedConfigs[0]);scheduler.cancel(x.offer.task.attemptId);release();
  assert.equal((await work).state,'CANCELLED_SETTLED');assert.deepEqual(occupiedV2(x.ledger.snapshot()),[]);assert.equal(x.ledger.status(x.offer.task.attemptId).state,'CANCELLED_SETTLED');
 }finally{release();await scheduler.close();await x.ledger.close();}
});
test('real execution emits local phase spans; failed telemetry flush retries without affecting settlement',async()=>{
 const x=await setup(),buffer=new TraceBuffer(),runtime=new PcExecutionRuntime(x.ledger,x.ports);
 try{
  const trace=new ExecutionTrace(buffer,{traceId:'trace1',parentSpanId:null,snapshotVersion:1,deviceInstanceId:'instance1'},x.offer);
  assert.equal((await runtime.run(x.offer,x.offer.allowedConfigs[0],{trace})).state,'SUCCEEDED');let batch;
  await buffer.flush(async()=>{throw Error('NETWORK');});await buffer.flush(async spans=>{batch=spans;});
  assert.deepEqual(batch.map(s=>s.phase),['LOAD','EXECUTE','PUBLISH']);assert.ok(batch.every(validTraceSpanV2));assert.equal(new Set(batch.map(s=>s.clockDomainId)).size,1);
  assert.deepEqual(batch[1].dependsOn,[batch[0].spanId]);assert.ok(batch.every(s=>s.durationMs===s.endMono-s.startMono));
  for(let i=0;i<300;i++)buffer.emit({...batch[0],spanId:'span'+i});assert.equal(buffer.dropped,44);
 }finally{await runtime.close();await x.ledger.close();}
});

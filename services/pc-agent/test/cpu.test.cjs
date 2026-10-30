const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const sharp=require('sharp');
const {executeCpu,gpuReady}=require('../dist/cpu-engine');
const {PcExecutionRuntime}=require('../dist/execution-runtime');
const {DurableLedger,grantSigningText}=require('../dist/durable-ledger');
const {occupiedV2}=require('@harmony/scheduler-core');
const config={id:'default',threads:1,batchSize:64,quality:'standard'};
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
test('real isolated CPU processes crop images and normalize vectors; malformed parameters and GPU false claims are rejected',async()=>{
 const input=await sharp({create:{width:64,height:64,channels:3,background:{r:255,g:0,b:0}}}).png().toBuffer();
 const result=await executeCpu('image.crop.v1',input,{box:{x:0,y:0,width:1,height:1},paddingRatio:0,targetSize:32,jpegQuality:80},config,new AbortController().signal);
 const meta=await sharp(result.bytes).metadata();assert.equal(meta.width,32);assert.equal(meta.height,32);assert.equal(meta.format,'jpeg');assert.equal(result.backend,'CPU');assert.equal(result.hash,digest(result.bytes));
 const normalized=await executeCpu('vector.normalize.v1',Buffer.from(JSON.stringify({dimension:2,rows:[[3,4],[0,0]]})),{},config,new AbortController().signal);
 assert.deepEqual(JSON.parse(normalized.bytes),{dimension:2,rows:[[.6,.8],[0,0]],norms:[5,0]});
 await assert.rejects(executeCpu('image.crop.v1',input,{box:{x:-1}},config,new AbortController().signal),/CROP_INVALID/);
 await assert.rejects(executeCpu('vector.normalize.v1',Buffer.from('{"dimension":2,"rows":[[1]]}'),{},config,new AbortController().signal),/VECTOR_INVALID/);
 assert.equal(gpuReady({cudaAvailable:false,backend:'CPU',modelLoaded:true,modelHash:'a'.repeat(64)}),false);
 assert.equal(gpuReady({cudaAvailable:true,backend:'CUDA',modelLoaded:false,modelHash:'a'.repeat(64)}),false);
 assert.equal(gpuReady({cudaAvailable:true,backend:'CUDA',modelLoaded:true,modelHash:'a'.repeat(64)}),true);
});
test('real CPU cancellation waits for process termination before declaring settlement',async()=>{
 const signal=new AbortController(),bytes=Buffer.from(JSON.stringify({dimension:8,rows:Array.from({length:100000},()=>[1,2,3,4,5,6,7,8])}));
 const work=executeCpu('vector.normalize.v1',bytes,{},config,signal.signal);setTimeout(()=>signal.abort(),50);
 await assert.rejects(work,/CANCELLED_SETTLED/);
});
test('execution runtime persists before computing, verifies artifacts, returns the existing result on duplicate and survives restart',async()=>{
 const directory=fs.mkdtempSync(path.resolve('../../.test/cpu-runtime-'));const {privateKey,publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
 const certificate=publicKey.export({type:'spki',format:'pem'}),who={groupId:'g1',deviceId:'device1',holderInstanceId:'h1',appInstanceId:null};
 let ledger=await DurableLedger.open(directory,who,certificate,()=>0);const input=Buffer.from(JSON.stringify({dimension:2,rows:[[3,4]]}));
 const offer=structuredClone(require('../../../contracts/scheduling/v2/fixtures/t2/valid/DispatchOffer.json'));
 offer.task.contract.capability='vector.normalize.v1';offer.task.contract.outputSchemas=['vector.normalized'];offer.task.inputs[0].contentHash=digest(input);offer.task.parameters='{}';offer.allowedConfigs=[config];
 const grant={...structuredClone(require('../../../contracts/scheduling/v2/fixtures/t2/valid/AllotmentGrant.json')),holderInstanceId:'h1'};
 grant.signature=crypto.sign('sha256',Buffer.from(grantSigningText(grant)),privateKey).toString('base64');ledger.requestGrant(grant.leaseRequestId);ledger.installGrant(grant);
 let published=0;const ports={authorize:async()=>({coordinatorEpoch:1,online:true,ownerIdle:true,admissionLimit:grant.extra}),read:async()=>input,
  publish:async(bytes,schemaId)=>{assert.equal(ledger.status(offer.task.attemptId).state,'RUNNING');published++;return {artifactId:'output',contentVersion:1,contentHash:digest(bytes),schemaId,schemaVersion:1};}};
 const runtime=new PcExecutionRuntime(ledger,ports);
 try{
  const a=await runtime.run(offer,config);assert.equal(a.state,'SUCCEEDED');assert.deepEqual(await runtime.run(offer,config),a);assert.equal(published,1);assert.deepEqual(occupiedV2(ledger.snapshot()),[]);
  await runtime.close();await ledger.close();ledger=await DurableLedger.open(directory,who,certificate,()=>0);
  const restored=new PcExecutionRuntime(ledger,ports);assert.deepEqual(await restored.run(offer,config),a);assert.equal(published,1);
  const changed=structuredClone(offer);changed.task.parameters='{"different":true}';await assert.rejects(restored.run(changed,config),/CONFLICT/);
 }finally{await runtime.close();await ledger.close();}
});

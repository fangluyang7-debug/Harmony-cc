const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {runtime}=require('./helpers.cjs');
const {CpuHost}=require('../../pc-agent/dist/host'),{DurableLedger}=require('../../pc-agent/dist/durable-ledger');
const {openImageEncoder,imageExecutorId,cudaExecutorId}=require('../../pc-agent/dist/image-encoder');
const {SchedulerSdk}=require('@harmony/scheduler-client'),{nodeSdkPort}=require('@harmony/scheduler-client/dist/node');
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=';
for(const cuda of [false,true])test('installed PC image adapter qualifies and serves SDK client: '+(cuda?'simulated CUDA':'CPU'),async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'image-engine-')),file=path.join(dir,'suite.json'),script=path.join(dir,'fixture.cjs');
 const model={modelId:'fixture',version:'v1',weightsHash:'a'.repeat(64),preprocessVersion:'rgb',embeddingKind:'image',dimension:2,dtype:'float32',normalization:'l2'};
 const output={model,vector:[1,0],...(cuda?{backend:'CUDA'}:{})};let host,r;
 try{
  await fs.writeFile(file,JSON.stringify({model,executorIds:[cuda?cudaExecutorId:imageExecutorId],...(cuda?{vramBytes:1048576}:{}),minimumCosine:.98,memoryBytes:67108864,cases:[{id:'reference',imageBase64:png,vector:[1,0]}]}));
  const fixture=out=>"const input=require('node:fs').readFileSync(0);if(input.toString('base64')!=="+JSON.stringify(png)+")process.exit(1);process.stdout.write("+JSON.stringify(JSON.stringify(out))+");";
  const health={cudaAvailable:true,backend:'CUDA',modelLoaded:true,modelHash:model.weightsHash,model,totalBytes:4194304,uuid:'12345678-1234-1234-1234-123456789abc'};
  const initial=cuda?"if(process.argv.includes('--probe')){process.stdin.resume();process.stdout.write("+JSON.stringify(JSON.stringify(health))+");}else{"+fixture(output)+"}":fixture(output);
  await fs.writeFile(script,initial);
  const encoder=await openImageEncoder(file,process.execPath,script,cuda);
  if(cuda)encoder.gpu.freeBytes=async()=>4194304; // SIMULATED resource sensor in this fixture only.
  // This suite exercises the installed model, including cancellation while it owns the single CPU slot.
  r=await runtime({cpuHost:true,referencePacks:[encoder.pack]});
  const capacity=[{resourcePoolId:'cpu',amount:1},{resourcePoolId:'ram',amount:268435456},...(cuda?[{resourcePoolId:'gpu',amount:1},{resourcePoolId:'vram',amount:1048576}]:[])];
  const invite=await r.auth.invite('team','owner','pc',r.url),pair=await r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:'pc-holder'});
  const identity={groupId:'team',deviceId:'pc',holderInstanceId:'pc-holder',appInstanceId:null},directory=path.join(r.config.dataDir,'host');
  await r.allotments.confirmDevice('pc',capacity,[{groupId:'team',holderInstanceId:'pc-holder',appInstanceId:null}]);
  const ledger=await DurableLedger.open(directory,identity,invite.certificate);await ledger.close();
  const connection={address:r.url,certificate:invite.certificate,fingerprint:invite.fingerprint,domain:'SIMULATED',credential:pair.credential};
  host=await CpuHost.open({directory,identity,connection,imageEncoder:encoder,controlIntervalMs:1000,contribution:{ownerMode:'dedicated',maxCpuThreads:1,maxMemoryBytes:268435456,reserveMemoryBytes:0}});host.start();
  const sourceInvite=await r.auth.invite('team','user','source',r.url),owner=await r.auth.exchange({inviteId:sourceInvite.inviteId,code:sourceInvite.code,holderInstanceId:'source-holder'});
  const registration=await r.apps.register(owner.peer,{label:'Search',allowedContracts:['image.encode.v1'],maxConcurrent:1,resources:capacity,offlineBase:[],onlineExtra:[]},r.url);
  const source=await r.apps.exchange({registrationId:registration.registrationId,code:registration.code});
  const sdk=new SchedulerSdk(nodeSdkPort({...connection,credential:source.credential}));
  const input=await sdk.registerInput(Buffer.from(png,'base64'),'image.raster');
  let candidate;
  for(const end=Date.now()+45000;!candidate&&Date.now()<end;){
    const candidates=await r.snapshots.build('team').then(r=>r.snapshot.candidates).catch(e=>{if(e.message==='GROUP_UNKNOWN')return [];throw e;});
    candidate=candidates.find(c=>c.capability==='image.encode.v1');if(!candidate)await new Promise(resolve=>setTimeout(resolve,200));
  }
  assert.ok(candidate,'PC did not pass the image reference evaluation');
  assert.deepEqual(candidate.modelManifest,model);
  if(cuda){const profile=(await r.directory.profiles('team'))[0];const cpu=profile.executors.find(e=>e.target.backend==='CPU'),gpu=profile.executors.find(e=>e.target.backend==='CUDA');assert.ok(cpu.target.resourcePoolIds.includes('ram')&&gpu.target.resourcePoolIds.includes('ram'));assert.equal(candidate.executorId,cudaExecutorId);assert.ok(candidate.resourceDemand.some(r=>r.resourcePoolId==='vram'&&r.amount===1048576));}
  const submit=(id,modelManifest=model)=>sdk.submit({version:3,id,outputContract:'image.embedding',qualityTarget:'reference',nodes:[{id:'encode',
   capability:'image.encode.v1',modelManifest,input,parameters:JSON.stringify(modelManifest),dependsOn:[]}]},{requestId:id,budgetMs:30000,resultDestination:'ORIGIN'});
  await assert.rejects(submit('wrong-index-space',{...model,weightsHash:'c'.repeat(64)}),/SDK_MODEL_MISMATCH/);
  assert.equal(await r.db.cpuJob.count({where:{id:'wrong-index-space'}}),0);
  const result=await (await submit('encode-ok')).result();assert.deepEqual(JSON.parse(Buffer.from(result.output)),output);
  assert.equal(result.status.deviceId,'pc');
  await fs.writeFile(script,fixture({...output,model:{...model,version:'wrong'}}));
  await assert.rejects(async()=>(await submit('encode-wrong')).result(),/JOB_FAILED/);
  const receipt=await r.db.receipt.findUniqueOrThrow({where:{id:'encode-wrong'}});
  assert.equal(JSON.parse(receipt.recordJson).errorCode,'ENCODER_MODEL_MISMATCH');assert.equal(receipt.committed,false);
  if(cuda){
    await fs.writeFile(script,fixture({...output,backend:'CPU'}));
    await assert.rejects(async()=>(await submit('encode-fallback')).result(),/JOB_FAILED/);
    const fallback=await r.db.receipt.findUniqueOrThrow({where:{id:'encode-fallback'}});
    assert.equal(JSON.parse(fallback.recordJson).errorCode,'CUDA_BACKEND_MISMATCH');assert.equal(fallback.committed,false);
  }
  const started=path.join(dir,'started');
  await fs.writeFile(script,"require('fs').writeFileSync("+JSON.stringify(started)+",String(process.pid));setInterval(()=>{},1000);");
  const task=await submit('encode-cancel');
  for(const end=Date.now()+10000;Date.now()<end;){if(await fs.stat(started).catch(()=>null))break;await new Promise(resolve=>setTimeout(resolve,50));}
  const pid=Number(await fs.readFile(started,'utf8'));
  await task.cancel();await assert.rejects(task.result(),/JOB_CANCELLED/);
  const settled=await r.db.receipt.findUniqueOrThrow({where:{id:'encode-cancel'}});
  assert.equal(JSON.parse(settled.recordJson).state,'CANCELLED_SETTLED');assert.equal(settled.committed,false);
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  if(cuda){
    encoder.gpu.freeBytes=async()=>524288;
    let pools=[];
    for(const end=Date.now()+15000;Date.now()<end;){
      pools=(await r.directory.profiles('team'))[0].pools;
      if(pools.find(p=>p.resourcePoolId==='vram')?.admissionLimit.value===524288)break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal(pools.find(p=>p.resourcePoolId==='vram').admissionLimit.value,524288);
    assert.equal(pools.find(p=>p.resourcePoolId==='gpu').exclusive,true);
    assert.ok(!(await r.snapshots.build('team')).snapshot.candidates.some(c=>c.executorId===cudaExecutorId));
  }
 }finally{await host?.close();await r?.close();await fs.rm(dir,{recursive:true,force:true});}
});

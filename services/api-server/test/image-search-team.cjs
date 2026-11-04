// Simulated image engines, real paired hosts, coordinator, scheduler SDK and transfer paths.
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs/promises');
const {randomUUID}=require('node:crypto');
const {runtime}=require('../../coordinator/test/helpers.cjs');
const {CpuHost}=require('../../pc-agent/dist/host'),{DurableLedger}=require('../../pc-agent/dist/durable-ledger');
const {openImageEncoder,imageExecutorId,cudaExecutorId}=require('../../pc-agent/dist/image-encoder');
module.exports=async function checkTeamSearch(root,model,png,run,candidates){
 const previous=process.cwd(),hosts=[];let r;
 try{
  process.chdir(path.resolve(__dirname,'../../coordinator'));
  const suite=path.join(root,'team-suite.json'),script=path.join(root,'image-fixture.cjs');
  await fs.writeFile(suite,JSON.stringify({model,executorIds:[imageExecutorId,cudaExecutorId],minimumCosine:.98,memoryBytes:67108864,
   vramBytes:1048576,cases:[{id:'fixture',imageBase64:png,vector:[1,0]}]}));
  const health={backend:'CUDA',cudaAvailable:true,modelLoaded:true,modelHash:model.weightsHash,model,totalBytes:4194304,uuid:'12345678-1234-1234-1234-123456789abc'};
  await fs.writeFile(script,`const fs=require('fs');if(fs.readFileSync(0).toString('base64')!==${JSON.stringify(png)})process.exit(2);
   const model=${JSON.stringify(model)};process.stdout.write(JSON.stringify(process.argv.includes('--probe')?${JSON.stringify(health)}:
   {model,vector:[1,0],backend:process.argv.includes('--cuda')?'CUDA':'CPU'}));`);
  const local=await openImageEncoder(suite,process.execPath,script),remote=await openImageEncoder(suite,process.execPath,script,true);
  remote.gpu.freeBytes=async()=>4194304;
  r=await runtime({cpuHost:true,referencePacks:[local.pack]});
  const unit=[{resourcePoolId:'cpu',amount:1},{resourcePoolId:'ram',amount:268435456}],gpu=unit.concat([{resourcePoolId:'gpu',amount:1},{resourcePoolId:'vram',amount:1048576}]);
  for(const origin of [true,false]){
   const device=randomUUID(),holder=randomUUID(),group='image-team',invite=await r.auth.invite(group,'owner',device,r.url);
   let paired=await r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:holder});
   await r.allotments.confirmDevice(device,origin?unit:gpu,[{groupId:group,holderInstanceId:holder,appInstanceId:null}]);
   if(origin){const reg=await r.apps.register(paired.peer,{label:'Search fixture',allowedContracts:['image.encode.v1'],
    maxConcurrent:1,resources:gpu,offlineBase:unit,onlineExtra:[]},r.url);paired=await r.apps.exchange({registrationId:reg.registrationId,code:reg.code});}
   const identity={groupId:group,deviceId:device,holderInstanceId:paired.peer.holderInstanceId,appInstanceId:paired.peer.app?.appInstanceId??null};
   const directory=path.join(r.config.dataDir,device),ledger=await DurableLedger.open(directory,identity,invite.certificate);await ledger.close();
   const host=await CpuHost.open({directory,identity,imageEncoder:origin?local:remote,controlIntervalMs:1000,connection:{address:r.url,
    certificate:invite.certificate,fingerprint:invite.fingerprint,credential:paired.credential,domain:'SIMULATED'},
    contribution:{ownerMode:'dedicated',maxCpuThreads:1,maxMemoryBytes:268435456,reserveMemoryBytes:0}});
   hosts.push(host);host.start();
  }
  let targets=[];
  for(const end=Date.now()+60000;Date.now()<end;){
   targets=await r.snapshots.build('image-team').then(x=>x.snapshot.candidates.filter(c=>c.capability==='image.encode.v1')).catch(e=>{if(e.message==='GROUP_UNKNOWN')return [];throw e;});
   if(targets.length===2)break;await new Promise(resolve=>setTimeout(resolve,200));
  }
  assert.equal(targets.length,2);
  for(const target of targets){
   const found=await run({sdk:hosts[0].sdk(),targetId:target.targetId});
   assert.equal(found.encodingTargetId,target.targetId);assert.deepEqual(found.candidates,candidates);
   const row=await r.db.attempt.findUniqueOrThrow({where:{id:found.requestId}}),offer=JSON.parse(row.offerJson);
   assert.equal(row.holderInstanceId,target.holderInstanceId);assert.equal(row.state,'SUCCEEDED');
   if(target.executorId===imageExecutorId)assert.deepEqual(offer.transferPlan,[]);
   else{assert.equal(offer.target.backend,'CUDA');assert.notEqual(offer.task.originDeviceId,offer.target.deviceId);}
  }
 }finally{try{for(const host of hosts)await host.close();await r?.close();}finally{process.chdir(previous);}}
};

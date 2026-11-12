const {test}=require('node:test'),assert=require('node:assert/strict');
const {runtime}=require('./helpers.cjs'),{DeviceDirectory}=require('../dist/directory'),{settledProfile}=require('../dist/dispatch-capacity');
const baseProfile=require('../../../contracts/scheduling/v2/fixtures/t2/valid/DeviceProfile.json'),baseOffer=require('../../../contracts/scheduling/v2/fixtures/t2/valid/DispatchOffer.json');
const peer={groupId:'g1',holderInstanceId:'h1',deviceId:'device1',principalId:'p1',credentialId:'c1'};
const ms=value=>({value,unit:'ms',source:'SIMULATED',sampledAt:100,ttlMs:1000});
function fixture(){
 const p=structuredClone(baseProfile),o=structuredClone(baseOffer);p.inFlight=[];p.queued=[];p.credits.forEach(c=>c.slots=16);
 const pool={...structuredClone(p.pools[0]),resourcePoolId:'gpu',kind:'GPU_SLOTS',unit:'slots',exclusive:true,ownerReserved:0,contributionLimit:1};delete pool.unit;
 for(const k of ['total','admissionLimit','occupied'])pool[k]={...pool[k],value:k==='occupied'?0:1,unit:'slots'};
 p.pools.push(pool);p.executors[0].target.backend='VULKAN';p.executors[0].target.resourcePoolIds.push('gpu');p.executors[0].resources.push({resourcePoolId:'gpu',amount:1});
 o.target=structuredClone(p.executors[0].target);o.resources=structuredClone(p.executors[0].resources);o.task.contract=structuredClone(p.executors[0].contract);o.task.priority='REMOTE_INTERACTIVE';o.task.budget.remainingMs=10000;
 return {p,o};
}
function settled(p,o,id){const fence={deviceId:p.deviceId,holderInstanceId:p.holderInstanceId,ledgerEpoch:p.ledgerEpoch,counter:1};return {id,holderInstanceId:p.holderInstanceId,offerJson:JSON.stringify(o),recordJson:JSON.stringify({fence,resourcesSettled:true,receipt:{attemptId:id,fence,resourcesSettled:true,actualTarget:o.target}})};}
function busy(p,o,id){p.inFlight=[{attemptId:id,targetId:o.target.targetId,state:'RUNNING',resources:o.resources,elapsed:ms(100),remaining:ms(200)}];p.pools.forEach(pool=>pool.occupied.value=o.resources.find(r=>r.resourcePoolId===pool.resourcePoolId)?.amount??0);}

test('durable settlement removes only matching stale flight occupancy without changing the reported profile',()=>{
 const {p,o}=fixture();busy(p,o,'first');const before=JSON.stringify(p),row=settled(p,o,'first');
 const corrected=settledProfile(p,[row],100,'SIMULATED');assert.equal(corrected.inFlight.length,0);assert.ok(corrected.pools.every(p=>p.occupied.value===0));assert.equal(JSON.stringify(p),before);
 assert.deepEqual(settledProfile(corrected,[row],100,'SIMULATED'),corrected,'no double release');
 for(const mutate of [r=>r.resourcesSettled=false,r=>r.receipt.resourcesSettled=false,r=>r.fence.ledgerEpoch++,r=>r.receipt.fence.holderInstanceId='other',r=>r.receipt.actualTarget.targetId='other']){
  const bad=structuredClone(row),record=JSON.parse(bad.recordJson);mutate(record);bad.recordJson=JSON.stringify(record);assert.equal(settledProfile(p,[bad],100,'SIMULATED'),p);
 }
 assert.equal(settledProfile(p,[row],1200,'SIMULATED'),p,'expired profile is not revived');
 p.pools[0].occupied.value++;assert.equal(settledProfile(p,[row],100,'SIMULATED'),p,'unexplained occupancy is never released');
});

test('GPU lookahead pipelines four prepared offers within its wait budget and reuses settled credit before heartbeat',async()=>{
 const r=await runtime();try{
  const dir=new DeviceDirectory(r.db,'SIMULATED',()=>100),{p,o}=fixture();await dir.ingest(peer,p);
  const admission=wait=>r.db.$transaction(tx=>dir.dispatchAdmission(tx,o,'h1',undefined,wait));
  const add=(id,offer=o)=>r.db.attempt.create({data:{id,groupId:'g1',workflowId:'w',nodeId:id,holderInstanceId:'h1',executionDigest:id,taskJson:'{}',offerJson:JSON.stringify(offer),state:'OFFERED'}});
  assert.equal(await admission(200),'IMMEDIATE');await add('first');
  assert.equal(await admission(undefined),null,'legacy ordinary admission remains strict');assert.equal(await admission(200),'GPU_QUEUE');
  assert.equal(await admission(2100),null);o.task.budget.remainingMs=500;assert.equal(await admission(200),null);o.task.budget.remainingMs=10000;
  p.credits.forEach(c=>c.slots=0);p.sequence++;await dir.ingest(peer,p);
  assert.equal(await admission(200),'GPU_QUEUE','zero free execution credits do not mean a full waiting queue');
  p.credits.forEach(c=>c.slots=16);p.sequence++;await dir.ingest(peer,p);
  await add('second');assert.equal(await admission(200),'GPU_QUEUE');
  await add('third');assert.equal(await admission(200),'GPU_QUEUE');
  await add('fourth');assert.equal(await admission(200),null,'one running plus three waiting; never overflow the agent');
  busy(p,o,'first');p.sequence++;await dir.ingest(peer,p);
  await r.db.attempt.update({where:{id:'first'},data:{state:'SUCCEEDED',recordJson:settled(p,o,'first').recordJson}});
  assert.equal((await dir.profiles('g1'))[0].inFlight.length,0,'planner and admission see the same settlement');
  assert.equal(await admission(200),'GPU_QUEUE','three remain reserved; exactly one new successor fits');
  for(const id of ['second','third','fourth'])await r.db.attempt.update({where:{id},data:{state:'SUCCEEDED',recordJson:settled(p,o,id).recordJson}});
  assert.equal(await admission(200),'IMMEDIATE');
  await add('fifth');delete p.queued;p.sequence++;await dir.ingest(peer,p);assert.equal(await admission(200),null,'no queue support means no pre-dispatch');
 }finally{await r.close();}
});

test('first-photo preference requires a live, prepared older same-App same-GPU workflow',async()=>{
 const r=await runtime();try{
  const now=Date.now(),{o}=fixture();o.task.contract.capability='photo.enhance.v1';o.task.app.appId='photo';o.task.workflowId='older';
  const older={offer:o,holderId:'h1',workflowSubmittedAt:now-1000,deadlineAt:now+10000,dispatchReadyAt:now};
  const current={...structuredClone(older),workflowSubmittedAt:now};current.offer.task.workflowId='newer';
  await r.db.sdkWorkflowJob.create({data:{id:'older',groupId:'g1',sourceHolderId:'h1',state:'ACTIVE',metadataJson:'{}'}});
  await r.db.cpuJob.create({data:{id:'ready',groupId:'g1',principalId:'p1',sourceHolderId:'h1',state:'WAITING_INPUT',metadataJson:JSON.stringify(older)}});
  const check=()=>r.db.$transaction(tx=>r.jobs.earlierPhotoReady(tx,peer,'current',current));
  assert.equal(await check(),true);
  assert.equal(await r.db.$transaction(tx=>r.jobs.earlierPhotoReady(tx,peer,'current',current,'GPU_QUEUE')),false,'first-photo preference must not starve an admitted GPU pipeline');
  current.offer.target.backend='CPU';assert.equal(await check(),false,'independent CPU work is not delayed');current.offer.target.backend='VULKAN';
  older.dispatchReadyAt=now-2000;await r.db.cpuJob.update({where:{id:'ready'},data:{metadataJson:JSON.stringify(older)}});assert.equal(await check(),false,'stale prepared work cannot hold the GPU');
  older.dispatchReadyAt=Date.now();await r.db.cpuJob.update({where:{id:'ready'},data:{metadataJson:JSON.stringify(older)}});
  await r.db.sdkWorkflowJob.update({where:{id:'older'},data:{state:'CANCEL_REQUESTED'}});assert.equal(await check(),false);
  await r.db.sdkWorkflowJob.update({where:{id:'older'},data:{state:'ACTIVE'}});current.offer.task.app.appId='another-app';assert.equal(await check(),false);current.offer.task.app.appId='photo';
  await r.db.attempt.create({data:{id:'ready',groupId:'g1',workflowId:'older',nodeId:'n',holderInstanceId:'h1',executionDigest:'d',taskJson:'{}',state:'OFFERED'}});assert.equal(await check(),false,'an admitted predecessor no longer blocks dispatch');
 }finally{await r.close();}
});

 test('shared GPU execution lanes overlap four lifecycles and retain bounded lookahead',async()=>{
 const r=await runtime();try{
 const dir=new DeviceDirectory(r.db,'SIMULATED',()=>100),{p,o}=fixture();const gpu=p.pools.find(p=>p.kind==='GPU_SLOTS');gpu.exclusive=false;gpu.total.value=gpu.admissionLimit.value=gpu.contributionLimit=4;
 for(const pool of p.pools.filter(p=>p.kind!=='GPU_SLOTS')){pool.total.value=pool.admissionLimit.value=pool.contributionLimit=100000;pool.ownerReserved=0;}
 await dir.ingest(peer,p);const admission=()=>r.db.$transaction(tx=>dir.dispatchAdmission(tx,o,'h1',undefined,200));
 for(let i=0;i<7;i++){assert.equal(await admission(),i<4?'IMMEDIATE':'GPU_QUEUE');await r.db.attempt.create({data:{id:'lane'+i,groupId:'g1',workflowId:'w',nodeId:'n'+i,holderInstanceId:'h1',executionDigest:'d'+i,taskJson:'{}',offerJson:JSON.stringify(o),state:'OFFERED'}});}
 assert.equal(await admission(),null,'seven total preserves host pending headroom');
 const {capacityVector}=require('../dist/spaces'),{gpuPipelineSlots}=require('@harmony/scheduler-core');
 assert.equal(gpuPipelineSlots(8*1073741824),4);assert.equal(gpuPipelineSlots(536870912),1);assert.equal(gpuPipelineSlots(NaN),1);
 assert.equal(capacityVector({maxCpuThreads:8,maxMemoryBytes:1073741824,maxVramBytes:8*1073741824}).find(p=>p.resourcePoolId==='gpu').amount,4);
 }finally{await r.close();}
 });

const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {runtime}=require('./helpers.cjs');
const {qualifySimulated}=require('./fixtures.cjs');
const {DeviceDirectory}=require('../dist/directory');
const {ProfileProjection}=require('../dist/profile-projection');
const {SnapshotBuilder}=require('../dist/planning');
const fixture=()=>JSON.parse(fs.readFileSync('../../contracts/scheduling/v2/fixtures/t2/valid/DeviceProfile.json'));
const peer={groupId:'g1',holderInstanceId:'h1',deviceId:'device1',principalId:'p1',credentialId:'c1'};
const contribution={minimumBattery:20,maximumTemperature:3,allowMetered:false,priority:'REMOTE_INTERACTIVE',requireForeground:true};
const policy={version:'p1',revoked:false,allowedTargetIds:['target1','target2'],limits:{maxCandidates:8,lookahead:16,beamWidth:8,planningBudgetMs:20,switchCostMs:0,hysteresisMs:0}};
function setup(r,now=()=>100){
 const dir=new DeviceDirectory(r.db,'SIMULATED',now),views=new SnapshotBuilder(r.db,'SIMULATED');
 return {dir,views,projection:new ProfileProjection(r.db,dir,views)};
}
test('authenticated profiles atomically publish versions; duplicate and failed events do not change the snapshot',async()=>{
 const r=await runtime();try{
  const {dir,views,projection}=setup(r),p=fixture();
  await projection.ingest(peer,p);await assert.rejects(views.build('g1'),/GROUP_UNKNOWN/);
  await projection.configure('g1',policy,contribution);
  assert.equal((await views.build('g1')).snapshot.candidates.length,0);
  await qualifySimulated(r.db,p);await projection.refresh('g1');
  const before=(await views.build('g1')).snapshot;
  assert.equal(before.candidates[0].availability.snapshotVersion,before.version);
  assert.equal(before.candidates.length,1);assert.equal(before.devices.length,1);
  assert.equal('pools' in before.devices[0],false);
  await projection.ingest(peer,p);assert.equal((await views.build('g1')).snapshot.version,before.version);
  p.sequence++;p.ownerActivity.value='ACTIVE';await projection.ingest(peer,p);
  const after=(await views.build('g1')).snapshot;assert.equal(after.version,before.version+1);assert.equal(after.candidates.length,0);
  const failing=new ProfileProjection(r.db,dir,{replace:async()=>{throw Error('WRITE_FAILURE');}});
  p.sequence++;p.ownerActivity.value='IDLE';await assert.rejects(failing.ingest(peer,p),/WRITE_FAILURE/);
  assert.equal((await dir.profiles('g1'))[0].sequence,2);assert.equal((await views.build('g1')).snapshot.version,after.version);
  await assert.rejects(projection.configure('g1',policy,{...contribution,minimumBattery:101}),/POLICY_INVALID/);
  await assert.rejects(projection.ingest({...peer,deviceId:'forged'},p),/PROFILE_INVALID/);
 }finally{await r.close();}
});
test('same physical device retains both holder epochs and sums occupancy without mixing raw profile rows',async()=>{
 const r=await runtime();try{
  const {views,projection}=setup(r),a=fixture(),b=fixture();
  b.holderInstanceId='h2';b.deviceInstanceId='instance2';b.executors[0].target.targetId='target2';
  a.pools[0].occupied.value=700;b.pools[0].occupied.value=200;
  await projection.configure('g1',policy,contribution);await projection.ingest(peer,a);
  await projection.ingest({...peer,holderInstanceId:'h2'},b);
  await qualifySimulated(r.db,a);await qualifySimulated(r.db,b);await projection.refresh('g1');
  const s=(await views.build('g1')).snapshot;
  assert.deepEqual(s.devices.map(d=>d.holderInstanceId).sort(),['h1','h2']);assert.equal(s.candidates.length,2);
  assert.equal(s.resources.find(p=>p.resourcePoolId==='memory1').available,124);
  assert.equal(new Set(s.resources.map(p=>p.resourcePoolId)).size,s.resources.length);
  b.sequence++;b.executors[0].target.targetId='target1';await assert.rejects(projection.ingest({...peer,holderInstanceId:'h2'},b),/COLLISION/);
 }finally{await r.close();}
});
test('candidate lifetime includes safety, quota and quality signals; missing and stale evidence never authorizes work',async()=>{
 const r=await runtime();let now=100;try{
  const {dir}=setup(r,()=>now),p=fixture();p.temperature.ttlMs=10;
  await dir.ingest(peer,p);await qualifySimulated(r.db,p);
  const s=await dir.snapshot('g1','p1',1,contribution);assert.equal(s.candidates[0].ttlMs,10);
  const request={nodes:[{id:'n1',capability:'capability1',dependencies:[],inputs:['input'],output:{id:'output',bytes:1},baselineTargetId:'target1',memoryBytes:100,minimumQuality:1,candidates:[]}],
    artifacts:[{id:'input',bytes:1,replicas:[{deviceId:'device1',readMs:0}]}],links:[],deviceResources:[],domain:'SIMULATED',remainingBudgetMs:1000,networkAllowed:false,privacy:'LOCAL_ONLY',localDeviceId:'device1',now:100,committedNodeIds:[],committedArtifacts:[],finalDestination:'device1'};
  assert.equal(r.planning.plan(s,request,policy,{now:100,monotonic:()=>0}).decision.status,'ready');
  assert.equal(r.planning.plan(s,request,policy,{now:111,monotonic:()=>0}).decision.status,'blocked');
  now=111;assert.equal((await dir.snapshot('g1','p1',1,contribution)).candidates.length,0);now=100;
  const id=JSON.stringify(['g1','h1','target1']),row=await r.db.capabilityState.findUnique({where:{id}}),valid=JSON.parse(row.metadataJson);
  for(const patch of [{groupId:'other'},{holderInstanceId:'other'},{targetId:'other'},{revision:999},{domain:'REAL'},
    {quality:{...valid.quality,sampledAt:0,ttlMs:1}},{state:'WAITING_MODEL'},{quality:1}]){
   await r.db.capabilityState.update({where:{id},data:{metadataJson:JSON.stringify({...valid,...patch})}});
   assert.equal((await dir.snapshot('g1','p1',1,contribution)).candidates.length,0,JSON.stringify(patch));
  }
 }finally{await r.close();}
});
test('removed executors cannot recover approval, unsettled pools cannot disappear and network conflicts cannot supply a link',async()=>{
 const r=await runtime();try{
  const {dir}=setup(r),p=fixture();await dir.ingest(peer,p);await qualifySimulated(r.db,p);
  const none=structuredClone(p);none.sequence++;none.executors=[];await dir.ingest(peer,none);
  p.sequence=3;await dir.ingest(peer,p);assert.equal((await dir.snapshot('g1','p1',1,contribution)).candidates.length,0);
  p.sequence++;p.pools[0].occupied.value=1;await dir.ingest(peer,p);
  const removed=structuredClone(p);removed.sequence++;removed.executors=[];removed.pools.shift();
  await assert.rejects(dir.ingest(peer,removed),/POOL_UNSETTLED/);
  p.sequence++;p.links.push({...structuredClone(p.links[0]),networkEpoch:'another-network'});await dir.ingest(peer,p);
  assert.equal((await dir.snapshot('g1','p1',1,contribution)).links.length,0);
  p.sequence++;p.links.pop();await dir.ingest(peer,p);assert.equal((await dir.snapshot('g1','p1',1,contribution)).links.length,1);
  p.sequence++;p.links[0].via='relay1';await dir.ingest(peer,p);assert.equal((await dir.snapshot('g1','p1',1,contribution)).links.length,0);
 }finally{await r.close();}
});
test('executor changes invalidate only that identity; a holder epoch change requires fresh evidence',async()=>{
 const r=await runtime();try{
  const {dir}=setup(r),p=fixture();const second=structuredClone(p.executors[0]);second.target.targetId='target2';p.executors.push(second);
  await dir.ingest(peer,p);await qualifySimulated(r.db,p);assert.equal((await dir.snapshot('g1','p1',1,contribution)).candidates.length,2);
  p.sequence++;p.executors[0].target.executorVersion='v2';await dir.ingest(peer,p);
  assert.deepEqual((await dir.snapshot('g1','p1',1,contribution)).candidates.map(c=>c.targetId),['target2']);
  p.sequence=1;p.ledgerEpoch++;p.deviceInstanceId='new-instance';await dir.ingest(peer,p);
  assert.equal((await dir.snapshot('g1','p1',1,contribution)).candidates.length,0);
 }finally{await r.close();}
});

test('fresh holder evidence forecasts a capacity recheck but never marks an occupied target ready',async()=>{
 const r=await runtime();try{
  const {views,projection}=setup(r),p=fixture(),e=p.executors[0],pool=p.pools.find(v=>v.resourcePoolId===e.resources[0].resourcePoolId);
  pool.occupied.value=pool.admissionLimit.value;
  p.inFlight=[{attemptId:'running',targetId:e.target.targetId,state:'RUNNING',resources:[{resourcePoolId:pool.resourcePoolId,amount:pool.occupied.value}],
   elapsed:{value:10,source:'SIMULATED',sampledAt:100,ttlMs:100,unit:'ms'},remaining:{value:30,source:'PRIOR',sampledAt:100,ttlMs:100,unit:'ms'}}];
  await projection.ingest(peer,p);await projection.configure('g1',policy,contribution);
  await qualifySimulated(r.db,p);await projection.refresh('g1');
  const snapshot=(await views.build('g1')).snapshot,a=snapshot.candidates[0].availability;
  assert.equal(a.snapshotVersion,snapshot.version);assert.equal(a.reason,'RESOURCE_CAPACITY');assert.equal(a.resourceWait.value,30);
  const {availability}=require('@harmony/scheduler-core');
  assert.equal(availability(p,e,contribution.priority,1,131).resourceWait.value,null);
  p.inFlight=[];assert.equal(availability(p,e,contribution.priority,1,100).resourceWait.value,null);
  pool.occupied.value=0;p.queued=[{attemptId:'waiting',targetId:e.target.targetId,resources:e.resources,priority:contribution.priority,reason:'LOCAL_QUEUE_POLICY',elapsed:{value:2,unit:'ms',source:'SIMULATED',sampledAt:100,ttlMs:100}}];
  assert.equal(availability(p,e,contribution.priority,1,100).reason,'LOCAL_QUEUE_PENDING');
  p.queued=[];p.credits.forEach(c=>c.slots=0);
  assert.equal(availability(p,e,contribution.priority,1,100).reason,'NO_CATEGORY_CREDIT');
 }finally{await r.close();}
});

test('battery, charging and temperature policy change placement with a scoped rejection reason',async()=>{
 const r=await runtime();try{
  const {dir}=setup(r),p=fixture(),e=p.executors[0];
  const request={nodes:[{id:'compute',capability:e.contract.capability,dependencies:[],inputs:[],output:{id:'out',bytes:1},baselineTargetId:e.target.targetId,memoryBytes:1,minimumQuality:0,candidates:[]}],
   artifacts:[],links:[],deviceResources:[],domain:'SIMULATED',remainingBudgetMs:10000,networkAllowed:false,privacy:'LOCAL_ONLY',localDeviceId:p.deviceId,now:100,committedNodeIds:[],committedArtifacts:[]};
  await dir.ingest(peer,p);await qualifySimulated(r.db,p);
  async function decide(){
   p.sequence++;await dir.ingest(peer,p);
   return r.planning.plan(await dir.snapshot('g1','p1',p.sequence,contribution),request,policy,{now:100,monotonic:()=>0}).decision;
  }
  p.battery.value=5;p.charging.value='NOT_CHARGING';
  assert.equal((await decide()).rejections[0].code,'BATTERY_LOW_OR_UNKNOWN');
  p.charging.value='CHARGING';assert.equal((await decide()).status,'ready');
  p.temperature.value=4;assert.equal((await decide()).rejections[0].code,'TEMPERATURE_HIGH_OR_UNKNOWN');
  p.temperature.value=2;p.powerSave.value='ON';assert.equal((await decide()).rejections[0].code,'POWER_SAVE_OR_UNKNOWN');
 }finally{await r.close();}
});

test('a second dispatch cannot spend an outstanding offer credit or reserve an occupied pool twice',async()=>{
 const r=await runtime();try{
  const {dir}=setup(r),p=fixture(),offer=structuredClone(require('../../../contracts/scheduling/v2/fixtures/t2/valid/DispatchOffer.json'));
  offer.task.priority='REMOTE_INTERACTIVE';p.credits.forEach(c=>c.slots=1);
  await dir.ingest(peer,p);
  const check=()=>r.db.$transaction(tx=>dir.hasDispatchCredit(tx,offer,peer.holderInstanceId));
  assert.equal(await check(),true);
  const data={id:'pending',groupId:'g1',workflowId:'wf',nodeId:'peer',holderInstanceId:'h1',executionDigest:'fixture',taskJson:'{}',state:'OFFERED',offerJson:JSON.stringify(offer)};
  await r.db.attempt.create({data});assert.equal(await check(),false);
  const resource=offer.resources[0],pool=p.pools.find(x=>x.resourcePoolId===resource.resourcePoolId);
  pool.admissionLimit.value=resource.amount;offer.task.priority='REMOTE_BATCH';assert.equal(p.credits.find(c=>c.priority==='REMOTE_BATCH').slots,1);
  p.sequence++;await dir.ingest(peer,p);assert.equal(await check(),false);
  await r.db.attempt.update({where:{id:'pending'},data:{state:'FAILED',recordJson:JSON.stringify({resourcesSettled:false})}});assert.equal(await check(),false);
  await r.db.attempt.update({where:{id:'pending'},data:{recordJson:JSON.stringify({resourcesSettled:true})}});assert.equal(await check(),true);
 }finally{await r.close();}
});

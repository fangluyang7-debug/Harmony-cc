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

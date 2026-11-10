const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs');
const {runtime}=require('./helpers.cjs');
const {DeviceDirectory,executorIdentity}=require('../dist/directory');
const {qualifySimulated}=require('./fixtures.cjs');
const fixture=()=>JSON.parse(fs.readFileSync('../../contracts/scheduling/v2/fixtures/t2/valid/DeviceProfile.json'));
const peer={groupId:'g1',holderInstanceId:'h1',deviceId:'device1',principalId:'p1',credentialId:'c1'};
const policy={minimumBattery:20,maximumTemperature:3,allowMetered:false,priority:'REMOTE_INTERACTIVE',requireForeground:true};
test('recovered epoch replaces stale occupancy only after matching persisted ack and all receipts settle',async()=>{
 const r=await runtime();try{
  const dir=new DeviceDirectory(r.db,'SIMULATED',()=>100),p=fixture();p.pools[0].occupied.value=1;await dir.ingest(peer,p);
  const next=structuredClone(p);next.ledgerEpoch++;next.sequence++;next.deviceInstanceId='recovered';next.pools.forEach(p=>p.occupied.value=0);
  await assert.rejects(dir.ingest(peer,next),/PROFILE_RECOVERY_REQUIRED/);
  const id=JSON.stringify(['allotment','g1','h1']);
  const grant={deviceId:'device1',ledgerEpoch:next.ledgerEpoch,coordinatorEpoch:1,version:2,allotmentId:'a1'};
  const ack={persisted:true,holderInstanceId:'h1',allotmentId:'a1',ledgerEpoch:next.ledgerEpoch,coordinatorEpoch:1,version:1,occupied:[]};
  const save=()=>r.db.allotment.upsert({where:{id},create:{id,groupId:'g1',revision:2,metadataJson:JSON.stringify({grant,ack})},update:{metadataJson:JSON.stringify({grant,ack})}});
  await save();await assert.rejects(dir.ingest(peer,next),/PROFILE_RECOVERY_REQUIRED/);
  ack.version=2;ack.occupied=[{resourcePoolId:'cpu1',amount:1}];await save();await assert.rejects(dir.ingest(peer,next),/PROFILE_RECOVERY_REQUIRED/);
  ack.occupied=[];await save();
  await r.db.attempt.create({data:{id:'recovery-attempt',groupId:'g1',workflowId:'w1',nodeId:'n1',executionDigest:'d1',state:'ACCEPTED',holderInstanceId:'h1',taskJson:'{}'}});
  await assert.rejects(dir.ingest(peer,next),/PROFILE_RECOVERY_REQUIRED/);
  await r.db.attempt.update({where:{id:'recovery-attempt'},data:{state:'CANCELLED_SETTLED',recordJson:JSON.stringify({resourcesSettled:true})}});
  assert.equal(await dir.ingest(peer,next),true);
  assert.equal((await dir.profiles('g1'))[0].ledgerEpoch,next.ledgerEpoch);
 }finally{await r.close();}
});
test('profile evidence, identity and revision are validated; discovery cannot authorize business work',async()=>{
 const r=await runtime();let now=100;
 try{
  const dir=new DeviceDirectory(r.db,'SIMULATED',()=>now),p=fixture();await dir.ingest(peer,p);
  assert.equal((await dir.snapshot('g1','p1',1,policy)).candidates.length,0);
  const id=JSON.stringify(['g1','h1','target1']);
  // A qualified test fixture stands in for B11, explicitly in the simulated domain.
  await qualifySimulated(r.db,p);
  assert.equal((await dir.snapshot('g1','p1',1,policy)).candidates.length,1);
  for(const name of ['compute','uncertainty','queue'])p.executors[0][name]={...p.executors[0][name],source:'UNKNOWN',value:null};p.sequence++;await dir.ingest(peer,p);
  const evidence=(await dir.snapshot('g1','p1',1,policy)).candidates[0];assert.ok(evidence);assert.equal(evidence.computeMs,null);assert.equal(evidence.costEvidence.compute.source,'UNKNOWN');
  now=1200;assert.equal((await dir.snapshot('g1','p1',1,policy)).candidates.length,0);now=100;
  await assert.rejects(dir.ingest({...peer,deviceId:'different'},p),/PROFILE_INVALID/);
  const changed=structuredClone(p);changed.ownerActivity.value='ACTIVE';await assert.rejects(dir.ingest(peer,changed),/PROFILE_REPLAY/);
  changed.sequence=p.sequence+1;await dir.ingest(peer,changed);assert.equal((await dir.snapshot('g1','p1',2,policy)).candidates.length,0);
  const fake=fixture();fake.sequence=changed.sequence+1;fake.ownerActivity.source='MEASURED';await assert.rejects(dir.ingest(peer,fake),/DOMAIN/);
 }finally{await r.close();}
});
test('battery, temperature, foreground, power and owner signals change eligibility without invented zeros',async()=>{
 const r=await runtime();try{const dir=new DeviceDirectory(r.db,'SIMULATED',()=>100);
  for(const [field,value,reason] of [['ownerActivity',null,'OWNER'],['foreground','BACKGROUND','BACKGROUND'],['powerSave','ON','POWER'],['temperature',4,'TEMPERATURE']]){
   const p=fixture();p[field].value=value;if(value===null)p[field].source='UNKNOWN';assert.match(dir.reason(p,policy,100),new RegExp(reason));
  }
  const p=fixture();p.battery.value=10;p.charging.value='NOT_CHARGING';assert.match(dir.reason(p,policy,100),/BATTERY/);
  p.charging.value='CHARGING';assert.equal(dir.reason(p,policy,100),null);p.credits.forEach(c=>c.slots=0);assert.equal(dir.reason(p,policy,100),'NO_CREDIT');
 }finally{await r.close();}
});


test('same-device App contribution ceilings are not mistaken for the shared physical budget',async()=>{
 const r=await runtime();try{
  const dir=new DeviceDirectory(r.db,'SIMULATED',()=>100),a=fixture(),b=fixture();
  const pool=a.pools[0],poolId=pool.resourcePoolId;
  for(const p of [a,b]){p.pools[0].total.value=4;p.pools[0].ownerReserved=3;p.pools[0].contributionLimit=1;p.pools[0].admissionLimit.value=1;p.pools[0].occupied.value=0;}
  a.pools[0].occupied.value=1;b.holderInstanceId='h2';b.deviceInstanceId='instance2';b.executors.forEach(e=>e.target.targetId+='-b');
  await r.allotments.confirmDevice('device1',[{resourcePoolId:poolId,amount:2}],['h1','h2'].map(holderInstanceId=>({groupId:'g1',holderInstanceId,appInstanceId:null})));
  await dir.ingest(peer,a);await dir.ingest({...peer,holderInstanceId:'h2'},b);
  assert.equal((await dir.snapshot('g1','p1',1,policy)).resources.find(r=>r.resourcePoolId===poolId).available,1,'one occupied App leaves the other physical slot available');
  b.sequence++;b.pools[0].occupied.value=1;await dir.ingest({...peer,holderInstanceId:'h2'},b);
  assert.equal((await dir.snapshot('g1','p1',1,policy)).resources.find(r=>r.resourcePoolId===poolId).available,0,'two occupied holders exhaust the device');
  a.sequence++;a.inFlight=[{attemptId:'running',targetId:a.executors[0].target.targetId,state:'RUNNING',resources:[{resourcePoolId:poolId,amount:1}],elapsed:{...pool.occupied,unit:'ms',value:10},remaining:{...pool.occupied,unit:'ms',value:200}}];await dir.ingest(peer,a);
  const projected=await dir.snapshot('g1','p1',1,policy);
  assert.equal(projected.resources.find(r=>r.resourcePoolId===poolId).available,1,'only the reconciled holder projects a future release');
  assert.equal(projected.inFlight.length,1);assert.equal(projected.inFlight[0].releaseAt.value,pool.occupied.sampledAt+200);
  a.sequence++;a.inFlight=[];await dir.ingest(peer,a);
  assert.equal((await dir.snapshot('g1','p1',1,policy)).resources.find(r=>r.resourcePoolId===poolId).available,0,'unexplained occupied units stay deducted');
  const invite=await r.auth.invite('g2','p2','device1',r.url),other=await r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:'h3'});
  await r.allotments.confirmDevice('device1',[{resourcePoolId:poolId,amount:3}],[{groupId:'g1',holderInstanceId:'h1',appInstanceId:null},{groupId:'g1',holderInstanceId:'h2',appInstanceId:null},{groupId:'g2',holderInstanceId:'h3',appInstanceId:null}]);
  await r.allotments.issue(other.peer,{ledgerEpoch:1,leaseRequestId:'hidden',leaseMs:30000,base:[],extra:[{resourcePoolId:poolId,amount:1}]});
  assert.equal((await dir.snapshot('g1','p1',1,policy)).resources.find(r=>r.resourcePoolId===poolId).available,0,'another group without a fresh profile retains its whole reservation');
 }finally{await r.close();}
});
test('expired sibling profile retains its whole reservation without expiring fresh device capacity',async()=>{
 const r=await runtime();try{
  let now=100;const dir=new DeviceDirectory(r.db,'SIMULATED',()=>now),stale=fixture(),fresh=fixture();
  const poolId=fresh.pools[0].resourcePoolId;
  for(const p of [stale,fresh]){p.pools[0].total.value=4;p.pools[0].contributionLimit=4;p.pools[0].ownerReserved=0;p.pools[0].occupied.value=0;}
  stale.holderInstanceId='h2';stale.deviceInstanceId='instance2';stale.executors.forEach(e=>e.target.targetId+='-stale');
  await dir.ingest({...peer,holderInstanceId:'h2'},stale);await qualifySimulated(r.db,stale);
  now=1200;
  const refresh=value=>{if(value&&typeof value==='object'){if('sampledAt' in value)value.sampledAt=now;for(const child of Object.values(value))refresh(child);}};
  refresh(fresh);await dir.ingest(peer,fresh);await qualifySimulated(r.db,fresh);
  await r.allotments.confirmDevice('device1',[{resourcePoolId:poolId,amount:4}],['h1','h2'].map(holderInstanceId=>({groupId:'g1',holderInstanceId,appInstanceId:null})));
  assert.equal((await dir.snapshot('g1','p1',1,policy)).resources.find(p=>p.resourcePoolId===poolId).available,null,'unreserved stale holder remains unknown');
  const invite=await r.auth.invite('g1','p2','device1',r.url),other=await r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:'h2'});
  await r.allotments.issue(other.peer,{ledgerEpoch:1,leaseRequestId:'stale-reservation',leaseMs:30000,base:[],extra:[{resourcePoolId:poolId,amount:2}]});
  const snapshot=await dir.snapshot('g1','p1',2,policy),pool=snapshot.resources.find(p=>p.resourcePoolId===poolId);
  assert.equal(pool.available,2,'whole dormant reservation is retained, even with last reported occupancy zero');
  assert.equal(pool.observedAt,1200);assert.ok(snapshot.candidates.some(c=>c.holderInstanceId==='h1'));assert.ok(snapshot.candidates.every(c=>c.holderInstanceId!=='h2'));
 }finally{await r.close();}
});

test('an overdue non-interruptible shared pool holder has no promised release time',()=>{
 const {availability}=require('@harmony/scheduler-core');
 const p=structuredClone(require('../../../contracts/scheduling/v2/fixtures/t2/valid/DeviceProfile.json')),e=p.executors[0];
 const pool=p.pools.find(x=>x.resourcePoolId==='cpu1');
 pool.admissionLimit.value=1;pool.occupied.value=1;
 e.contract.interruptibility='NON_INTERRUPTIBLE';e.contract.maxNonPreemptibleMs=200;
 const ms=value=>({value,source:'SIMULATED',unit:'ms',sampledAt:100,ttlMs:1000});
 p.inFlight=[{attemptId:'long',targetId:e.target.targetId,state:'RUNNING',resources:e.resources,elapsed:ms(100),remaining:ms(100)}];
 const before=availability(p,e,'REMOTE_INTERACTIVE',1,100);
 assert.equal(before.blockingReason,'NON_INTERRUPTIBLE_RUNNING');assert.equal(before.resourceWait.value,100);
 p.inFlight[0].elapsed.value=201;
 const late=availability(p,e,'REMOTE_INTERACTIVE',1,100);
 assert.equal(late.reason,'RESOURCE_CAPACITY');assert.equal(late.blockingReason,'RELEASE_OVERDUE');
 assert.equal(late.resourceWait.value,null);assert.equal(late.resourceWait.source,'UNKNOWN');
});

const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs');
const {runtime}=require('./helpers.cjs');
const {DeviceDirectory,executorIdentity}=require('../dist/directory');
const {qualifySimulated}=require('./fixtures.cjs');
const fixture=()=>JSON.parse(fs.readFileSync('../../contracts/scheduling/v2/fixtures/t2/valid/DeviceProfile.json'));
const peer={groupId:'g1',holderInstanceId:'h1',deviceId:'device1',principalId:'p1',credentialId:'c1'};
const policy={minimumBattery:20,maximumTemperature:3,allowMetered:false,priority:'REMOTE_INTERACTIVE',requireForeground:true};
test('profile evidence, identity and revision are validated; discovery cannot authorize business work',async()=>{
 const r=await runtime();let now=100;
 try{
  const dir=new DeviceDirectory(r.db,'SIMULATED',()=>now),p=fixture();await dir.ingest(peer,p);
  assert.equal((await dir.snapshot('g1','p1',1,policy)).candidates.length,0);
  const id=JSON.stringify(['g1','h1','target1']);
  // A qualified test fixture stands in for B11, explicitly in the simulated domain.
  await qualifySimulated(r.db,p);
  assert.equal((await dir.snapshot('g1','p1',1,policy)).candidates.length,1);
  now=1200;assert.equal((await dir.snapshot('g1','p1',1,policy)).candidates.length,0);now=100;
  await assert.rejects(dir.ingest({...peer,deviceId:'different'},p),/PROFILE_INVALID/);
  const changed=structuredClone(p);changed.ownerActivity.value='ACTIVE';await assert.rejects(dir.ingest(peer,changed),/PROFILE_REPLAY/);
  changed.sequence=2;await dir.ingest(peer,changed);assert.equal((await dir.snapshot('g1','p1',2,policy)).candidates.length,0);
  const fake=fixture();fake.sequence=3;fake.ownerActivity.source='MEASURED';await assert.rejects(dir.ingest(peer,fake),/DOMAIN/);
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
  const invite=await r.auth.invite('g2','p2','device1',r.url),other=await r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:'h3'});
  await r.allotments.confirmDevice('device1',[{resourcePoolId:poolId,amount:3}],[{groupId:'g1',holderInstanceId:'h1',appInstanceId:null},{groupId:'g1',holderInstanceId:'h2',appInstanceId:null},{groupId:'g2',holderInstanceId:'h3',appInstanceId:null}]);
  await r.allotments.issue(other.peer,{ledgerEpoch:1,leaseRequestId:'hidden',leaseMs:30000,base:[],extra:[{resourcePoolId:poolId,amount:1}]});
  assert.equal((await dir.snapshot('g1','p1',1,policy)).resources.find(r=>r.resourcePoolId===poolId).available,0,'another group without a fresh profile retains its whole reservation');
 }finally{await r.close();}
});

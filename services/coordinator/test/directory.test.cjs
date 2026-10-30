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

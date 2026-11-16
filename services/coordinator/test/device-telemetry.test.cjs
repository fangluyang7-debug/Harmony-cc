const {test}=require('node:test'),assert=require('node:assert/strict'),https=require('node:https'),fs=require('node:fs'),{randomUUID}=require('node:crypto');
const {DeviceTelemetryStore}=require('../dist/device-telemetry');
const peer={groupId:'g',deviceId:'d',holderInstanceId:'h',principalId:'p',credentialId:'c'};
const sample=now=>({sampledAt:now,cpuPercent:0,memoryTotalBytes:1024,memoryUsedBytes:512,batteryPercent:null,powerStatus:'NO_BATTERY',gpuPercent:0,gpuTemperatureC:47,gpuName:'NVIDIA RTX 4060',sensorSampledAt:now});
test('device observations preserve zero, isolate holders/groups, reject App writes and expire without scheduling',()=>{
 let now=100000;const store=new DeviceTelemetryStore(()=>now);store.report(peer,sample(now));
 assert.equal(store.read('g','d',['h']).sample.gpuPercent,0);
 assert.equal(store.read('g','d',['other']),null);assert.equal(store.read('other','d',['h']),null);
 assert.throws(()=>store.report({...peer,app:{}},sample(now)),/FORBIDDEN/);
 assert.throws(()=>store.report(peer,{...sample(now),gpuTemperatureC:999}),/INVALID/);
 store.report(peer,{...sample(now-1),gpuTemperatureC:50});assert.equal(store.read('g','d',['h']).sample.gpuTemperatureC,47);
 now+=15000;assert.equal(store.read('g','d',['h']),null);
});
test('sensor presentation preserves Harmony levels, shows Windows battery absence and actual GPU temperature',async()=>{
 const {deviceSignals}=await import('../../../apps/team-space-web/dispatch-view.mjs');
 const now=100000,p={holderInstanceId:'h',ownerActivity:null,battery:null,temperature:null};
 const o={holderInstanceId:'h',receivedAt:now,sample:sample(now)};
 let v=deviceSignals(p,o,now);assert.equal(v.find(x=>x.label==='GPU 温度').text,'47 °C');
 assert.equal(v.find(x=>x.label==='GPU 实测负载').text,'0%');assert.equal(v.find(x=>x.label==='电池 / 供电').text,'无电池 · 不适用');
 assert.equal(v.find(x=>x.label==='系统热等级').text,'系统未提供');
 o.sample.powerStatus='DISCHARGING';o.sample.batteryPercent=0;
 assert.match(deviceSignals(p,o,now)[1].text,/^0%/);
 o.sample.sensorSampledAt=1;assert.equal(deviceSignals(p,o,now)[1].text,'等待电源采样');
 assert.equal(deviceSignals(p,o,now+15000).some(x=>x.label==='GPU 温度'),false);
 const thermal={value:0,source:'SIMULATED',sampledAt:now,ttlMs:30000,unit:'level'};
 assert.equal(deviceSignals({...p,temperature:thermal},null,now)[2].text,'0 级');
});
test('authenticated Windows report reaches authorized dashboard without changing scheduling state',async()=>{
 const {runtime}=require('./helpers.cjs');const r=await runtime();let cookie='';
 const request=(route,body,token)=>new Promise((resolve,reject)=>{
  const q=https.request(r.url+route,{ca:r.identity.cert,method:body?'POST':'GET',headers:{Cookie:cookie,...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json'}},res=>{
   if(res.headers['set-cookie'])cookie=res.headers['set-cookie'][0].split(';')[0];let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));
  });q.on('error',reject);q.end(body?JSON.stringify(body):undefined);
 });
 try{
  const user=(await request('/v2/spaces/register',{account:randomUUID(),password:'test-password',name:'Owner'})).body.user;
  const group=(await request('/v2/spaces/',{name:'Sensor test'})).body.id;
  const p=JSON.parse(fs.readFileSync('../../contracts/scheduling/v2/fixtures/t2/valid/DeviceProfile.json'));
  const now=Date.now();p.ownerActivity.sampledAt=now;p.ownerActivity.ttlMs=30000;
  const invite=await r.auth.invite(group,user.id,p.deviceId,r.url);
  const paired=await r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:p.holderInstanceId});
  await r.directory.ingest(paired.peer,p);
  const before=await Promise.all([r.db.device.count(),r.db.attempt.count(),r.db.outbox.count()]);
  assert.equal((await request('/v2/devices/me/telemetry',sample(now))).status,401);
  const accepted=await request('/v2/devices/me/telemetry',sample(now),paired.credential);assert.equal(accepted.status,201);assert.equal(accepted.body.accepted,true);
  const view=await request('/v2/spaces/'+group+'/telemetry');assert.equal(view.status,200);
  assert.equal(view.body.devices.find(d=>d.id===p.deviceId).telemetry.sample.gpuTemperatureC,47);
  assert.deepEqual(await Promise.all([r.db.device.count(),r.db.attempt.count(),r.db.outbox.count()]),before);
 }finally{await r.close();}
});

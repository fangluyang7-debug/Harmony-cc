const {test}=require('node:test'),assert=require('node:assert/strict'),{fixture}=require('./native-coordinator-fixture.cjs');
test('device observation accepts measured data, binds identity and rejects invented percentages',async()=>{
 const f=fixture(),{CoordinatorActivity}=f.load('apps/harmony/scheduler/src/main/ets/v2/coordinator/CoordinatorActivity.ets'),a=new CoordinatorActivity(f.database),peer={groupId:'g',deviceId:'pc',holderInstanceId:'holder',app:null};
 const input={sampledAt:Date.now(),cpuPercent:43,memoryUsedBytes:1024,memoryTotalBytes:4096,batteryPercent:null,powerStatus:'NO_BATTERY',gpuPercent:72,gpuTemperatureC:65,gpuName:'GPU',sensorSampledAt:Date.now()};
 await a.device(peer,input);const row=JSON.parse(f.sql.prepare('SELECT metadataJson FROM Device').get().metadataJson);assert.equal(row.deviceId,'pc');assert.equal(row.sample.batteryPercent,null);assert.equal(row.sample.gpuPercent,72);
 await assert.rejects(a.device(peer,{...input,cpuPercent:101}));await assert.rejects(a.device(peer,{...input,sampledAt:1}));await assert.rejects(a.device({...peer,app:{}},input));
});
test('overview maps dispatch evidence to actual devices and retains short completed steps',async()=>{
 const f=fixture(),{CoordinatorDatabase}=f.load('apps/harmony/scheduler/src/main/ets/v2/coordinator/CoordinatorDatabase.ets'),db=new CoordinatorDatabase({});db.transaction=f.database.transaction;
 for(const [id,holder] of [['phone','h1'],['pc-b','h2']]){f.device(id,holder);f.sql.prepare('INSERT INTO Credential (id,groupId,holderInstanceId,tokenHash,revoked,revision,metadataJson) VALUES (?,?,?,?,0,1,?)').run(holder,'g',holder,holder,'{}');}
 const job={state:'SUCCEEDED',traceId:'trace',createdAt:1000,offeredAt:1100,acceptedAt:1120,settledAt:1130,decision:JSON.stringify({decision:{reason:'LOWEST_COST'}}),offer:{task:{originDeviceId:'phone',nodeId:'price-ranking',contract:{capability:'catalog.filter.v1'}},target:{deviceId:'pc-b',backend:'CPU'}}};
 f.sql.prepare('INSERT INTO CpuJob (id,groupId,principalId,sourceHolderId,state,metadataJson) VALUES (?,?,?,?,?,?)').run('job','g','p','h1','SUCCEEDED',JSON.stringify(job));
 const row=(await db.overview()).tasks[0];assert.equal(row.deviceId,'pc-b');assert.match(row.detail,/phone → 执行 pc-b/);assert.match(row.detail,/接单至结算 10 ms/);assert.match(row.detail,/LOWEST_COST/);assert.equal(row.kind,'DISPATCH');assert.equal(row.state,'SUCCEEDED');
});

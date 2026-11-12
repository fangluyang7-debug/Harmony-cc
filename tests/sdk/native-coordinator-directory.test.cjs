const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {fixture}=require('./native-coordinator-fixture.cjs');
test('native directory separates groups and excludes devices that left their installation membership',async()=>{
 const f=fixture(),directory=new (f.load('apps/harmony/scheduler/src/main/ets/v2/coordinator/CoordinatorDirectory.ets').CoordinatorDirectory)(f.database);
 const profile=JSON.parse(fs.readFileSync('contracts/scheduling/v2/fixtures/t2/valid/DeviceProfile.json'));profile.domain='REAL';
 const insert=(group,device,domain='REAL')=>f.sql.prepare('INSERT INTO DeviceInstance (id,groupId,revision,metadataJson) VALUES (?,?,1,?)').run(JSON.stringify(['profile',group,device]),group,JSON.stringify({...profile,deviceId:device,domain,executors:profile.executors.map(e=>({...e,target:{...e.target,deviceId:device}}))}));
 insert('g','live');insert('other','other');insert('g','retired');insert('g','sim','SIMULATED');
 const record=(id,value)=>f.sql.prepare('INSERT INTO Device (id,groupId,revision,metadataJson) VALUES (?, ?,1,?)').run(JSON.stringify(id),'g',JSON.stringify(value));
 record(['space-device-installation','retired'],{installationId:'install'});
 record(['space-installation','install'],{deviceId:'replacement'});
 assert.deepEqual((await directory.profiles('g')).map(p=>p.deviceId),['live']);
 assert.deepEqual((await directory.profiles('other')).map(p=>p.deviceId),['other']);
});

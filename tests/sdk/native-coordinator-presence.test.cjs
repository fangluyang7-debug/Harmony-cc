const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {fixture}=require('./native-coordinator-fixture.cjs');
test('native overview uses live control and fresh foreground profiles, retaining registration across disconnect/reconnect',async()=>{
 const f=fixture(),{CoordinatorDatabase}=f.load('apps/harmony/scheduler/src/main/ets/v2/coordinator/CoordinatorDatabase.ets');
 const db=new CoordinatorDatabase({});db.transaction=f.database.transaction;
 f.device('device1','h1');
 assert.equal((await db.overview()).devices.length,0);
 const p=JSON.parse(fs.readFileSync('contracts/scheduling/v2/fixtures/t2/valid/DeviceProfile.json'));
 p.domain='REAL';const now=Date.now();
 function measure(v){if(!v||typeof v!=='object')return;if('sampledAt' in v){v.sampledAt=now;v.ttlMs=60000;if(v.source==='SIMULATED')v.source='MEASURED';}else Object.values(v).forEach(measure);}
 measure(p);
 const key=JSON.stringify(['profile','g',p.holderInstanceId]);
 f.sql.prepare('INSERT INTO DeviceInstance (id,groupId,revision,metadataJson) VALUES (?,?,?,?)').run(key,'g',1,JSON.stringify(p));
 const write=()=>f.sql.prepare('UPDATE DeviceInstance SET metadataJson=? WHERE id=?').run(JSON.stringify(p),key);
 assert.equal((await db.overview()).devices.length,0,'persisted profile alone is not a live connection');
 db.controlState=()=> 'ONLINE';assert.equal((await db.overview()).devices.length,1);
 db.controlState=()=> 'OFFLINE';assert.equal((await db.overview()).devices.length,0);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM SpaceDevice').get().n,1);
 db.controlState=()=> 'ONLINE';assert.equal((await db.overview()).devices.length,1);
 p.foreground.value='BACKGROUND';write();assert.equal((await db.overview()).devices.length,0);
 p.foreground.value='FOREGROUND';p.ownerActivity.sampledAt=now-60001;write();assert.equal((await db.overview()).devices.length,0);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM DeviceInstance').get().n,1);
});

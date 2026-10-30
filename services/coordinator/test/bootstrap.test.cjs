const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const https=require('node:https');
const {execFileSync}=require('node:child_process');
const {createCoordinator}=require('../dist/app');
const {loadConfig}=require('../dist/config');

function config(){const dir=fs.mkdtempSync(path.resolve('../../.test/coordinator-'));return loadConfig({COORDINATOR_DATA_DIR:dir,COORDINATOR_PORT:'0',COORDINATOR_DOMAIN:'SIMULATED'});}
function migrate(c){execFileSync(process.execPath,['scripts/migrate.cjs'],{cwd:path.resolve('.'),env:{...process.env,COORDINATOR_DATA_DIR:c.dataDir},stdio:'pipe'});}
async function get(runtime,route,trust=true){
  const port=runtime.app.getHttpServer().address().port;
  return new Promise((resolve,reject)=>{
    const req=https.get({hostname:'localhost',family:4,port,path:route,...(trust?{ca:runtime.identity.cert}:{})},res=>{
      let data='';res.on('data',chunk=>data+=chunk);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(data)}));
    });req.on('error',reject);
  });
}
fs.mkdirSync(path.resolve('../../.test'),{recursive:true});
test('isolated configuration starts TLS, gates ready on recovery and persists identity/epoch',async()=>{
  const c=config();migrate(c);let called=false;
  const runtime=await createCoordinator(c,async()=>{called=true;});
  let identity;
  try{
    await runtime.app.listen(0,'127.0.0.1');
    assert.equal((await get(runtime,'/v2/health/live')).status,200);
    assert.equal((await get(runtime,'/v2/health/ready')).status,503);
    await assert.rejects(get(runtime,'/v2/health/live',false));
    await runtime.restore();assert.equal(called,true);assert.equal(runtime.epoch,1);
    assert.deepEqual((await get(runtime,'/v2/health/ready')).data,{ready:true});
    await assert.rejects(createCoordinator(c),/COORDINATOR_LOCK_UNAVAILABLE/);
    identity=runtime.identity;
  }finally{await runtime.close();}
  const restarted=await createCoordinator(c);
  try{await restarted.restore();assert.equal(restarted.epoch,2);assert.deepEqual(restarted.identity,identity);}
  finally{await restarted.close();}
  const identityPath=path.join(c.dataDir,'identity.json'),backupPath=path.join(c.dataDir,'identity.saved');
  fs.renameSync(identityPath,backupPath);
  try{await assert.rejects(createCoordinator(c),/COORDINATOR_IDENTITY_LOST/);}
  finally{fs.renameSync(backupPath,identityPath);}
});
test('failed recovery stays unready and domain changes fail closed',async()=>{
  const c=config();migrate(c);
  const runtime=await createCoordinator(c,async()=>{throw new Error('RECOVERY_FAILED');});
  try{
    await runtime.app.listen(0,'127.0.0.1');await assert.rejects(runtime.restore(),/RECOVERY_FAILED/);
    assert.equal((await get(runtime,'/v2/health/ready')).status,503);
  }finally{await runtime.close();}
  await assert.rejects(createCoordinator({...c,domain:'REAL'}),/COORDINATOR_IDENTITY_CONFIG_MISMATCH/);
});
test('invalid configuration is rejected and default data directory is ignored by Git',()=>{
  assert.throws(()=>loadConfig({COORDINATOR_PORT:'NaN'}),/CONFIG_INVALID/);
  assert.throws(()=>loadConfig({COORDINATOR_CERTIFICATE_HOST:'host;bad'}),/CONFIG_INVALID/);
  const ignored=execFileSync('git',['check-ignore','services/coordinator/data/real/identity.json','services/coordinator/generated/client/index.js'],{cwd:path.resolve('../..'),encoding:'utf8'});
  assert.match(ignored,/identity.json/);assert.match(ignored,/index.js/);
});

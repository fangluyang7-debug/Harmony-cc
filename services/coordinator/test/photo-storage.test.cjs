const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {PhotoRuns}=require('../dist/photo-runs');
test('photo record replacement retries Windows sharing conflicts and preserves the previous revision on failure',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'harmony-photo-record-')),photo=new PhotoRuns(directory,{},'SIMULATED'),rename=fs.rename;
 try{
  const run=await photo.create('group','owner',{mode:'LOCAL_PROCESS_TEST',budgetMs:180000,inputs:[{name:'source.png',hash:'a'.repeat(64),bytes:10}]});
  let calls=0;
  fs.rename=async(...args)=>{calls++;if(calls<=2){assert.equal((await photo.read('group',run.id)).revision,0);throw Object.assign(Error('temporarily shared'),{code:'EPERM'});}return rename(...args);};
  const next=await photo.update('group',run.id,'owner',{revision:0,state:'RUNNING'});
  assert.equal(calls,3);assert.equal(next.revision,1);assert.equal((await photo.read('group',run.id)).state,'RUNNING');
  fs.rename=async()=>{throw Object.assign(Error('permanent failure'),{code:'EIO'});};
  await assert.rejects(photo.update('group',run.id,'owner',{revision:1,state:'FAILED'}),{code:'EIO'});
  assert.equal((await photo.read('group',run.id)).revision,1);
  assert.deepEqual((await fs.readdir(path.join(directory,'photo-runs/group'))).filter(f=>f.endsWith('.tmp')),[]);
  await assert.rejects(photo.result('group',run.id,0),/PHOTO_RESULT_PENDING/);
 }finally{fs.rename=rename;await fs.rm(directory,{recursive:true,force:true});}
});

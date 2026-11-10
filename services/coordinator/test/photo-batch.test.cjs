const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {PhotoRuns}=require('../dist/photo-runs');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
test('fan-in planning accounts for base64 padding without fractional work-key bytes',()=>{
 const {fanInByteBound}=require('../dist/workflow-jobs'),{encodeBundle}=require('@harmony/reference-capabilities');
 for(const sizes of [[17,53],[4097,401],[16384,63]]){
  const bundle=encodeBundle(sizes.map((size,i)=>({nodeId:'tile-'+i,schemaId:'photo.tile',data:Buffer.alloc(size,i)})));
  assert.ok(Number.isSafeInteger(fanInByteBound(sizes)));assert.ok(fanInByteBound(sizes)>=bundle.length);
 }
});
test('one verified image can be delivered during a running batch; unverified and foreign writes are refused',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'harmony-photo-batch-')),photo=new PhotoRuns(directory,{},'SIMULATED');
 try{
  const bytes=Buffer.from('input'),output=Buffer.from('actual-result'),product=Buffer.from(JSON.stringify({hash:hash(output),image:output.toString('base64')}));
  let run=await photo.create('group','owner',{mode:'LOCAL_PROCESS_TEST',budgetMs:180000,inputs:[0,1].map(i=>({name:'photo-'+i,hash:hash(bytes),bytes:bytes.length}))});
  await assert.rejects(photo.preview('group',run.id,'another',0,bytes),/FORBIDDEN/);
  await assert.rejects(photo.preview('group',run.id,'owner',0,Buffer.from('wrong')),/PHOTO_INPUT_INVALID/);
  await photo.preview('group',run.id,'owner',0,bytes);assert.deepEqual(await photo.input('group',run.id,0),bytes);
  await fs.writeFile(path.join(directory,'photo-runs/group',run.id+'.json.result-0'),product);
  run=await photo.update('group',run.id,'owner',{revision:0,state:'RUNNING'});
  await assert.rejects(photo.result('group',run.id,0),/PHOTO_RESULT_PENDING/);
  photo.view=async()=>({workflows:[{imageIndex:0,state:'RUNNING',nodes:[{committed:false}]}]});
  await assert.rejects(photo.update('group',run.id,'owner',{revision:1,deliveredImage:{imageIndex:0,hash:hash(output)}}),/NOT_COMMITTED/);
  photo.view=async()=>({workflows:[{imageIndex:0,state:'SUCCEEDED',nodes:[{committed:true}]}]});
  await assert.rejects(photo.update('group',run.id,'owner',{revision:1,deliveredImage:{imageIndex:0,hash:'wrong'}}),/PHOTO_RESULT_HASH/);
  run=await photo.update('group',run.id,'owner',{revision:1,deliveredImage:{imageIndex:0,hash:hash(output)}});
  assert.equal(run.state,'RUNNING');assert.equal(run.deliveries.length,1);assert.deepEqual(await photo.result('group',run.id,0),product);
  await photo.update('group',run.id,'owner',{revision:2,state:'FAILED'});
  assert.deepEqual(await photo.result('group',run.id,0),product);await assert.rejects(photo.result('group',run.id,1),/PHOTO_RESULT_PENDING/);
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('gallery completion belongs to an individual receipt, not the entire batch',async()=>{
 const {imageState,terminalRun}=await import('../../../apps/team-space-web/photo-gallery.mjs');
 const r={state:'RUNNING',images:[{imageIndex:0,delivered:true}],workflows:[{imageIndex:1,state:'RUNNING',nodes:[{state:'ACCEPTED',capability:'photo.enhance.v1'}]}]};
 assert.equal(terminalRun(r),false);assert.equal(imageState(r,0).kind,'done');assert.equal(imageState(r,1).label,'AI 增强中');assert.equal(imageState(r,2).kind,'waiting');
 assert.equal(imageState({...r,state:'FAILED'},0).kind,'done');assert.equal(imageState({...r,state:'CANCELLED'},2).label,'已取消');
});

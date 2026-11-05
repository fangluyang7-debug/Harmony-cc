const {test}=require('node:test'),assert=require('node:assert/strict');
const {builtinReferencePacks,packDigest,validateCoverage,frozenPack,tolerancePack,propertyPack}=require('@harmony/reference-capabilities');
const {executeCpu}=require('../../pc-agent/dist/cpu-engine');
test('installed text, vector and crop suites bind each contract case to output or a settled rejection',async()=>{
 for(const pack of await builtinReferencePacks()){
  validateCoverage(pack.manifest,pack.cases);
  assert.throws(()=>validateCoverage(pack.manifest,pack.cases.filter(c=>c.expect.kind!=='REJECT')),/TRUSTED_PACK_COVERAGE/);
  const altered={...pack,cases:pack.cases.map((c,i)=>i?c:{...c,expected:'different answer'})};
  assert.notEqual(packDigest(pack),packDigest(altered));
  for(const c of pack.cases){
   const run=executeCpu(pack.manifest.contract.capability,c.input,JSON.parse(c.parameters),c.config,new AbortController().signal);
   if(c.expect.kind==='REJECT'){await assert.rejects(run,{message:c.expect.errorCode});continue;}
   assert.ok(await pack.evaluate(c,(await run).bytes)>=pack.manifest.qualityThreshold,pack.manifest.packId+' '+c.id);
  }
 }
});
test('reference scoring helpers distinguish exact, continuous and conditional invariant checks',()=>{
 const frozen=frozenPack(i=>({value:i}));assert.equal(frozen(2,{value:2}),1);assert.equal(frozen(2,{value:3}),0);
 const tolerance=tolerancePack((i,o)=>1-Math.abs(i-o));assert.equal(tolerance(1,.75),.75);assert.equal(tolerance(1,3),0);
 const property=propertyPack([{id:'double',version:1,precondition:i=>i>=0,check:(i,o)=>o===2*i}]);
 assert.equal(property(2,4),1);assert.equal(property(2,1),0);assert.equal(property(-1,-2),0);
});

test('versioned encoding suites require genuine boundary inputs and declared expected vectors',async()=>{
 const {loadImageEncodingPack,isLegacyEncodingSuite}=require('@harmony/reference-capabilities');
 const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),sharp=require('sharp');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'coverage-encode-')),file=path.join(dir,'suite.json');
 try{
  const jpeg=await sharp({create:{width:1,height:1,channels:3,background:{r:255,g:0,b:0}}}).jpeg().toBuffer();
  const model={modelId:'fixture',version:'1',weightsHash:'a'.repeat(64),preprocessVersion:'rgb',embeddingKind:'image',dimension:2,dtype:'float32',normalization:'l2'};
  const positive={id:'jpeg',imageBase64:jpeg.toString('base64'),vector:[1,0],covers:['schema:image.raster','model:manifest','encoder:jpeg']};
  const suite={model,executorIds:['pc.image.cpu.v1'],memoryBytes:1024,minimumCosine:.98,coverageVersion:1,cases:[positive]};
  const load=async()=>{await fs.writeFile(file,JSON.stringify(suite));return loadImageEncodingPack(file);};
  await assert.rejects(load(),/TRUSTED_PACK_COVERAGE/);
  const max={...positive,id:'max',covers:['schema:image.raster','boundary:max']};
  suite.cases.push(max,{id:'empty',imageBase64:'',rejectCode:'IMAGE_INVALID',covers:['schema:image.raster','boundary:empty']});
  await assert.rejects(load(),/TRUSTED_PACK_COVERAGE/);
  const ceiling=Buffer.alloc(8388608);jpeg.copy(ceiling);max.imageBase64=ceiling.toString('base64');
  const pack=await load();assert.equal(isLegacyEncodingSuite(pack),false);
  assert.equal(await pack.evaluate(pack.cases[0],Buffer.from(JSON.stringify({model,vector:[1,0]}))),1);
  assert.equal(await pack.evaluate(pack.cases[0],Buffer.from(JSON.stringify({model,vector:[0,1]}))),0);
 }finally{await fs.rm(file,{force:true});await fs.rmdir(dir);}
});

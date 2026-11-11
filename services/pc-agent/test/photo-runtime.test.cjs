const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process'),sharp=require('sharp');
const configPath=path.resolve(__dirname,'../../../.test/photo-tools/runtime.json'),installed=fs.existsSync(configPath);
if(installed){const c=JSON.parse(fs.readFileSync(configPath));process.env.HARMONY_PHOTO_MODEL=c.model;process.env.HARMONY_PHOTO_RUNNER=c.runner;}
test('Windows photo runtime creates the requested OpenMP team',{skip:!installed||process.platform!=='win32'},()=>{
 for(const threads of [1,2,4,8]){
  const r=spawnSync(process.env.HARMONY_PHOTO_RUNNER,['--runtime-info',String(threads)],{encoding:'utf8',windowsHide:true});
  assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),{openmp:true,requestedThreads:threads,actualThreads:threads});
 }
});
test('raw output cropping preserves inferred pixels for single and multi-thread execution',{skip:!installed,timeout:120000},async()=>{
 const {infer}=require('../dist/executors/photo');
 const pixels=Buffer.from(Array.from({length:8*6*3},(_,i)=>(i*17+11)%256));
 const input=await sharp(pixels,{raw:{width:8,height:6,channels:3}}).png().toBuffer(),crop={left:4,top:4,width:20,height:16};
 const full=await infer(input,1),expected=await sharp(full).extract(crop).raw().toBuffer();
 for(const threads of [1,2,4,8]){
  const output=await infer(input,threads,'CPU',undefined,undefined,crop),{data,info}=await sharp(output).raw().toBuffer({resolveWithObject:true});
  assert.equal(info.width,crop.width);assert.equal(info.height,crop.height);assert.equal(data.length,expected.length);
  assert.ok(Math.max(...data.map((v,i)=>Math.abs(v-expected[i])))<=1,'same model/pixels, within 1 RGB rounding level');
 }
});

test('persistent native worker reuses model but computes each new input and settles cancellation',{skip:!installed,timeout:120000},async()=>{
 const {executeCpu}=require('../dist/cpu-engine'),{photoPacks}=require('@harmony/reference-capabilities');
 const pack=photoPacks().find(p=>p.manifest.contract.capability==='photo.enhance.v1'),sample=pack.cases.find(c=>c.id==='fused-prepare-threads-4');
 const run=(input,signal=new AbortController().signal)=>executeCpu('photo.enhance.v1',input,JSON.parse(sample.parameters),sample.config,signal);
 const first=await run(sample.input),second=await run(sample.input);assert.equal(first.hash,second.hash);assert.ok(await pack.evaluate(sample,second.bytes)>=.99);
 const different=JSON.parse(sample.input),image=await sharp(Buffer.from(different.image,'base64')).negate().png().toBuffer();different.image=image.toString('base64');different.hash=require('node:crypto').createHash('sha256').update(image).digest('hex');
 assert.notEqual((await run(Buffer.from(JSON.stringify(different)))).hash,first.hash,'new input is actually inferred');
 const big=pack.cases.find(c=>c.id==='representative-pixels-threads-4'),abort=new AbortController();
 const task=executeCpu('photo.enhance.v1',big.input,JSON.parse(big.parameters),big.config,abort.signal);setTimeout(()=>abort.abort(),50);
 await assert.rejects(task,/CANCELLED_SETTLED/);assert.equal((await run(sample.input)).hash,first.hash,'worker restarts cleanly after abort');
});

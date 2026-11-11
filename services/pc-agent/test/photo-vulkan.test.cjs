const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {photoPacks}=require('@harmony/reference-capabilities');
const {enhancementInput,enhanceOn}=require('../dist/executors/photo');
const pack=photoPacks().find(p=>p.manifest.contract.capability==='photo.enhance.v1');

test('CPU and GPU share fused input and pixel work validation',async()=>{
 for(const sample of pack.cases.filter(c=>c.config.threads===1)){
  if(sample.expect.kind==='REJECT')await assert.rejects(enhancementInput(sample.input,JSON.parse(sample.parameters),sample.config),/PHOTO_INVALID/);
  else {const prepared=await enhancementInput(sample.input,JSON.parse(sample.parameters),sample.config);assert.equal(JSON.parse(prepared).stage,'prepared');}
 }
});

test('persistent Vulkan engine reuses only the model, handles new inputs and exits cleanly',{
 skip:!process.env.HARMONY_PHOTO_VULKAN_TEST,timeout:180000
},async()=>{
 const c=JSON.parse(fs.readFileSync(process.env.HARMONY_PHOTO_VULKAN_TEST));
 const path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process'),{once}=require('node:events');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'photo-gpu-reuse-'));
 const child=spawn(c.vulkan,['--server'],{windowsHide:true,env:{...process.env,HARMONY_PHOTO_GPU_ID:'0'}});
 let pending='',errors='';const replies=[],waiting=[];
 child.stdout.on('data',b=>{pending+=b.toString();while(pending.includes('\n')){const i=pending.indexOf('\n'),line=pending.slice(0,i);pending=pending.slice(i+1);const next=waiting.shift();next?next(line):replies.push(line);}});
 child.stderr.on('data',b=>{errors+=b.toString();});
 const exit=once(child,'close');
 const command=async(i)=>{
  const input=path.join(dir,'in-'+i+'.rgb'),output=path.join(dir,'out-'+i+'.rgb'),header=Buffer.alloc(8);header.writeUInt32LE(8);header.writeUInt32LE(6,4);
  fs.writeFileSync(input,Buffer.concat([header,Buffer.alloc(8*6*3,i*83)]));
  child.stdin.write([path.join(c.model,'realesrgan-x4plus.param'),path.join(c.model,'realesrgan-x4plus.bin'),input,output,'1','VULKAN'].map(JSON.stringify).join(' ')+'\n');
  const line=replies.length?replies.shift():await new Promise(resolve=>waiting.push(resolve));
  assert.equal(line.trim().split('\t').pop(),'0',errors);return {timing:JSON.parse(line.split('\t')[0]),bytes:fs.readFileSync(output)};
 };
 try{
  const first=await command(1),second=await command(2),third=await command(1);
  assert.equal(first.timing.modelLoaded,true);assert.equal(second.timing.modelLoaded,false);assert.equal(third.timing.modelLoaded,false);
  assert.notDeepEqual(first.bytes,second.bytes);assert.deepEqual(first.bytes,third.bytes);
  console.log(JSON.stringify({test:'persistent-model-only',cold:first.timing,warm:second.timing}));
  child.stdin.end();assert.deepEqual(await exit,[0,null],'destroy cached pipelines before Vulkan shutdown');
 }finally{child.kill();await exit;fs.rmSync(dir,{recursive:true,force:true});}
});

test('shared-core Vulkan reference inference matches unchanged CPU fixtures',{
 skip:!process.env.HARMONY_PHOTO_VULKAN_TEST,timeout:180000
},async()=>{
 const c=JSON.parse(fs.readFileSync(process.env.HARMONY_PHOTO_VULKAN_TEST));
 process.env.HARMONY_PHOTO_MODEL=c.model;process.env.HARMONY_PHOTO_RUNNER=c.runner;
 process.env.HARMONY_PHOTO_VULKAN=c.vulkan;process.env.HARMONY_PHOTO_VULKAN_RUNTIME=c.vulkanRuntime;
 process.env.HARMONY_PHOTO_GPU_ID=process.env.HARMONY_PHOTO_GPU_ID||'0';
 for(const sample of pack.cases.filter(c=>c.config.threads===1&&c.expect.kind==='OUTPUT')){
  const input=await enhancementInput(sample.input,JSON.parse(sample.parameters),sample.config);
  const result=await enhanceOn(input,1,'VULKAN',AbortSignal.timeout(120000));
  const score=await pack.evaluate(sample,result.output);
  console.log(JSON.stringify({case:sample.id,backend:'VULKAN',score,threshold:pack.manifest.qualityThreshold}));
  assert.ok(score>=pack.manifest.qualityThreshold,sample.id+': '+score);
  assert.equal(JSON.parse(result.output).backend,'VULKAN');
 }
 const sample=pack.cases.find(c=>c.id==='representative-pixels'),input=await enhancementInput(sample.input,JSON.parse(sample.parameters),sample.config),abort=new AbortController();
 const pending=enhanceOn(input,1,'VULKAN',abort.signal);setTimeout(()=>abort.abort(),20);
 await assert.rejects(pending,/CANCELLED_SETTLED/);
 const restarted=await enhanceOn(input,1,'VULKAN',AbortSignal.timeout(120000));
 assert.ok(await pack.evaluate(sample,restarted.output)>=pack.manifest.qualityThreshold,'GPU worker restarts after actual process settlement');
});

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
});

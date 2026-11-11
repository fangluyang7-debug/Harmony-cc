const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {stagePhotoRuntime}=require('./lib/photo-runtime-package.cjs');
function runtime(options={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'photo-runtime-')),model=path.join(dir,'realesrgan/models'),vulkanDir=path.join(dir,'realesrgan');
 fs.mkdirSync(model,{recursive:true});
 for(const name of ['realesrgan-x4plus.param','realesrgan-x4plus.bin','manifest.json'])if(!options.dropModel||name!==options.dropModel)fs.writeFileSync(path.join(model,name),name);
 const runner=path.join(dir,'photo-runner-simd.exe');if(!options.noRunner)fs.writeFileSync(runner,'runner');
 const vulkan=path.join(vulkanDir,'realesrgan-ncnn-vulkan.exe');fs.writeFileSync(vulkan,'vulkan');
 if(!options.noOpenMp)fs.writeFileSync(path.join(vulkanDir,'vcomp140.dll'),'openmp');
 fs.writeFileSync(path.join(vulkanDir,'vulkan-1.dll'),'driver-provided');
 const config=path.join(dir,'runtime.json');
 fs.writeFileSync(config,JSON.stringify({model,runner,vulkan:options.noVulkan?undefined:vulkan,backend:'CPU',cpuRuntime:'runtime-dispatched-avx2-fma'}));
 return {dir,config,target:path.join(dir,'package/dist/photo')};
}

test('a complete runtime is staged with relative paths, the Vulkan engine and its OpenMP DLL',()=>{
 const r=runtime();
 const summary=stagePhotoRuntime(r.config,r.target);
 assert.deepEqual(summary,{model:'models',runner:'photo-runner-simd.exe',vulkan:'vulkan/realesrgan-ncnn-vulkan.exe',dlls:['vcomp140.dll']});
 const settings=JSON.parse(fs.readFileSync(path.join(r.target,'runtime.json'),'utf8'));
 assert.deepEqual(settings,{model:'models',runner:'photo-runner-simd.exe',vulkan:'vulkan/realesrgan-ncnn-vulkan.exe',backend:'CPU',cpuRuntime:'runtime-dispatched-avx2-fma'});
 for(const file of ['models/realesrgan-x4plus.bin','photo-runner-simd.exe','vulkan/realesrgan-ncnn-vulkan.exe','vulkan/vcomp140.dll'])assert.ok(fs.existsSync(path.join(r.target,file)),file);
 assert.ok(!fs.existsSync(path.join(r.target,'vulkan/vulkan-1.dll')),'the driver DLL is never shipped');
 fs.rmSync(r.dir,{recursive:true,force:true});
});

test('a CPU-only runtime is accepted; missing model, runner or OpenMP DLL fails the build',()=>{
 const cpu=runtime({noVulkan:true});
 assert.equal(stagePhotoRuntime(cpu.config,cpu.target).vulkan,null);
 fs.rmSync(cpu.dir,{recursive:true,force:true});
 for(const [options,pattern] of [[{dropModel:'realesrgan-x4plus.bin'},/model\/realesrgan-x4plus\.bin/],[{noRunner:true},/runner/],[{noOpenMp:true},/vcomp140\.dll/]]){
  const r=runtime(options);
  assert.throws(()=>stagePhotoRuntime(r.config,r.target),pattern);
  fs.rmSync(r.dir,{recursive:true,force:true});
 }
});

test('statically linked shared-core Vulkan runtime keeps its ABI and needs no legacy OpenMP DLL',()=>{
 const r=runtime({noOpenMp:true});const config=JSON.parse(fs.readFileSync(r.config));
 config.vulkanRuntime='harmony-raw-v1';fs.writeFileSync(r.config,JSON.stringify(config));
 stagePhotoRuntime(r.config,r.target);
 assert.equal(JSON.parse(fs.readFileSync(path.join(r.target,'runtime.json'))).vulkanRuntime,'harmony-raw-v1');
 fs.rmSync(r.dir,{recursive:true,force:true});
});

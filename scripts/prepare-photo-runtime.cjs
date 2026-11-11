// Installation only: public model/runtime downloads never happen in a task.
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process'),{createHash}=require('node:crypto');
const root=path.resolve(__dirname,'..'),tools=path.join(root,'.test/photo-tools'),windows=process.platform==='win32';
const weights={'realesrgan-x4plus.param':'35330ececcea33b6c397a72548e788d5d53becee4734c50b7fada36e89f10a86','realesrgan-x4plus.bin':'713ee713b0353afaa27976f0563a64a5043bd70b9bd8936c2e26e25ebcdbcddf'};
function run(command,args,options={}){const r=spawnSync(command,args,{cwd:root,windowsHide:true,stdio:'inherit',...options});if(r.error)throw r.error;if(r.status!==0)throw Error('PHOTO_INSTALL_FAILED: '+command);}
async function download(url,file){if(fs.existsSync(file))return;for(let i=0;i<3;i++){try{const r=await fetch(url,{signal:AbortSignal.timeout(180000)});if(!r.ok)throw Error('HTTP_'+r.status);fs.writeFileSync(file,Buffer.from(await r.arrayBuffer()));return;}catch(e){if(i===2)throw e;}}}
async function main(){
 fs.mkdirSync(tools,{recursive:true});
 if(!windows)throw Error('Set up ncnn and compile services/pc-agent/native/photo-runner.cpp for this platform; this bootstrap currently targets Windows.');
 const model=path.join(tools,'realesrgan/models');
 if(!fs.existsSync(model)){await download('https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip',path.join(tools,'realesrgan.zip'));run('powershell.exe',['-NoProfile','-Command','Expand-Archive -LiteralPath .test/photo-tools/realesrgan.zip -DestinationPath .test/photo-tools/realesrgan -Force']);}
 for(const [name,expected] of Object.entries(weights))if(createHash('sha256').update(fs.readFileSync(path.join(model,name))).digest('hex')!==expected)throw Error('PHOTO_MODEL_HASH: '+name);
 fs.writeFileSync(path.join(model,'manifest.json'),JSON.stringify({model:'realesrgan-x4plus',scale:4,source:'https://github.com/xinntao/Real-ESRGAN/releases/tag/v0.2.5.0',files:weights},null,2));
 if(!fs.existsSync(path.join(tools,'ncnn/.git')))run('git',['clone','--depth','1','--branch','20261020','https://github.com/Tencent/ncnn.git',path.join(tools,'ncnn')]);
 const commit=spawnSync('git',['-C',path.join(tools,'ncnn'),'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true});if(commit.stdout.trim()!=='7e36d25cb153092ba87a60530455c7376fedf452')throw Error('PHOTO_NCNN_REVISION');
 const cxx=process.env.CXX||'C:/msys64/mingw64/bin/g++.exe',cc=process.env.CC||'C:/msys64/mingw64/bin/gcc.exe',ninja=path.join(tools,'python/bin/ninja.exe');
 if(!fs.existsSync(ninja))run('py',['-3.11','-m','pip','install','ninja==1.13.2','--target',path.join(tools,'python'),'--disable-pip-version-check']);
 const scalar=process.argv.includes('--scalar'),simd=scalar?'OFF':'ON';
 const build=path.join(tools,scalar?'ncnn-build':'ncnn-simd-build'),env={...process.env,PATH:path.dirname(cxx)+path.delimiter+process.env.PATH};
 const log=fs.openSync(path.join(tools,'build.log'),'a');
 try{run('cmake',['-S',path.join(tools,'ncnn'),'-B',build,'-G','Ninja','-DCMAKE_MAKE_PROGRAM='+ninja,'-DCMAKE_C_COMPILER='+cc,'-DCMAKE_CXX_COMPILER='+cxx,'-DCMAKE_BUILD_TYPE=Release','-DNCNN_VULKAN=OFF','-DNCNN_BUILD_TOOLS=OFF','-DNCNN_BUILD_EXAMPLES=OFF','-DNCNN_BUILD_BENCHMARK=OFF','-DNCNN_BUILD_TESTS=OFF','-DNCNN_OPENMP=ON','-DNCNN_RUNTIME_CPU=ON','-DNCNN_AVX='+simd,'-DNCNN_AVX2='+simd,'-DNCNN_FMA='+simd,'-DNCNN_AVX512=OFF','-DNCNN_XOP=OFF','-DNCNN_FMA4=OFF','-DNCNN_AVXVNNI=OFF','-DNCNN_AVXNECONVERT=OFF'],{env,stdio:['ignore',log,log]});run('cmake',['--build',build,'-j','4'],{env,stdio:['ignore',log,log]});}finally{fs.closeSync(log);}
 const cache=fs.readFileSync(path.join(build,'CMakeCache.txt'),'utf8');
 if(!cache.includes('NCNN_OPENMP:BOOL=ON')||!cache.includes('OpenMP_CXX_FLAGS:STRING=-fopenmp'))throw Error('PHOTO_OPENMP_REQUIRED');
 const runner=path.join(tools,scalar?'photo-runner.exe':'photo-runner-simd.exe');run(cxx,['-fopenmp','-O3','-std=c++17','-static','-I'+path.join(tools,'ncnn/src'),'-I'+path.join(build,'src'),path.join(root,'services/pc-agent/native/photo-runner.cpp'),path.join(build,'src/libncnn.a'),'-o',runner],{env});
 const probe=spawnSync(runner,['--runtime-info','8'],{encoding:'utf8',windowsHide:true});
 if(probe.status!==0||JSON.parse(probe.stdout).actualThreads!==8)throw Error('PHOTO_OPENMP_PROBE_FAILED');
 if(process.argv.includes('--harmony')){const zip=path.join(tools,'ncnn-harmony.zip');await download('https://github.com/Tencent/ncnn/releases/download/20261020/ncnn-20261020-harmonyos.zip',zip);
  if(createHash('sha256').update(fs.readFileSync(zip)).digest('hex')!=='e69e804f6161e15be07cbc1087b4486b671cc89319250883abbb4430e70ddad4')throw Error('PHOTO_NCNN_ARCHIVE_HASH');
  run('powershell.exe',['-NoProfile','-Command','Expand-Archive -LiteralPath .test/photo-tools/ncnn-harmony.zip -DestinationPath .test/photo-tools/harmony -Force']);
 }
 fs.writeFileSync(path.join(tools,'runtime.json'),JSON.stringify({model,runner,vulkan:path.join(tools,'realesrgan/realesrgan-ncnn-vulkan.exe'),backend:'CPU',ncnnRevision:commit.stdout.trim(),cpuRuntime:scalar?'baseline-openmp':'runtime-dispatched-avx2-fma-openmp',limitations:['GPU backend must pass its own probe.','Per-tile OpenMP threads follow scheduler admission; no task inputs or results are cached.']},null,2));
 console.log('Photo CPU runtime prepared. Configuration: .test/photo-tools/runtime.json');
 if(process.argv.includes('--vulkan'))run(process.execPath,[path.join(root,'scripts/prepare-photo-vulkan.cjs')]);
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});module.exports={main,weights};

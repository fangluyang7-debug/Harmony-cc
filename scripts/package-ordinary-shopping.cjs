// Package already-built local API 24 debug HAPs; never installs or operates devices.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),resolve=p=>path.join(root,p),sha=p=>createHash('sha256').update(fs.readFileSync(resolve(p))).digest('hex');
const out=process.argv[2]||'dist/调度系统补丁-20261109-SoleAI日常购物',evidence=process.argv[3]||'artifacts/acceptance/2026-11-09/ordinary-shopping';
const logs=[['.test/shopping-har-build.log','har-build.log'],['.test/shopping-hap-build.log','agent-build.log'],['.test/review-soleai-build.log','soleai-build.log']];
for(const [source] of logs){const buffer=fs.readFileSync(resolve(source)),log=buffer.toString(buffer[0]===255&&buffer[1]===254?'utf16le':'utf8');if(!log.includes('BUILD SUCCESSFUL')||log.includes('hvigor ERROR:'))throw Error('BUILD_NOT_VERIFIED '+source);}
const sources=[];
function verifyTree(source,stage){for(const entry of fs.readdirSync(resolve(source),{withFileTypes:true})){const a=source+'/'+entry.name,b=stage+'/'+entry.name;if(entry.isDirectory())verifyTree(a,b);else{if(sha(a)!==sha(b))throw Error('STAGE_SOURCE_MISMATCH '+a);sources.push(a);}}}
verifyTree('apps/harmony/entry/src/main/ets','.test/s77-api24-harmony/entry/src/main/ets');
verifyTree('apps/harmony-agent/entry/src/main/ets','.test/s77-api24-harmony-agent/entry/src/main/ets');
for(const file of ['Index.ets','client/VisualReviewFlow.ets','client/VisualReviewNative.ets','host/NativeAgent.ets','host/NativePlatform.ets','platform/NativeInputStore.ets']){
 const source='apps/harmony/scheduler/src/main/ets/v2/'+file,stage='.test/s77-api24-har/scheduler/src/main/ets/v2/'+file;if(sha(source)!==sha(stage))throw Error('HAR_STAGE_MISMATCH '+file);sources.push(source);
}
for(const stage of ['harmony','harmony-agent']){const packs=JSON.parse(fs.readFileSync(resolve('.test/s77-api24-'+stage+'/entry/src/main/resources/rawfile/reference-packs.json')));if(!packs.some(p=>p.manifest.packId==='image.visual-match.v1'))throw Error('VISUAL_REFERENCE_MISSING '+stage);}
fs.mkdirSync(resolve(out),{recursive:true});fs.mkdirSync(resolve(evidence),{recursive:true});
const packages=[['.test/s77-api24-harmony-agent/entry/build/default/outputs/default/entry-default-signed.hap','03-Harmony-Device-Agent-API24-signed.hap'],['.test/s77-api24-harmony/entry/build/default/outputs/default/entry-default-signed.hap','04-SoleAI-API24-signed.hap']];
for(const [source,file]of packages)fs.copyFileSync(resolve(source),resolve(out+'/'+file));
fs.copyFileSync(resolve('docs/scheduler-v2/SOLEAI-MANUAL-DEMO.md'),resolve(out+'/手动验收操作单.md'));
fs.copyFileSync(resolve('scripts/install-soleai-review.ps1'),resolve(out+'/install-soleai-review.ps1'));
fs.writeFileSync(resolve(out+'/安装手机更新.cmd'),'@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-soleai-review.ps1" -PackageDir "%~dp0"\r\npause\r\n');
const manifest={builtAt:new Date().toISOString(),branch:execFileSync('git',['branch','--show-current'],{cwd:root,encoding:'utf8'}).trim(),head:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),dirtyWorktree:true,api:24,installed:false,
 scope:'Ordinary SoleAI shopping; one-time App enrollment; foreground App host; local/SDK photo evidence; automatic admission, actual placement recorded. No real-device speedup claim.',
 packages:packages.map(([source,file])=>({file,sha256:sha(source)})),sources:sources.map(file=>({file,sha256:sha(file)})),
 windowsBase:'dist/调度系统分发-20261109-shopping-visual-final',validation:{har:'PASS_API24',agent:'PASS_API24',soleai:'PASS_API24',hardware:'PENDING',api22:'NOT_VERIFIED',sdkTwoHost:'SIMULATED_WITH_TEST_ONLY_TARGET_COVERAGE',automaticSpeedup:'NOT_VERIFIED'}};
fs.writeFileSync(resolve(out+'/PATCH-MANIFEST.json'),JSON.stringify(manifest,null,2));
fs.copyFileSync(resolve(out+'/PATCH-MANIFEST.json'),resolve(evidence+'/PATCH-MANIFEST.json'));
for(const [source,file]of logs)fs.copyFileSync(resolve(source),resolve(evidence+'/'+file));
fs.writeFileSync(resolve(out+'/SHA256SUMS.txt'),fs.readdirSync(resolve(out)).filter(n=>n!=='SHA256SUMS.txt').map(n=>sha(out+'/'+n)+'  '+n).join('\n')+'\n');
console.log(JSON.stringify({out,packages:manifest.packages},null,2));

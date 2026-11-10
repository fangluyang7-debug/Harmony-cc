// Independent HAP build; the v1 product and its signing configuration remain untouched.
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
async function main(){
const root=path.resolve(__dirname,'..'),name=process.argv[2];
if(!['harmony-agent','harmony-har-probe','harmony-indexer','harmony','harmony-photo'].includes(name))throw Error('APP_NAME_REQUIRED');
const studio=process.env.DEVECO_STUDIO_HOME||'E:/DevEco/DevEco Studio',sdk=process.env.DEVECO_SDK_HOME||path.join(studio,'sdk');
const metadata=JSON.parse(fs.readFileSync(path.join(sdk,'default/sdk-pkg.json'))).data,sdkVersion=metadata.platformVersion+'('+metadata.apiVersion+')';
const requestedApi=process.env.HARMONY_BUILD_API??'22';if(!['22','24'].includes(requestedApi)||String(metadata.apiVersion)!==requestedApi||metadata.platformVersion!==(requestedApi==='24'?'6.1.1':'6.0.2'))throw Error('SDK_BASELINE_MISMATCH: default API 22; explicit HARMONY_BUILD_API=24 supports the existing API 24 acceptance environment');
const buildPrefix=process.env.HARMONY_BUILD_PREFIX??(requestedApi==='24'?'s77-api24-':'s2-');if(!/^[a-z0-9-]{1,40}$/.test(buildPrefix))throw Error('BUILD_PREFIX_INVALID');
const stage=path.join(root,'.test',buildPrefix+name),source=path.join(root,'apps',name);fs.mkdirSync(stage,{recursive:true});
// DevEco writes generated signing material into the stage profile. Keep it across regeneration and
// link it to the product: without the link hvigor logs "No signingConfig found for product default",
// skips SignHap and emits only an unsigned HAP, which devices reject with 9568320.
let signing=null;
try{const kept=JSON.parse(fs.readFileSync(path.join(stage,'build-profile.json5'),'utf8')).app.signingConfigs;if(Array.isArray(kept)&&kept.length)signing=kept;}catch{}
// A renamed bundle invalidates the old profile; hvigor would fail the whole build on the mismatch,
// so drop the stale config and build unsigned until DevEco generates one for the new bundle name.
if(signing){
  const bundle=JSON.parse(fs.readFileSync(path.join(source,'AppScope/app.json5'),'utf8').replace(/^\s*\/\/.*$/gm,'')).app.bundleName;
  let matches=false;try{matches=fs.readFileSync(signing[0].material?.profile??'').includes(bundle);}catch{}
  if(!matches){console.log('signing profile does not cover '+bundle+'; building unsigned, regenerate it in DevEco');signing=null;}
}
const filter=p=>!/[\\/](?:oh_modules|build|\.hvigor|node_modules)(?:[\\/]|$)/.test(p);
fs.cpSync(source,stage,{recursive:true,filter});
if(!process.argv.includes('--har'))require('./package-harmony-photo-runtime.cjs').packagePhotoRuntime(path.join(stage,'entry'),sdk);
const rootPackage=JSON.parse(fs.readFileSync(path.join(stage,'oh-package.json5'),'utf8'));
rootPackage.modelVersion=metadata.platformVersion;
fs.writeFileSync(path.join(stage,'oh-package.json5'),JSON.stringify(rootPackage));
fs.mkdirSync(path.join(stage,'hvigor'),{recursive:true});
fs.writeFileSync(path.join(stage,'hvigor/hvigor-config.json5'),JSON.stringify({modelVersion:metadata.platformVersion,dependencies:{}}));
fs.writeFileSync(path.join(stage,'build-profile.json5'),JSON.stringify({app:{signingConfigs:signing??[],products:[{name:'default',...(signing?{signingConfig:signing[0].name??'default'}:{}),targetSdkVersion:sdkVersion,compatibleSdkVersion:sdkVersion,runtimeOS:'HarmonyOS',buildOption:{strictMode:{caseSensitiveCheck:true,useNormalizedOHMUrl:true}}}],buildModeSet:[{name:'debug'},{name:'release'}]},modules:[{name:'entry',srcPath:'./entry',targets:[{name:'default',applyToProducts:['default']}]}]}));
if(signing)console.log('signing config '+signing[0].name+' kept from previous stage profile');
const dependency=process.argv.includes('--har')?path.join(root,'.test',buildPrefix+'har/scheduler/build/default/outputs/default/scheduler.har'):path.join(root,'apps/harmony/scheduler');
const modulePackage=JSON.parse(fs.readFileSync(path.join(source,'entry/oh-package.json5')));modulePackage.dependencies={scheduler:'file:'+dependency.replaceAll('\\','/')};
fs.writeFileSync(path.join(stage,'entry/oh-package.json5'),JSON.stringify(modulePackage));
// Both native applications consume exactly the same checked-in fixture file.
fs.mkdirSync(path.join(stage,'entry/src/main/resources/rawfile'),{recursive:true});
fs.copyFileSync(path.join(root,'tests/agent-conformance/fixtures/ledger-v2.json'),path.join(stage,'entry/src/main/resources/rawfile/ledger-v2.json'));
const references=require('@harmony/reference-capabilities');
const rawDir=path.join(stage,'entry/src/main/resources/rawfile');
const packs=(await references.builtinReferencePacks()).map(p=>({manifest:p.manifest,digest:references.packDigest(p),cases:p.cases.map(c=>({...c,input:c.input.toString('base64')}))}));
if(process.env.HARMONY_IMAGE_ENCODER_CONFIG){
 packs.push(await require('./package-harmony-image-encoder.cjs').packageImageEncoder(process.env.HARMONY_IMAGE_ENCODER_CONFIG,rawDir));
}else{
 for(const file of ['image-encoder.json','image-encoder.ms'])fs.rmSync(path.join(rawDir,file),{force:true});
}
if(process.env.HARMONY_PHOTO_MODEL&&process.env.HARMONY_NCNN_DIR){for(const ext of ['param','bin'])fs.copyFileSync(path.join(process.env.HARMONY_PHOTO_MODEL,'realesrgan-x4plus.'+ext),path.join(rawDir,'realesrgan-x4plus.'+ext));}
else{for(let i=packs.length-1;i>=0;i--)if(packs[i].manifest.contract.capability==='photo.enhance.v1')packs.splice(i,1);}
fs.writeFileSync(path.join(rawDir,'reference-packs.json'),JSON.stringify(packs));
const env={...process.env,DEVECO_SDK_HOME:sdk,JAVA_HOME:path.join(studio,'jbr'),PATH:path.join(studio,'tools/node')+path.delimiter+path.join(studio,'jbr/bin')+path.delimiter+process.env.PATH};
const node=path.join(studio,'tools/node/node.exe');
function run(args){const r=spawnSync(node,args,{cwd:stage,env,stdio:'inherit',windowsHide:true});if(r.error)throw r.error;if(r.status!==0)process.exit(r.status??1);}
console.log('HAP '+name+' SDK '+sdkVersion+' reference '+dependency);
run([path.join(studio,'tools/ohpm/bin/pm-cli.js'),'install','--all']);
run([path.join(studio,'tools/hvigor/bin/hvigorw.js'),'--mode','module','-p','module=entry@default','-p','product=default','assembleHap','--no-daemon']);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});

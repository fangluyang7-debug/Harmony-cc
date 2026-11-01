// Independent HAP build; the v1 product and its signing configuration remain untouched.
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
async function main(){
const root=path.resolve(__dirname,'..'),name=process.argv[2];
if(!['harmony-agent','harmony-har-probe'].includes(name))throw Error('APP_NAME_REQUIRED');
const studio=process.env.DEVECO_STUDIO_HOME||'D:/Users/17321/AppData/DevEco Studio',sdk=process.env.DEVECO_SDK_HOME||path.join(studio,'sdk');
const metadata=JSON.parse(fs.readFileSync(path.join(sdk,'default/sdk-pkg.json'))).data,sdkVersion=metadata.platformVersion+'('+metadata.apiVersion+')';
const stage=path.join(root,'.test/s2-'+name),source=path.join(root,'apps',name);fs.mkdirSync(stage,{recursive:true});
const filter=p=>!/[\\/](?:oh_modules|build|\.hvigor|node_modules)(?:[\\/]|$)/.test(p);
fs.cpSync(source,stage,{recursive:true,filter});
fs.mkdirSync(path.join(stage,'hvigor'),{recursive:true});
fs.writeFileSync(path.join(stage,'hvigor/hvigor-config.json5'),JSON.stringify({modelVersion:metadata.platformVersion,dependencies:{}}));
fs.writeFileSync(path.join(stage,'build-profile.json5'),JSON.stringify({app:{signingConfigs:[],products:[{name:'default',targetSdkVersion:sdkVersion,compatibleSdkVersion:sdkVersion,runtimeOS:'HarmonyOS',buildOption:{strictMode:{caseSensitiveCheck:true,useNormalizedOHMUrl:true}}}],buildModeSet:[{name:'debug'},{name:'release'}]},modules:[{name:'entry',srcPath:'./entry',targets:[{name:'default',applyToProducts:['default']}]}]}));
const dependency=process.argv.includes('--har')?path.join(root,'.test/s2-har/scheduler/build/default/outputs/default/scheduler.har'):path.join(root,'apps/harmony/scheduler');
const modulePackage=JSON.parse(fs.readFileSync(path.join(source,'entry/oh-package.json5')));modulePackage.dependencies={scheduler:'file:'+dependency.replaceAll('\\','/')};
fs.writeFileSync(path.join(stage,'entry/oh-package.json5'),JSON.stringify(modulePackage));
// Both native applications consume exactly the same checked-in fixture file.
fs.mkdirSync(path.join(stage,'entry/src/main/resources/rawfile'),{recursive:true});
fs.copyFileSync(path.join(root,'tests/agent-conformance/fixtures/ledger-v2.json'),path.join(stage,'entry/src/main/resources/rawfile/ledger-v2.json'));
const references=require('@harmony/reference-capabilities');
fs.writeFileSync(path.join(stage,'entry/src/main/resources/rawfile/reference-packs.json'),JSON.stringify((await references.builtinReferencePacks()).map(p=>({manifest:p.manifest,digest:references.packDigest(p),cases:p.cases.map(c=>({...c,input:c.input.toString('base64')}))}))));
const env={...process.env,DEVECO_SDK_HOME:sdk,JAVA_HOME:path.join(studio,'jbr'),PATH:path.join(studio,'tools/node')+path.delimiter+path.join(studio,'jbr/bin')+path.delimiter+process.env.PATH};
const node=path.join(studio,'tools/node/node.exe');
function run(args){const r=spawnSync(node,args,{cwd:stage,env,stdio:'inherit',windowsHide:true});if(r.error)throw r.error;if(r.status!==0)process.exit(r.status??1);}
console.log('HAP '+name+' SDK '+sdkVersion+' reference '+dependency);
run([path.join(studio,'tools/ohpm/bin/pm-cli.js'),'install','--all']);
run([path.join(studio,'tools/hvigor/bin/hvigorw.js'),'--mode','module','-p','module=entry@default','-p','product=default','assembleHap','--no-daemon']);
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});

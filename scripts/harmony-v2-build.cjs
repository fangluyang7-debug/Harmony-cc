// Build in an ignored workspace so the frozen v1 product/signing configuration is untouched.
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const studio=process.env.DEVECO_STUDIO_HOME||'D:/Users/17321/AppData/DevEco Studio';
const sdk=process.env.DEVECO_SDK_HOME||path.join(studio,'sdk');
const metadata=JSON.parse(fs.readFileSync(path.join(sdk,'default/sdk-pkg.json'))).data;
const stage=path.join(root,'.test/s2-har');fs.mkdirSync(stage,{recursive:true});
const copy=(from,to)=>fs.cpSync(path.join(root,from),path.join(stage,to),{recursive:true,filter:p=>!/[\\/](?:oh_modules|build|\.hvigor|node_modules)(?:[\\/]|$)/.test(p)});
copy('apps/harmony/scheduler','scheduler');copy('apps/harmony/AppScope','AppScope');
copy('apps/harmony/hvigorfile.ts','hvigorfile.ts');
fs.mkdirSync(path.join(stage,'hvigor'),{recursive:true});
fs.writeFileSync(path.join(stage,'hvigor/hvigor-config.json5'),JSON.stringify({modelVersion:metadata.platformVersion,dependencies:{}}));
fs.writeFileSync(path.join(stage,'oh-package.json5'),JSON.stringify({modelVersion:metadata.platformVersion,name:'harmony-v2-har-build',version:'1.0.0',dependencies:{}}));
const sdkVersion=metadata.platformVersion+'('+metadata.apiVersion+')';
fs.writeFileSync(path.join(stage,'build-profile.json5'),JSON.stringify({app:{signingConfigs:[],products:[{name:'default',targetSdkVersion:sdkVersion,compatibleSdkVersion:sdkVersion,runtimeOS:'HarmonyOS',buildOption:{strictMode:{caseSensitiveCheck:true,useNormalizedOHMUrl:true}}}],buildModeSet:[{name:'debug'},{name:'release'}]},modules:[{name:'scheduler',srcPath:'./scheduler'}]}));
const env={...process.env,DEVECO_SDK_HOME:sdk,JAVA_HOME:path.join(studio,'jbr'),PATH:path.join(studio,'tools/node')+path.delimiter+path.join(studio,'jbr/bin')+path.delimiter+process.env.PATH};
console.log('HAR build SDK '+sdkVersion+'; stage '+stage);
const result=spawnSync(path.join(studio,'tools/node/node.exe'),[path.join(studio,'tools/hvigor/bin/hvigorw.js'),'--mode','module','-p','module=scheduler@default','-p','product=default','assembleHar','--no-daemon'],{cwd:stage,env,stdio:'inherit',windowsHide:true});
if(result.error)throw result.error;process.exitCode=result.status??1;

// Deprecated historical implementation. All release packaging uses prepare-harmony-distribution.cjs.
if (require.main === module) {
  console.error('此旧打包入口已废弃，请运行 npm run dist:prepare。');
  process.exit(1);
}
// Portable Windows application; includes Electron, the existing CPU host and sharp.
const fs=require('node:fs'),path=require('node:path'),esbuild=require('esbuild');
const root=path.resolve(__dirname,'..'),out=path.join(root,'.test/windows-app/Harmony'),application=path.join(out,'resources/app');
async function main(){
 await require("./build-visual-native.cjs").build();
 fs.mkdirSync(application,{recursive:true});fs.cpSync(path.join(root,'node_modules/electron/dist'),out,{recursive:true});
 if(fs.existsSync(path.join(out,'electron.exe')))fs.renameSync(path.join(out,'electron.exe'),path.join(out,'Harmony.exe'));
 for(const name of ['main.cjs','preload.cjs','host-manager.cjs','launcher.html','launcher.cjs','discovery.cjs','package.json'])fs.copyFileSync(path.join(root,'apps/windows-agent',name),path.join(application,name));
 fs.copyFileSync(path.join(root,'apps/team-space-web/join-key.mjs'),path.join(application,'join-key.mjs'));
 const runtime=path.join(application,'runtime');fs.mkdirSync(runtime,{recursive:true});
 for(const entry of ['host-main','pairing-main','cpu-child'])await esbuild.build({entryPoints:[path.join(root,'services/pc-agent/src',entry+'.ts')],bundle:true,platform:'node',format:'cjs',target:'node22',external:['sharp','*.node'],outfile:path.join(runtime,entry+'.js')});
 fs.copyFileSync(path.join(root,'services/pc-agent/dist/visual.node'),path.join(runtime,'visual.node'));
 for(const name of ['sharp','@img','detect-libc','semver']){const from=path.join(root,'node_modules',name);if(fs.existsSync(from))fs.cpSync(from,path.join(runtime,'node_modules',name),{recursive:true});}
 // Optional installation payload: generic weights/engines, never user photos or results.
 const photoConfig=process.env.HARMONY_PHOTO_RUNTIME;
 if(photoConfig){const cfg=JSON.parse(fs.readFileSync(photoConfig,'utf8')),base=path.dirname(path.resolve(photoConfig)),destination=path.join(runtime,'photo');fs.mkdirSync(destination,{recursive:true});
  const model=path.resolve(base,cfg.model),runner=path.resolve(base,cfg.runner);fs.mkdirSync(path.join(destination,'models'),{recursive:true});
  for(const file of ['realesrgan-x4plus.param','realesrgan-x4plus.bin','manifest.json'])fs.copyFileSync(path.join(model,file),path.join(destination,'models',file));
  fs.copyFileSync(runner,path.join(destination,'photo-runner.exe'));const installed={model:'models',runner:'photo-runner.exe'};
  if(cfg.vulkan){fs.copyFileSync(path.resolve(base,cfg.vulkan),path.join(destination,'realesrgan-ncnn-vulkan.exe'));installed.vulkan='realesrgan-ncnn-vulkan.exe';const omp=path.join(path.dirname(path.resolve(base,cfg.vulkan)),'vcomp140.dll');if(fs.existsSync(omp))fs.copyFileSync(omp,path.join(destination,'vcomp140.dll'));}
  fs.writeFileSync(path.join(destination,'runtime.json'),JSON.stringify(installed,null,2));
 }
 fs.writeFileSync(path.join(out,'使用说明.txt'),'双击 Harmony.exe，粘贴负责人提供的完整接入密钥，登录后确认共享本机即可。无需 Node.js 或命令行。退出应用会停止本机贡献；再次打开自动恢复当前空间。\r\n整个文件夹需要一同保留。此包为本地验收未签名便携版。\r\n');
 console.log('Windows app ready:',path.join(out,'Harmony.exe'));
}
main().catch(e=>{console.error(e);process.exitCode=1;});

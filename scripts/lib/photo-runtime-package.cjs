// Stage a photo runtime (Real-ESRGAN model, CPU runner, optional Vulkan engine with its DLLs) into a
// Windows device package. Missing pieces fail the build: a package that pairs but cannot register
// photo.enhance.v1 must never be produced silently.
const fs=require('node:fs'),path=require('node:path');
const MODEL_FILES=['realesrgan-x4plus.param','realesrgan-x4plus.bin','manifest.json'];
function defaultCopy(src,dest){fs.mkdirSync(path.dirname(dest),{recursive:true});fs.cpSync(src,dest,{recursive:true});}
/**
 * @param {string} configPath runtime.json written by prepare-photo-runtime.cjs (keys model/runner/vulkan are paths).
 * @param {string} target destination directory (services/pc-agent/dist/photo inside the package).
 * @returns {{model:string,runner:string,vulkan:string|null,dlls:string[]}}
 */
function stagePhotoRuntime(configPath,target,copy=defaultCopy){
  const config=JSON.parse(fs.readFileSync(configPath,'utf8')),base=path.dirname(configPath);
  const resolve=key=>typeof config[key]==='string'&&config[key]?path.resolve(base,config[key]):null;
  const model=resolve('model'),runner=resolve('runner'),vulkan=resolve('vulkan'),missing=[];
  if(!model)missing.push('model');else for(const file of MODEL_FILES)if(!fs.existsSync(path.join(model,file)))missing.push('model/'+file);
  if(!runner)missing.push('runner');else if(!fs.existsSync(runner))missing.push('runner '+runner);
  if(vulkan&&!fs.existsSync(vulkan))missing.push('vulkan '+vulkan);
  if(missing.length)throw Error('PHOTO_RUNTIME_INCOMPLETE: '+missing.join(', '));
  fs.mkdirSync(target,{recursive:true});
  const settings={model:'models',runner:path.basename(runner)},summary={model:'models',runner:settings.runner,vulkan:null,dlls:[]};
  copy(model,path.join(target,'models'));
  copy(runner,path.join(target,settings.runner));
  if(vulkan){
    // The ncnn Vulkan engine imports vcomp140.dll (OpenMP); ship every DLL beside it except the
    // driver-provided vulkan-1.dll, which must come from the target machine's GPU driver.
    const dir=path.join(target,'vulkan'),source=path.dirname(vulkan);fs.mkdirSync(dir,{recursive:true});
    copy(vulkan,path.join(dir,path.basename(vulkan)));
    for(const name of fs.readdirSync(source))if(/\.dll$/i.test(name)&&!/^vulkan-1\.dll$/i.test(name)){copy(path.join(source,name),path.join(dir,name));summary.dlls.push(name);}
    if(!summary.dlls.some(name=>/^vcomp140\.dll$/i.test(name)))throw Error('PHOTO_RUNTIME_INCOMPLETE: vcomp140.dll beside '+vulkan);
    settings.vulkan='vulkan/'+path.basename(vulkan);summary.vulkan=settings.vulkan;
  }
  for(const key of ['backend','cpuRuntime','ncnnRevision'])if(config[key]!==undefined)settings[key]=config[key];
  fs.writeFileSync(path.join(target,'runtime.json'),JSON.stringify(settings));
  return summary;
}
module.exports={stagePhotoRuntime,MODEL_FILES};

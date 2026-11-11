import fs from 'node:fs';
import path from 'node:path';
// Executed before registry imports. An installation contains models and engines only.
const candidate=process.env.HARMONY_PHOTO_RUNTIME??path.join(__dirname,'photo','runtime.json');
if(fs.existsSync(candidate)){
 const settings=JSON.parse(fs.readFileSync(candidate,'utf8')),base=path.dirname(candidate);
 for(const [key,name] of [['HARMONY_PHOTO_MODEL','model'],['HARMONY_PHOTO_RUNNER','runner'],['HARMONY_PHOTO_VULKAN','vulkan']] as const){
  if(!process.env[key]&&typeof settings[name]==='string')process.env[key]=path.resolve(base,settings[name]);
 }
 if(!process.env.HARMONY_PHOTO_VULKAN_RUNTIME&&settings.vulkanRuntime==='harmony-raw-v1')process.env.HARMONY_PHOTO_VULKAN_RUNTIME=settings.vulkanRuntime;
}

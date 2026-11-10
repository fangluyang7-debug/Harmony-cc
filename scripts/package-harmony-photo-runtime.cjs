// ncnn's Harmony static archive links the SDK's shared OpenMP runtime.
// Keep that dependency with the module; a successful native link alone does not
// mean the target phone can load the library.
const fs=require('node:fs'),path=require('node:path');
function packagePhotoRuntime(moduleDir,sdk){
 if(!process.env.HARMONY_NCNN_DIR)return;
 for(const [abi,triple] of [['arm64-v8a','aarch64-linux-ohos'],['x86_64','x86_64-linux-ohos']]){
  const source=path.join(sdk,'default/openharmony/native/llvm/lib',triple,'libomp.so');
  if(!fs.existsSync(source))throw Error('PHOTO_OPENMP_RUNTIME_MISSING: '+abi);
  const dest=path.join(moduleDir,'libs',abi);fs.mkdirSync(dest,{recursive:true});
  fs.copyFileSync(source,path.join(dest,'libomp.so'));
 }
}
module.exports={packagePhotoRuntime};

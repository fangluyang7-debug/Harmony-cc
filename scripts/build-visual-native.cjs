const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
async function build(){
 const root=path.resolve(__dirname,'..'),headers=path.join(root,'.test/node-native-headers');fs.mkdirSync(headers,{recursive:true});
 async function download(file,url){if(fs.existsSync(file))return;const r=await fetch(url,{signal:AbortSignal.timeout(60000)});if(!r.ok)throw Error('NAPI_BUILD_DOWNLOAD_'+r.status);fs.writeFileSync(file,Buffer.from(await r.arrayBuffer()));}
 for(const file of ['node_api.h','node_api_types.h','js_native_api.h','js_native_api_types.h'])await download(path.join(headers,file),'https://raw.githubusercontent.com/nodejs/node/v22.18.0/src/'+file);
 const windows=process.platform==='win32',cxx=process.env.CXX||'g++',out=path.join(root,'services/pc-agent/dist/visual.node');fs.mkdirSync(path.dirname(out),{recursive:true});
 const flags=['-shared','-O3','-std=c++17','-ffp-contract=off','-fno-fast-math','-DNODE_GYP_MODULE_NAME=visual','-I',headers,path.join(root,'services/pc-agent/native/visual-addon.cpp')];
 if(windows){const zlib=execFileSync(cxx,['-print-file-name=libz.a'],{encoding:'utf8',windowsHide:true}).trim();if(!fs.existsSync(zlib))throw Error('ZLIB_DEVELOPMENT_LIBRARY_REQUIRED');flags.push('-static-libgcc','-static-libstdc++',zlib);}else{flags.push('-fPIC','-lz');if(process.platform==='darwin')flags.push('-undefined','dynamic_lookup');}
 execFileSync(cxx,[...flags,'-o',out],{cwd:root,stdio:'inherit',windowsHide:true});console.log('Visual CPU N-API built:',out);
}
module.exports={build};if(require.main===module)build().catch(e=>{console.error(e.message);process.exitCode=1;});

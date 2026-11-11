// Build the same RGB/float32/tile implementation used on CPU/Harmony, with ncnn Vulkan enabled.
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),tools=path.join(root,'.test/photo-tools');
const source=path.join(tools,'photo-vulkan-project'),build=path.join(tools,'photo-vulkan-build');
const cxx=process.env.CXX||'C:/msys64/mingw64/bin/g++.exe',cc=process.env.CC||'C:/msys64/mingw64/bin/gcc.exe';
const env={...process.env,PATH:path.dirname(cxx)+path.delimiter+process.env.PATH};
const openmp=execFileSync(cxx,['-print-file-name=libgomp.a'],{env,encoding:'utf8',windowsHide:true}).trim();
if(!fs.existsSync(openmp))throw Error('PHOTO_OPENMP_LIBRARY_MISSING');
function run(cmd,args){execFileSync(cmd,args,{cwd:root,env,windowsHide:true,stdio:'inherit'});}
const revision=execFileSync('git',['-C',path.join(tools,'ncnn'),'rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(revision!=='7e36d25cb153092ba87a60530455c7376fedf452')throw Error('PHOTO_NCNN_REVISION');
run('git',['-C',path.join(tools,'ncnn'),'submodule','update','--init','--depth','1','glslang']);
fs.mkdirSync(source,{recursive:true});
const cmakePath=p=>p.replaceAll('\\','/');
fs.writeFileSync(path.join(source,'CMakeLists.txt'),`cmake_minimum_required(VERSION 3.20)
project(harmony_photo_vulkan LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
add_subdirectory("${cmakePath(path.join(tools,'ncnn'))}" ncnn)
add_executable(photo-runner-vulkan "${cmakePath(path.join(root,'services/pc-agent/native/photo-runner.cpp'))}")
target_compile_options(photo-runner-vulkan PRIVATE -O3 -fopenmp)
target_link_options(photo-runner-vulkan PRIVATE -static -fopenmp)
target_link_libraries(photo-runner-vulkan PRIVATE ncnn)
`);
run('cmake',['-S',source,'-B',build,'-G','Ninja','-DCMAKE_MAKE_PROGRAM='+path.join(tools,'python/bin/ninja.exe'),
 '-DCMAKE_C_COMPILER='+cc,'-DCMAKE_CXX_COMPILER='+cxx,
 '-DCMAKE_BUILD_TYPE=Release','-DOpenMP_gomp_LIBRARY='+openmp,'-DNCNN_VULKAN=ON','-DNCNN_SIMPLEVK=ON','-DNCNN_OPENMP=ON','-DNCNN_SHARED_LIB=OFF',
 '-DNCNN_BUILD_TOOLS=OFF','-DNCNN_BUILD_EXAMPLES=OFF','-DNCNN_BUILD_BENCHMARK=OFF','-DNCNN_BUILD_TESTS=OFF',
 '-DNCNN_AVX512=OFF','-DNCNN_XOP=OFF','-DNCNN_FMA4=OFF','-DNCNN_AVXVNNI=OFF','-DNCNN_AVXNECONVERT=OFF']);
run('cmake',['--build',build,'--target','photo-runner-vulkan','-j','6']);
fs.copyFileSync(path.join(tools,'ncnn/LICENSE.txt'),path.join(build,'LICENSE-ncnn.txt'));
fs.copyFileSync(path.join(tools,'ncnn/glslang/LICENSE.txt'),path.join(build,'LICENSE-glslang.txt'));
const config=JSON.parse(fs.readFileSync(path.join(tools,'runtime.json')));
config.vulkan=path.join(build,'photo-runner-vulkan.exe');config.vulkanRuntime='harmony-raw-v1';
fs.writeFileSync(path.join(tools,'runtime-vulkan.json'),JSON.stringify(config,null,2));
console.log('Prepared runtime-vulkan.json; verify on a GPU before reporting hardware readiness.');

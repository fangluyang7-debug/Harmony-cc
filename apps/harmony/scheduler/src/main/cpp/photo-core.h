#pragma once
#include <net.h>
#include <fstream>
#include <vector>
#include <iostream>
#include <chrono>
#include <cstring>
#include <memory>
#include <cstdlib>
// Same RGB/float32 model input on Windows and HarmonyOS. No task cache.
struct PhotoModelCache {std::unique_ptr<ncnn::Net> net;std::string key;};
inline PhotoModelCache& photoModelCache(){thread_local PhotoModelCache cache;return cache;}
// The desktop server invokes this before destroying its Vulkan instance.
inline void resetPhotoModelCache(){auto& cache=photoModelCache();cache.net.reset();cache.key.clear();}
inline int photoInferFiles(int argc,char** argv) {
 if(argc!=7){std::cerr<<"PHOTO_ARGUMENTS";return 2;}
 try {
  std::ifstream f(argv[3],std::ios::binary); unsigned int w=0,h=0;
  f.read(reinterpret_cast<char*>(&w),4);f.read(reinterpret_cast<char*>(&h),4);
  if(!f||w<1||h<1||w>1024||h>1024)throw "PHOTO_INPUT_INVALID";
  std::vector<unsigned char> rgb(w*h*3);f.read(reinterpret_cast<char*>(rgb.data()),rgb.size());
  if(!f||f.peek()!=EOF)throw "PHOTO_INPUT_INVALID";
  // Model-only, thread-local reuse: no image or result cache. NAPI workers and
  // persistent Windows workers own separate networks and fresh extractors.
  auto& cache=photoModelCache();auto& cached=cache.net;auto& cachedKey=cache.key;
  const char* gpuChoice=std::getenv("HARMONY_PHOTO_GPU_ID");
  const std::string key=std::string(argv[1])+"|"+argv[2]+"|"+argv[5]+"|"+argv[6]+"|"+(gpuChoice?gpuChoice:"");
  const auto loadStart=std::chrono::steady_clock::now();
  const bool load=!cached||cachedKey!=key;
  if(load){cached.reset(new ncnn::Net());cachedKey.clear();}
  ncnn::Net& net=*cached;net.opt.num_threads=std::max(1,std::min(16,std::atoi(argv[5])));
  net.opt.use_fp16_storage=false;net.opt.use_fp16_arithmetic=false;net.opt.use_bf16_storage=false;
  const bool gpu=std::string(argv[6])=="VULKAN";
#if NCNN_VULKAN
  if(gpu){
   const char* choice=std::getenv("HARMONY_PHOTO_GPU_ID");
   const int index=choice?std::atoi(choice):ncnn::get_default_gpu_index();
   if(index<0||index>=ncnn::get_gpu_count())throw "PHOTO_GPU_UNAVAILABLE";
   net.opt.use_vulkan_compute=true;net.opt.use_fp16_packed=false;
   if(load)net.set_vulkan_device(index);
   for(int i=0;i<ncnn::get_gpu_count();i++)std::cerr<<"["<<i<<" "<<ncnn::get_gpu_info(i).device_name()<<"] native photo RGB/float32\n";
  }
#else
  if(gpu)throw "PHOTO_GPU_UNAVAILABLE";
#endif
  if(load){if(net.load_param(argv[1])||net.load_model(argv[2])){cached.reset();throw "PHOTO_MODEL_INVALID";}cachedKey=key;}
  const auto inferStart=std::chrono::steady_clock::now();
  const float norms[3]={1.f/255,1.f/255,1.f/255};
  unsigned int ow=w*4,oh=h*4;
  std::vector<unsigned char> result(ow*oh*3);
  // Bound live activation tensors independently of the distributed task tile.
  // Every core is computed once; overlap is context and never committed twice.
  const int core=128,halo=16;
  for(int top=0;top<int(h);top+=core)for(int left=0;left<int(w);left+=core){
   const int cw=std::min(core,int(w)-left),ch=std::min(core,int(h)-top);
   const int x0=std::max(0,left-halo),y0=std::max(0,top-halo);
   const int iw=std::min(int(w),left+cw+halo)-x0,ih=std::min(int(h),top+ch+halo)-y0;
   std::vector<unsigned char> tile(iw*ih*3);
   for(int y=0;y<ih;y++)std::memcpy(tile.data()+y*iw*3,rgb.data()+((y0+y)*w+x0)*3,iw*3);
   ncnn::Mat input=ncnn::Mat::from_pixels(tile.data(),ncnn::Mat::PIXEL_RGB,iw,ih);
   input.substract_mean_normalize(nullptr,norms);
   auto ex=net.create_extractor();if(ex.input("data",input))throw "PHOTO_MODEL_INPUT";
   ncnn::Mat output;if(ex.extract("output",output)||output.w!=iw*4||output.h!=ih*4||output.c!=3)throw "PHOTO_MODEL_OUTPUT";
   for(int y=0;y<ch*4;y++)for(int x=0;x<cw*4;x++)for(int c=0;c<3;c++){
    const float v=output.channel(c).row((top-y0)*4+y)[(left-x0)*4+x]*255.f;
    result[((top*4+y)*ow+left*4+x)*3+c]=static_cast<unsigned char>(std::max(0.f,std::min(255.f,v+.5f)));
   }
  }
  const auto inferEnd=std::chrono::steady_clock::now();
  std::ofstream out(argv[4],std::ios::binary);
  out.write(reinterpret_cast<char*>(&ow),4);out.write(reinterpret_cast<char*>(&oh),4);out.write(reinterpret_cast<char*>(result.data()),result.size());
  if(!out)throw "PHOTO_WRITE_FAILED";
  std::cout<<"{\"backend\":\""<<(gpu?"VULKAN":"CPU")<<"\",\"width\":"<<ow<<",\"height\":"<<oh
   <<",\"modelLoaded\":"<<(load?"true":"false")<<",\"modelLoadMs\":"<<std::chrono::duration<double,std::milli>(inferStart-loadStart).count()
   <<",\"inferenceMs\":"<<std::chrono::duration<double,std::milli>(inferEnd-inferStart).count()<<"}";
  return 0;
 }catch(const char* e){std::cerr<<e;return 1;}catch(...){std::cerr<<"PHOTO_INFERENCE_FAILED";return 1;}
}

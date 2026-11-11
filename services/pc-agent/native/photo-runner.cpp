#include "../../../apps/harmony/scheduler/src/main/cpp/photo-core.h"
#include <omp.h>
#include <sstream>
#include <iomanip>
#ifndef _OPENMP
#error Windows photo runner must be built with OpenMP enabled
#endif
int main(int argc,char** argv){
#if NCNN_VULKAN
 // Explicit lifetime: cached GPU pipelines must die before the Vulkan device.
 struct GpuLifetime {~GpuLifetime(){resetPhotoModelCache();ncnn::destroy_gpu_instance();}} lifetime;
 if((argc==2&&(std::string(argv[1])=="--gpu-list"||std::string(argv[1])=="--server"))||(argc==7&&std::string(argv[6])=="VULKAN")){
  ncnn::create_gpu_instance();
  for(int i=0;i<ncnn::get_gpu_count();i++)std::cerr<<"["<<i<<" "<<ncnn::get_gpu_info(i).device_name()<<"] native photo RGB/float32\n";
  if(std::string(argv[1])=="--gpu-list")return ncnn::get_gpu_count()>0?0:1;
 }
#endif
 if(argc==3&&std::string(argv[1])=="--runtime-info"){
  const int requested=std::max(1,std::min(16,std::atoi(argv[2])));int actual=1;
  omp_set_dynamic(0);
  #pragma omp parallel num_threads(requested)
  {
   #pragma omp single
   actual=omp_get_num_threads();
  }
  std::cout<<"{\"openmp\":true,\"requestedThreads\":"<<requested<<",\"actualThreads\":"<<actual<<"}";
  return actual==requested?0:1;
 }
 if(argc==2&&std::string(argv[1])=="--server"){
  std::string line;
  while(std::getline(std::cin,line)){
   std::istringstream input(line);std::vector<std::string> args={"photo"};std::string arg;
   while(input>>std::quoted(arg))args.push_back(arg);
   std::vector<char*> values;for(auto& value:args)values.push_back(&value[0]);
   const int code=photoInferFiles(static_cast<int>(values.size()),values.data());
   std::cout<<"\t"<<code<<std::endl;
  }
  return 0;
 }
 return photoInferFiles(argc,argv);
}

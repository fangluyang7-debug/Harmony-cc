#define HARMONY_PHOTO_SHARED_MODEL
#include "../../apps/harmony/scheduler/src/main/cpp/photo-core.h"
#include <thread>
#include <atomic>
#include <cassert>
#include <iterator>

std::string content(const std::string& path){std::ifstream f(path,std::ios::binary);return {std::istreambuf_iterator<char>(f),std::istreambuf_iterator<char>()};}
int run(const std::string& models,const std::string& input,const std::string& output,int threads){
 std::vector<std::string> values={"test",models+"/realesrgan-x4plus.param",models+"/realesrgan-x4plus.bin",input,output,std::to_string(threads),"CPU"};
 std::vector<char*> args;for(auto& v:values)args.push_back(&v[0]);return photoInferFiles(args.size(),args.data());
}
int main(int argc,char** argv){
 assert(argc==3);const std::string models=argv[1],dir=argv[2],input=dir+"/source.rgb";
 {std::ofstream f(input,std::ios::binary);unsigned w=8,h=6;f.write(reinterpret_cast<char*>(&w),4);f.write(reinterpret_cast<char*>(&h),4);for(int i=0;i<144;i++)f.put(char((i*37)%256));}
 assert(run(models,input,dir+"/serial.rgb",2)==0);
 auto original=photoModelCache().net;
 std::atomic<int> ready{0};std::atomic<bool> start{false};std::vector<std::thread> workers;
 for(int i=0;i<8;i++)workers.emplace_back([&,i]{++ready;while(!start)std::this_thread::yield();assert(run(models,input,dir+"/parallel-"+std::to_string(i)+".rgb",2)==0);});
 while(ready<8)std::this_thread::yield();start=true;for(auto& t:workers)t.join();
 assert(photoModelCache().net==original); // rotating NAPI workers must reuse the same model
 for(int i=0;i<8;i++)assert(content(dir+"/parallel-"+std::to_string(i)+".rgb")==content(dir+"/serial.rgb"));
 // Replacement must not destroy the network owned by an in-flight caller.
 assert(run(models,input,dir+"/changed.rgb",1)==0);assert(photoModelCache().net!=original);assert(original.use_count()==1);
 resetPhotoModelCache();assert(!photoModelCache().net);assert(original);
 std::cout<<"\nPASS: eight concurrent tasks share one model and match serial output; replacement/reset preserve active ownership\n";
}

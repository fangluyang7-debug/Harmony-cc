#include <napi/native_api.h>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace {
struct Work {
  napi_env env; napi_deferred deferred; napi_async_work handle;
  std::string id; double p[11]{}; std::atomic<bool> cancelled{false};
  std::vector<uint8_t> output;
};
std::mutex mutex;
std::unordered_map<std::string, Work*> running;
bool text(napi_env env,napi_value value,std::string& result) {
  size_t n=0;if(napi_get_value_string_utf8(env,value,nullptr,0,&n)!=napi_ok||n<1||n>128)return false;
  std::vector<char> bytes(n+1);if(napi_get_value_string_utf8(env,value,bytes.data(),bytes.size(),&n)!=napi_ok)return false;
  result.assign(bytes.data(),n);return true;
}
bool valid(const double* p) {
  for(int i=0;i<11;i++)if(!std::isfinite(p[i]))return false;
  for(int i: {0,1,2,3,4,5,10})if(std::floor(p[i])!=p[i])return false;
  return p[0]>=1&&p[0]<=512&&p[1]>=1&&p[1]<=512&&p[2]>=p[0]&&p[2]<=4096&&p[3]>=p[1]&&p[3]<=4096&&
    p[4]>=0&&p[5]>=0&&p[4]+p[0]<=p[2]&&p[5]+p[1]<=p[3]&&p[6]<p[7]&&p[8]<p[9]&&
    std::abs(p[6])<=4&&std::abs(p[7])<=4&&std::abs(p[8])<=4&&std::abs(p[9])<=4&&p[10]>=1&&p[10]<=8192;
}
void execute(napi_env,void* data) {
  auto* w=static_cast<Work*>(data);const auto* p=w->p;
  const uint32_t width=p[0],height=p[1],iterations=p[10];
  w->output.resize(12+width*height*3,0);auto* out=w->output.data();std::memcpy(out,"HRGB",4);
  for(int i=0;i<4;i++){out[4+i]=(width>>(8*i))&255;out[8+i]=(height>>(8*i))&255;}
  for(uint32_t y=0;y<height;y++){
    if(w->cancelled.load(std::memory_order_relaxed))return;
    for(uint32_t x=0;x<width;x++){
      const double a=p[6]+(p[4]+x+.5)/p[2]*(p[7]-p[6]),b=p[8]+(p[5]+y+.5)/p[3]*(p[9]-p[8]);
      const double q=(a-.25)*(a-.25)+b*b;uint32_t n=0;
      if(q*(q+a-.25)<=.25*b*b||(a+1)*(a+1)+b*b<=.0625)n=iterations;
      else{double re=0,im=0;while(re*re+im*im<=4&&n<iterations){const double next=re*re-im*im+a;im=2*re*im+b;re=next;n++;}}
      if(n<iterations){const auto i=12+3*(y*width+x);out[i]=(n*9)%256;out[i+1]=(n*7)%256;out[i+2]=(n*5)%256;}
    }
  }
}
void complete(napi_env env,napi_status status,void* data) {
  auto* w=static_cast<Work*>(data);
  {std::lock_guard<std::mutex> lock(mutex);running.erase(w->id);}
  const bool cancelled=w->cancelled.load(std::memory_order_relaxed);napi_value value;void* buffer=nullptr;
  if(status!=napi_ok||cancelled||napi_create_arraybuffer(env,w->output.size(),&buffer,&value)!=napi_ok){
    napi_value message;napi_create_string_utf8(env,cancelled?"CANCELLED_SETTLED":"EXECUTION_FAILED",NAPI_AUTO_LENGTH,&message);
    napi_create_error(env,nullptr,message,&value);napi_reject_deferred(env,w->deferred,value);
  }else{std::memcpy(buffer,w->output.data(),w->output.size());napi_resolve_deferred(env,w->deferred,value);}
  napi_delete_async_work(env,w->handle);delete w;
}
napi_value render(napi_env env,napi_callback_info info) {
  size_t argc=2;napi_value args[2];napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);
  auto* w=new Work{};w->env=env;uint32_t length=0;bool array=false;
  bool ok=argc==2&&text(env,args[0],w->id)&&napi_is_array(env,args[1],&array)==napi_ok&&array&&napi_get_array_length(env,args[1],&length)==napi_ok&&length==11;
  for(uint32_t i=0;ok&&i<11;i++){napi_value v;ok=napi_get_element(env,args[1],i,&v)==napi_ok&&napi_get_value_double(env,v,&w->p[i])==napi_ok;}
  if(!ok||!valid(w->p)){delete w;napi_throw_error(env,nullptr,"FRACTAL_INVALID");return nullptr;}
  {std::lock_guard<std::mutex> lock(mutex);if(running.count(w->id)){delete w;napi_throw_error(env,nullptr,"RENDER_ID_CONFLICT");return nullptr;}running[w->id]=w;}
  napi_value promise,name;napi_create_promise(env,&w->deferred,&promise);napi_create_string_utf8(env,"harmonyFractal",NAPI_AUTO_LENGTH,&name);
  if(napi_create_async_work(env,nullptr,name,execute,complete,w,&w->handle)!=napi_ok){
    {std::lock_guard<std::mutex> lock(mutex);running.erase(w->id);}delete w;napi_throw_error(env,nullptr,"EXECUTION_FAILED");return nullptr;
  }
  if(napi_queue_async_work(env,w->handle)!=napi_ok)complete(env,napi_generic_failure,w);
  return promise;
}
napi_value cancel(napi_env env,napi_callback_info info) {
  size_t argc=1;napi_value arg;napi_get_cb_info(env,info,&argc,&arg,nullptr,nullptr);std::string id;
  if(argc==1&&text(env,arg,id)){std::lock_guard<std::mutex> lock(mutex);const auto found=running.find(id);if(found!=running.end()&&found->second->env==env)found->second->cancelled.store(true,std::memory_order_relaxed);}
  napi_value result;napi_get_undefined(env,&result);return result;
}
napi_value init(napi_env env,napi_value exports) {
  napi_property_descriptor properties[]={{"render",nullptr,render,nullptr,nullptr,nullptr,napi_default,nullptr},{"cancel",nullptr,cancel,nullptr,nullptr,nullptr,napi_default,nullptr}};
  napi_define_properties(env,exports,2,properties);return exports;
}
napi_module module={1,0,nullptr,init,"harmony_render",nullptr,{0}};
}
extern "C" __attribute__((constructor)) void RegisterHarmonyRender(){napi_module_register(&module);}

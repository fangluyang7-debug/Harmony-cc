#include <napi/native_api.h>
#include <atomic>
#include <mutex>
#include <unordered_map>
#include "visual_match.hpp"
namespace {
struct Work {napi_env env;napi_async_work handle;napi_deferred deferred;std::string id,error,output;std::vector<uint8_t> input;bool packing=false;std::atomic<bool> cancelled{false};};
std::mutex mutex;std::unordered_map<std::string,Work*> running;
bool text(napi_env env,napi_value v,std::string& s){size_t n=0;if(napi_get_value_string_utf8(env,v,nullptr,0,&n)!=napi_ok||n<1||n>128)return false;std::vector<char> b(n+1);if(napi_get_value_string_utf8(env,v,b.data(),b.size(),&n)!=napi_ok)return false;s.assign(b.data(),n);return true;}
void execute(napi_env,void* data){auto* w=static_cast<Work*>(data);try{if(w->packing){uLongf size=compressBound(w->input.size());std::vector<uint8_t> out(8+size);out[0]='H';out[1]='V';out[2]='G';out[3]='1';for(int i=0;i<4;i++)out[4+i]=static_cast<uint8_t>(w->input.size()>>(8*i));if(compress2(out.data()+8,&size,w->input.data(),w->input.size(),1)!=Z_OK||size+8>8388608)throw std::runtime_error("VISUAL_INPUT_SIZE");w->output.assign(reinterpret_cast<char*>(out.data()),size+8);return;}w->output=harmony_visual::run(w->input.data(),w->input.size(),[w]{return w->cancelled.load(std::memory_order_relaxed);});}catch(const std::exception& e){w->error=e.what();}}
void complete(napi_env env,napi_status status,void* data){auto* w=static_cast<Work*>(data);{std::lock_guard<std::mutex> lock(mutex);running.erase(w->id);}napi_value result;
 if(status!=napi_ok||!w->error.empty()||w->cancelled.load()){napi_value message;napi_create_string_utf8(env,w->cancelled.load()?"CANCELLED_SETTLED":w->error.empty()?"VISUAL_FAILED":w->error.c_str(),NAPI_AUTO_LENGTH,&message);napi_create_error(env,nullptr,message,&result);napi_reject_deferred(env,w->deferred,result);}
 else{void* output=nullptr;napi_create_arraybuffer(env,w->output.size(),&output,&result);std::copy(w->output.begin(),w->output.end(),static_cast<char*>(output));napi_resolve_deferred(env,w->deferred,result);}napi_delete_async_work(env,w->handle);delete w;
}
napi_value launch(napi_env env,napi_callback_info info,bool packing){size_t argc=2;napi_value args[2];napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);auto* w=new Work{};w->env=env;w->packing=packing;void* data=nullptr;size_t length=0;
 if(argc!=2||!text(env,args[0],w->id)||napi_get_arraybuffer_info(env,args[1],&data,&length)!=napi_ok||length<1||length>(packing?33554432:8388608)){delete w;napi_throw_error(env,nullptr,"VISUAL_INVALID");return nullptr;}w->input.assign(static_cast<uint8_t*>(data),static_cast<uint8_t*>(data)+length);
 {std::lock_guard<std::mutex> lock(mutex);if(running.count(w->id)){delete w;napi_throw_error(env,nullptr,"VISUAL_ID_CONFLICT");return nullptr;}running[w->id]=w;}
 napi_value promise,name;napi_create_promise(env,&w->deferred,&promise);napi_create_string_utf8(env,"harmonyVisual",NAPI_AUTO_LENGTH,&name);
 if(napi_create_async_work(env,nullptr,name,execute,complete,w,&w->handle)!=napi_ok){std::lock_guard<std::mutex> lock(mutex);running.erase(w->id);delete w;napi_throw_error(env,nullptr,"VISUAL_FAILED");return nullptr;}if(napi_queue_async_work(env,w->handle)!=napi_ok)complete(env,napi_generic_failure,w);return promise;
}
napi_value match(napi_env env,napi_callback_info info){return launch(env,info,false);}
napi_value pack(napi_env env,napi_callback_info info){return launch(env,info,true);}
napi_value cancel(napi_env env,napi_callback_info info){size_t argc=1;napi_value arg;napi_get_cb_info(env,info,&argc,&arg,nullptr,nullptr);std::string id;if(argc==1&&text(env,arg,id)){std::lock_guard<std::mutex> lock(mutex);auto it=running.find(id);if(it!=running.end()&&it->second->env==env)it->second->cancelled.store(true);}napi_value result;napi_get_undefined(env,&result);return result;}
napi_value init(napi_env env,napi_value exports){napi_property_descriptor p[]={{"match",nullptr,match,nullptr,nullptr,nullptr,napi_default,nullptr},{"cancel",nullptr,cancel,nullptr,nullptr,nullptr,napi_default,nullptr},{"pack",nullptr,pack,nullptr,nullptr,nullptr,napi_default,nullptr}};napi_define_properties(env,exports,3,p);return exports;}
napi_module module={1,0,nullptr,init,"harmony_visual",nullptr,{0}};
}
extern "C" __attribute__((constructor)) void RegisterHarmonyVisual(){napi_module_register(&module);}

#ifdef _WIN32
#define NAPI_EXTERN
#define NOMINMAX
#include <windows.h>
#endif
#include <node_api.h>
#ifdef _WIN32
// Resolve the public N-API from the actual host executable. Linking node.lib
// eagerly imports node.exe and crashes a renamed Electron host on Windows.
// This MinGW build has no MSVC delay-load hook and imports no V8 internals.
#define HOST_API(name) static const auto host_##name = reinterpret_cast<decltype(&name)>(GetProcAddress(GetModuleHandleW(nullptr), #name));
HOST_API(napi_get_cb_info)
HOST_API(napi_is_buffer)
HOST_API(napi_get_buffer_info)
HOST_API(napi_throw_error)
HOST_API(napi_create_buffer_copy)
HOST_API(napi_create_function)
HOST_API(napi_set_named_property)
#define napi_get_cb_info host_napi_get_cb_info
#define napi_is_buffer host_napi_is_buffer
#define napi_get_buffer_info host_napi_get_buffer_info
#define napi_throw_error host_napi_throw_error
#define napi_create_buffer_copy host_napi_create_buffer_copy
#define napi_create_function host_napi_create_function
#define napi_set_named_property host_napi_set_named_property
#endif
#include "../../../apps/harmony/scheduler/src/main/cpp/visual_match.hpp"
static napi_value match(napi_env env,napi_callback_info info){
 size_t argc=1;napi_value arg;napi_get_cb_info(env,info,&argc,&arg,nullptr,nullptr);void* data=nullptr;size_t length=0;bool isBuffer=false;
 if(argc!=1||napi_is_buffer(env,arg,&isBuffer)!=napi_ok||!isBuffer||napi_get_buffer_info(env,arg,&data,&length)!=napi_ok){napi_throw_error(env,nullptr,"VISUAL_INVALID");return nullptr;}
 try{const auto output=harmony_visual::run(static_cast<uint8_t*>(data),length,[]{return false;});napi_value result;napi_create_buffer_copy(env,output.size(),output.data(),nullptr,&result);return result;}
 catch(const std::exception& error){napi_throw_error(env,nullptr,error.what());return nullptr;}
}
static napi_value init(napi_env env,napi_value exports){
#ifdef _WIN32
 if(!napi_get_cb_info||!napi_is_buffer||!napi_get_buffer_info||!napi_throw_error||!napi_create_buffer_copy||!napi_create_function||!napi_set_named_property)return nullptr;
#endif
 napi_value fn;napi_create_function(env,"match",NAPI_AUTO_LENGTH,match,nullptr,&fn);napi_set_named_property(env,exports,"match",fn);return exports;}
NAPI_MODULE(NODE_GYP_MODULE_NAME,init)

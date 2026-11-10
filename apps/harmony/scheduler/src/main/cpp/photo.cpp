#include <napi/native_api.h>
#include <string>
#include <vector>
#ifdef HARMONY_PHOTO_NCNN
#include "photo-core.h"
#endif
struct Work {napi_async_work work;napi_deferred promise;std::vector<std::string> args;int code=1;};
static napi_value Available(napi_env env,napi_callback_info){napi_value v;
#ifdef HARMONY_PHOTO_NCNN
 napi_get_boolean(env,true,&v);
#else
 napi_get_boolean(env,false,&v);
#endif
 return v;}
static napi_value Run(napi_env env,napi_callback_info info){
 size_t n=4;napi_value argv[4];napi_get_cb_info(env,info,&n,argv,nullptr,nullptr);if(n!=4){napi_throw_error(env,nullptr,"PHOTO_ARGUMENTS");return nullptr;}
 auto* w=new Work();w->args.push_back("photo");for(size_t i=0;i<4;i++){size_t len=0;if(napi_get_value_string_utf8(env,argv[i],nullptr,0,&len)!=napi_ok||len>4096){delete w;napi_throw_error(env,nullptr,"PHOTO_ARGUMENTS");return nullptr;}std::vector<char>b(len+1);napi_get_value_string_utf8(env,argv[i],b.data(),b.size(),&len);w->args.emplace_back(b.data());}w->args.push_back("1");w->args.push_back("CPU");
 napi_value promise,name;napi_create_promise(env,&w->promise,&promise);napi_create_string_utf8(env,"photo.inference",NAPI_AUTO_LENGTH,&name);
 napi_create_async_work(env,nullptr,name,[](napi_env,void* data){auto* w=static_cast<Work*>(data);
#ifdef HARMONY_PHOTO_NCNN
  std::vector<char*> args;for(auto& s:w->args)args.push_back(&s[0]);w->code=photoInferFiles(args.size(),args.data());
#endif
 },[](napi_env env,napi_status,void* data){auto* w=static_cast<Work*>(data);napi_value result;if(w->code==0){napi_get_undefined(env,&result);napi_resolve_deferred(env,w->promise,result);}else{napi_value message;napi_create_string_utf8(env,"PHOTO_INFERENCE_FAILED",NAPI_AUTO_LENGTH,&message);napi_create_error(env,nullptr,message,&result);napi_reject_deferred(env,w->promise,result);}napi_delete_async_work(env,w->work);delete w;},w,&w->work);napi_queue_async_work(env,w->work);return promise;
}
static napi_value Init(napi_env env,napi_value exports){napi_property_descriptor p[]={{"available",nullptr,Available,nullptr,nullptr,nullptr,napi_default,nullptr},{"run",nullptr,Run,nullptr,nullptr,nullptr,napi_default,nullptr}};napi_define_properties(env,exports,2,p);return exports;}
static napi_module module={1,0,nullptr,Init,"harmony_photo",nullptr,{0}};
extern "C" __attribute__((constructor)) void RegisterPhoto(){napi_module_register(&module);}

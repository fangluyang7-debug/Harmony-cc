#include "photo-png.h"
struct PngWork{napi_async_work work;napi_deferred deferred;std::string source,dest,error;uint32_t width=0,height=0;};
static napi_value EncodeRgb(napi_env env,napi_callback_info info){
 size_t count=4;napi_value args[4];napi_get_cb_info(env,info,&count,args,nullptr,nullptr);auto* w=new PngWork();
 auto path=[&](napi_value v,std::string& s){size_t n=0;if(napi_get_value_string_utf8(env,v,nullptr,0,&n)!=napi_ok||!n||n>4096)return false;std::vector<char>b(n+1);napi_get_value_string_utf8(env,v,b.data(),b.size(),&n);s.assign(b.data(),n);return s.find('\0')==std::string::npos;};
 if(count!=4||!path(args[0],w->source)||!path(args[1],w->dest)||w->source==w->dest||napi_get_value_uint32(env,args[2],&w->width)!=napi_ok||napi_get_value_uint32(env,args[3],&w->height)!=napi_ok){delete w;napi_throw_error(env,nullptr,"PHOTO_PNG_ARGUMENTS");return nullptr;}
 napi_value promise,name;napi_create_promise(env,&w->deferred,&promise);napi_create_string_utf8(env,"photo.encode.rows",NAPI_AUTO_LENGTH,&name);
 napi_create_async_work(env,nullptr,name,[](napi_env,void* p){auto* w=static_cast<PngWork*>(p);try{photoEncodeRgb(w->source.c_str(),w->dest.c_str(),w->width,w->height);}catch(const std::exception& e){w->error=e.what();}},[](napi_env env,napi_status status,void* p){auto* w=static_cast<PngWork*>(p);napi_value r;if(status==napi_ok&&w->error.empty()){napi_get_undefined(env,&r);napi_resolve_deferred(env,w->deferred,r);}else{napi_value m;napi_create_string_utf8(env,w->error.empty()?"PHOTO_PNG_FAILED":w->error.c_str(),NAPI_AUTO_LENGTH,&m);napi_create_error(env,nullptr,m,&r);napi_reject_deferred(env,w->deferred,r);}napi_delete_async_work(env,w->work);delete w;},w,&w->work);napi_queue_async_work(env,w->work);return promise;
}

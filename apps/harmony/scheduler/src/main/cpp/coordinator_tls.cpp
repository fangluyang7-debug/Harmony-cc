// A byte-preserving TLS server. All TLS reads/writes/closes run on one I/O thread.
// Avoids the platform TLS server's strlen-on-network-buffer failure on Harmony 6.1.
#include <napi/native_api.h>
#include <mbedtls/ssl.h>
#include <mbedtls/entropy.h>
#include <mbedtls/ctr_drbg.h>
#include <mbedtls/net_sockets.h>
#include <mbedtls/error.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <unistd.h>
#include <fcntl.h>
#include <atomic>
#include <algorithm>
#include <chrono>
#include <cstring>
#include <deque>
#include <map>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {
struct Event {std::string type,error;int id=0,request=0;std::vector<unsigned char> data;std::string remoteAddress;};
void JsEvent(napi_env env,napi_value callback,void*,void* raw){
 std::unique_ptr<Event> e(static_cast<Event*>(raw));if(!env||!callback)return;
 napi_value object,value,buffer,undefined;void* bytes=nullptr;napi_create_object(env,&object);
 napi_create_string_utf8(env,e->type.c_str(),e->type.size(),&value);napi_set_named_property(env,object,"type",value);
 napi_create_string_utf8(env,e->error.c_str(),e->error.size(),&value);napi_set_named_property(env,object,"error",value);
 napi_create_string_utf8(env,e->remoteAddress.c_str(),e->remoteAddress.size(),&value);napi_set_named_property(env,object,"remoteAddress",value);
 napi_create_int32(env,e->id,&value);napi_set_named_property(env,object,"clientId",value);
 napi_create_int32(env,e->request,&value);napi_set_named_property(env,object,"requestId",value);
 napi_create_arraybuffer(env,e->data.size(),&bytes,&buffer);if(!e->data.empty())memcpy(bytes,e->data.data(),e->data.size());
 napi_set_named_property(env,object,"data",buffer);napi_get_undefined(env,&undefined);napi_call_function(env,undefined,callback,1,&object,nullptr);
}
struct Write {int request=0;std::vector<unsigned char> data;size_t offset=0;};
struct Client {
 int id;std::string remoteAddress;mbedtls_net_context net;mbedtls_ssl_context ssl;bool ready=false;size_t buffered=0;
 std::deque<Write> writes;std::chrono::steady_clock::time_point started=std::chrono::steady_clock::now();
 Client(int number,int fd,std::string address):id(number),remoteAddress(std::move(address)){mbedtls_net_init(&net);net.fd=fd;mbedtls_ssl_init(&ssl);}
 ~Client(){mbedtls_ssl_free(&ssl);mbedtls_net_free(&net);}
};
struct Command {int id,request;bool close;std::vector<unsigned char> data;};
std::atomic<int> nextClientId{0};
class Server {
 public:
 int listener=-1;mbedtls_ssl_config config;mbedtls_x509_crt cert;mbedtls_pk_context key;
 mbedtls_entropy_context entropy;mbedtls_ctr_drbg_context rng;napi_threadsafe_function callback=nullptr;
 std::atomic<bool> closing{false};std::thread worker;std::mutex mutex;std::deque<Command> commands;size_t commandBytes=0;
 std::map<int,std::unique_ptr<Client>> clients;int nextId=0;
 Server(){mbedtls_ssl_config_init(&config);mbedtls_x509_crt_init(&cert);mbedtls_pk_init(&key);mbedtls_entropy_init(&entropy);mbedtls_ctr_drbg_init(&rng);}
 ~Server(){closing=true;if(worker.joinable())worker.join();if(listener>=0)::close(listener);clients.clear();mbedtls_ssl_config_free(&config);mbedtls_x509_crt_free(&cert);mbedtls_pk_free(&key);mbedtls_ctr_drbg_free(&rng);mbedtls_entropy_free(&entropy);}
 bool emit(Event* event){if(napi_call_threadsafe_function(callback,event,napi_tsfn_nonblocking)==napi_ok)return true;delete event;return false;}
 void finish(std::map<int,std::unique_ptr<Client>>::iterator it,const std::string& error){
  auto& c=*it->second;
  for(const auto& w:c.writes)emit(new Event{"sendError",error.empty()?"CONTROL_DISCONNECTED":error,c.id,w.request,{}});
  emit(new Event{"close",error,c.id,0,{}});clients.erase(it);
 }
 int initialize(const std::string& certificate,const std::string& privateKey,int port){
  const unsigned char personal[]="harmony-coordinator";int r=mbedtls_ctr_drbg_seed(&rng,mbedtls_entropy_func,&entropy,personal,sizeof(personal)-1);if(r)return r;
  r=mbedtls_x509_crt_parse(&cert,reinterpret_cast<const unsigned char*>(certificate.c_str()),certificate.size()+1);if(r)return r;
  r=mbedtls_pk_parse_key(&key,reinterpret_cast<const unsigned char*>(privateKey.c_str()),privateKey.size()+1,nullptr,0,mbedtls_ctr_drbg_random,&rng);if(r)return r;
  r=mbedtls_ssl_config_defaults(&config,MBEDTLS_SSL_IS_SERVER,MBEDTLS_SSL_TRANSPORT_STREAM,MBEDTLS_SSL_PRESET_DEFAULT);if(r)return r;
  mbedtls_ssl_conf_rng(&config,mbedtls_ctr_drbg_random,&rng);mbedtls_ssl_conf_authmode(&config,MBEDTLS_SSL_VERIFY_NONE);
  mbedtls_ssl_conf_min_tls_version(&config,MBEDTLS_SSL_VERSION_TLS1_2);
  r=mbedtls_ssl_conf_own_cert(&config,&cert,&key);if(r)return r;
  static const char* protocols[]={"http/1.1",nullptr};r=mbedtls_ssl_conf_alpn_protocols(&config,protocols);if(r)return r;
  listener=::socket(AF_INET,SOCK_STREAM,0);if(listener<0)return -1;int reuse=1;setsockopt(listener,SOL_SOCKET,SO_REUSEADDR,&reuse,sizeof(reuse));
  sockaddr_in address{};address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_ANY);address.sin_port=htons(port);
  if(bind(listener,reinterpret_cast<sockaddr*>(&address),sizeof(address))||listen(listener,32))return -2;
  fcntl(listener,F_SETFL,fcntl(listener,F_GETFL,0)|O_NONBLOCK);return 0;
 }
 void loop(){
  while(!closing){
   for(int count=0;count<8;count++){
    sockaddr_in remote{};socklen_t remoteSize=sizeof(remote);int fd=accept(listener,reinterpret_cast<sockaddr*>(&remote),&remoteSize);if(fd<0)break;if(clients.size()>=64){::close(fd);continue;}
    fcntl(fd,F_SETFL,fcntl(fd,F_GETFL,0)|O_NONBLOCK);auto c=std::make_unique<Client>(++nextClientId,fd,std::string(inet_ntoa(remote.sin_addr)));
    if(mbedtls_ssl_setup(&c->ssl,&config)){continue;}mbedtls_ssl_set_bio(&c->ssl,&c->net,mbedtls_net_send,mbedtls_net_recv,nullptr);
    clients.emplace(c->id,std::move(c));
   }
   std::deque<Command> pending;{std::lock_guard<std::mutex> lock(mutex);pending.swap(commands);commandBytes=0;}
   for(auto& command:pending){
    auto it=clients.find(command.id);
    if(it==clients.end()){if(!command.close)emit(new Event{"sendError","CONTROL_DISCONNECTED",command.id,command.request,{}});continue;}
    if(command.close){finish(it,"");continue;}
    auto& c=*it->second;
    if(c.buffered+command.data.size()>16777216){emit(new Event{"sendError","BACKPRESSURE",c.id,command.request,{}});continue;}
    c.buffered+=command.data.size();c.writes.push_back({command.request,std::move(command.data),0});
   }
   for(auto it=clients.begin();it!=clients.end();){
    auto current=it++;auto& c=*current->second;
    if(!c.ready){
     int r=mbedtls_ssl_handshake(&c.ssl);
     if(r==0){c.ready=true;if(!emit(new Event{"connect","",c.id,0,{},c.remoteAddress})){finish(current,"EVENT_BACKPRESSURE");continue;}}
     else if((r!=MBEDTLS_ERR_SSL_WANT_READ&&r!=MBEDTLS_ERR_SSL_WANT_WRITE)||std::chrono::steady_clock::now()-c.started>std::chrono::seconds(15)){finish(current,"TLS_HANDSHAKE_FAILED");continue;}
     else continue;
    }
    bool failed=false;
    for(int count=0;!c.writes.empty()&&count<8;count++){
     auto& w=c.writes.front();size_t length=std::min<size_t>(16384,w.data.size()-w.offset);
     int r=mbedtls_ssl_write(&c.ssl,w.data.data()+w.offset,length);
     if(r>0){w.offset+=r;c.buffered-=r;if(w.offset==w.data.size()){emit(new Event{"sent","",c.id,w.request,{}});c.writes.pop_front();}}
     else if(r==MBEDTLS_ERR_SSL_WANT_READ||r==MBEDTLS_ERR_SSL_WANT_WRITE)break;
     else{failed=true;break;}
    }
    if(failed){finish(current,"TLS_WRITE_FAILED");continue;}
    for(int count=0;count<8;count++){
     unsigned char data[16384];int r=mbedtls_ssl_read(&c.ssl,data,sizeof(data));
     if(r>0){if(!emit(new Event{"data","",c.id,0,std::vector<unsigned char>(data,data+r)})){failed=true;break;}}
     else if(r==MBEDTLS_ERR_SSL_WANT_READ||r==MBEDTLS_ERR_SSL_WANT_WRITE)break;
     else{failed=true;break;}
    }
    if(failed)finish(current,"");
   }
   std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  while(!clients.empty())finish(clients.begin(),"COORDINATOR_SHUTDOWN");
  napi_release_threadsafe_function(callback,napi_tsfn_release);
 }
};
std::unique_ptr<Server> server;
bool stringValue(napi_env env,napi_value value,std::string& result){size_t size=0;if(napi_get_value_string_utf8(env,value,nullptr,0,&size)!=napi_ok||size>16384)return false;std::vector<char> buffer(size+1);if(napi_get_value_string_utf8(env,value,buffer.data(),buffer.size(),&size)!=napi_ok)return false;result.assign(buffer.data(),size);return true;}
napi_value undefined(napi_env env){napi_value result;napi_get_undefined(env,&result);return result;}
napi_value start(napi_env env,napi_callback_info info){
 size_t count=4;napi_value args[4];napi_get_cb_info(env,info,&count,args,nullptr,nullptr);std::string certificate,key;int port=0;napi_valuetype type;
 if(server||count!=4||!stringValue(env,args[0],certificate)||!stringValue(env,args[1],key)||napi_get_value_int32(env,args[2],&port)!=napi_ok||port<1||port>65535||napi_typeof(env,args[3],&type)!=napi_ok||type!=napi_function){napi_throw_error(env,nullptr,"TLS_START_INVALID");return nullptr;}
 auto next=std::make_unique<Server>();int error=next->initialize(certificate,key,port);
 if(error){std::string message="TLS_START_FAILED:"+std::to_string(error);napi_throw_error(env,nullptr,message.c_str());return nullptr;}
 napi_value name;napi_create_string_utf8(env,"CoordinatorTLS",NAPI_AUTO_LENGTH,&name);
 if(napi_create_threadsafe_function(env,args[3],nullptr,name,1024,1,nullptr,nullptr,nullptr,JsEvent,&next->callback)!=napi_ok){napi_throw_error(env,nullptr,"TLS_CALLBACK_FAILED");return nullptr;}
 server=std::move(next);Server* running=server.get();server->worker=std::thread([running]{running->loop();});return undefined(env);
}
napi_value send(napi_env env,napi_callback_info info){
 size_t count=3;napi_value args[3];napi_get_cb_info(env,info,&count,args,nullptr,nullptr);int id=0,request=0;void* data=nullptr;size_t length=0;
 if(!server||count!=3||napi_get_value_int32(env,args[0],&id)!=napi_ok||napi_get_arraybuffer_info(env,args[1],&data,&length)!=napi_ok||napi_get_value_int32(env,args[2],&request)!=napi_ok||length<1||length>16777216){napi_throw_error(env,nullptr,"TLS_SEND_INVALID");return nullptr;}
 std::lock_guard<std::mutex> lock(server->mutex);if(server->commandBytes+length>33554432){napi_throw_error(env,nullptr,"BACKPRESSURE");return nullptr;}
 auto* bytes=static_cast<unsigned char*>(data);server->commandBytes+=length;server->commands.push_back({id,request,false,std::vector<unsigned char>(bytes,bytes+length)});return undefined(env);
}
napi_value closeClient(napi_env env,napi_callback_info info){size_t count=1;napi_value arg;int id=0;napi_get_cb_info(env,info,&count,&arg,nullptr,nullptr);if(server&&count==1&&napi_get_value_int32(env,arg,&id)==napi_ok){std::lock_guard<std::mutex> lock(server->mutex);server->commands.push_back({id,0,true,{}});}return undefined(env);}
napi_value stop(napi_env env,napi_callback_info){server.reset();return undefined(env);}
void cleanup(void*){server.reset();}
napi_value init(napi_env env,napi_value exports){napi_property_descriptor fields[]={{"start",nullptr,start,nullptr,nullptr,nullptr,napi_default,nullptr},{"send",nullptr,send,nullptr,nullptr,nullptr,napi_default,nullptr},{"closeClient",nullptr,closeClient,nullptr,nullptr,nullptr,napi_default,nullptr},{"stop",nullptr,stop,nullptr,nullptr,nullptr,napi_default,nullptr}};napi_define_properties(env,exports,4,fields);napi_add_env_cleanup_hook(env,cleanup,nullptr);return exports;}
napi_module module={1,0,nullptr,init,"harmony_coordinator_tls",nullptr,{0}};
}
extern "C" __attribute__((constructor)) void RegisterCoordinatorTls(){napi_module_register(&module);}

import { hilog } from '@kit.PerformanceAnalysisKit';
import { socket } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { CoordinatorCertificate } from './CoordinatorCertificate';
import { CoordinatorHttpParser, CoordinatorHttpRequest } from './CoordinatorHttpParser';
export interface CoordinatorHttpResponse {status:number;body:string;contentType?:string;}
export class CoordinatorTlsServer {
 private server:socket.TLSSocketServer|null=null;
 private clients:Map<number,socket.TLSSocketConnection>=new Map();
 async start(identity:CoordinatorCertificate,port:number,handle:(request:CoordinatorHttpRequest)=>Promise<CoordinatorHttpResponse>):Promise<void>{
  if(this.server!==null)throw Error('COORDINATOR_ALREADY_LISTENING');
  const server=socket.constructTLSSocketServerInstance();
  // Native TLSSocketServer events must be registered after listen resolves.
  await server.listen({address:{address:'0.0.0.0',port,family:1},secureOptions:{cert:identity.certificate,key:identity.privateKey},ALPNProtocols:['http/1.1']});this.server=server;
  server.on('error',(error)=>{hilog.error(0x0001,'HarmonyCoordinator','TLS_SERVER_ERROR %{public}d',error.code);});
  server.on('connect',(client:socket.TLSSocketConnection)=>{
   hilog.info(0x0001,'HarmonyCoordinator','TLS_CLIENT_CONNECTED %{public}d',client.clientId);
   if(this.clients.size>=64){void client.close();return;}
   this.clients.set(client.clientId,client);const parser=new CoordinatorHttpParser();let done=false;
   const timer=setTimeout(()=>{done=true;void client.close();},15000);
   client.on('close',()=>{clearTimeout(timer);this.clients.delete(client.clientId);});
   client.on('error',(error)=>{hilog.error(0x0001,'HarmonyCoordinator','TLS_CLIENT_ERROR %{public}d',error.code);clearTimeout(timer);this.clients.delete(client.clientId);});
   client.on('message',(message:socket.SocketMessageInfo)=>{if(done)return;void (async():Promise<void>=>{
    try{hilog.info(0x0001,'HarmonyCoordinator','HTTP_BYTES %{public}d',message.message.byteLength);const request=parser.push(new Uint8Array(message.message));if(request===null)return;request.remoteAddress=message.remoteInfo.address;done=true;clearTimeout(timer);const response=await handle(request);await this.reply(client,response);}
    catch(e){hilog.error(0x0001,'HarmonyCoordinator','HTTP_FAILED %{public}s',(e as Error).message);done=true;clearTimeout(timer);await this.reply(client,{status:400,body:'{"error":"REQUEST_REJECTED"}'}).catch(()=>{});}
    // Connection: close asks the HTTP client to end the TLS stream after consuming
    // the response. Closing immediately after send races the native SSL_read thread
    // on HarmonyOS 7. Retain the connection until its close event instead.
   })();});
  });

 }
 async close():Promise<void>{
  const server=this.server;this.server=null;
  for(const client of this.clients.values())await client.close().catch(()=>{});
  this.clients.clear();if(server)await server.close();
 }
 private async reply(client:socket.TLSSocketConnection,response:CoordinatorHttpResponse):Promise<void>{
  const length=new util.TextEncoder().encodeInto(response.body).length;
  const contentType=response.contentType??'application/json; charset=utf-8';if(/[\r\n]/.test(contentType))throw Error('HTTP_RESPONSE_INVALID');
  await client.send('HTTP/1.1 '+response.status+' '+(response.status===200?'OK':'Error')+'\r\nContent-Type: '+contentType+'\r\nDate: '+new Date().toUTCString()+'\r\nCache-Control: no-store\r\nContent-Length: '+length+'\r\nConnection: close\r\n\r\n'+response.body);
 }
}

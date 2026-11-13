import { socket } from '@kit.NetworkKit';
import { util } from '@kit.ArkTS';
import { common } from '@kit.AbilityKit';
import { CoordinatorPhoto, CoordinatorDatabase, CoordinatorHttpParser } from 'scheduler';
interface DisplayImage {data:string;mime:string;}
/** HTTP is observation-only. Authenticated execution remains on TLS port 7443. */
export class PhotoDisplayServer {
 private server:socket.TCPSocketServer|null=null;
 private clients:Set<socket.TCPSocketConnection>=new Set();
 private context:common.UIAbilityContext;
 private photo:CoordinatorPhoto;
 private database:CoordinatorDatabase;
 private address:string;
 constructor(context:common.UIAbilityContext,photo:CoordinatorPhoto,database:CoordinatorDatabase,address:string){this.context=context;this.photo=photo;this.database=database;this.address=address;}
 async start():Promise<void>{const server=socket.constructTCPSocketServerInstance();server.on('connect',client=>{this.clients.add(client);const parser=new CoordinatorHttpParser();let done=false;
  const timer=setTimeout(()=>{void client.close().catch(()=>{});},15000);
  client.on('close',()=>{clearTimeout(timer);this.clients.delete(client);});client.on('error',()=>{clearTimeout(timer);this.clients.delete(client);});
  client.on('message',info=>{if(done)return;try{const req=parser.push(new Uint8Array(info.message));if(!req)return;done=true;clearTimeout(timer);void (async()=>{
   let status=200,type='application/json; charset=utf-8',data:Uint8Array;
   try{
    const remote=await client.getRemoteAddress(),local=remote.address==='127.0.0.1'||remote.address==='::1';
    if(!local&&!['/connect','/event'].includes(req.path))throw Error('LOCAL_VIEWER_ONLY');
    if(req.path==='/reset'&&(req.method!=='POST'||req.displayReset!=='1'||req.origin!=='http://127.0.0.1:7460'))throw Error('LOCAL_RESET_REQUIRED');
    const assets:Record<string,string>={'/':'photo-display.html','/photo-display.js':'photo-display.js','/photo-display.css':'photo-display.css','/photo.css':'photo.css','/photo-display-compare.mjs':'photo-display-compare.mjs','/qrcode.js':'qrcode.js','/fonts/harmony-ui.woff':'fonts/harmony-ui.woff'};
    const asset=assets[req.path];
    if(req.path==='/diagnostics'){if(req.method!=='GET')throw Error('READ_ONLY_VIEWER');data=new util.TextEncoder().encodeInto(await this.photo.diagnostics());}
    else if(req.path==='/devices'){if(req.method!=='GET')throw Error('READ_ONLY_VIEWER');data=new util.TextEncoder().encodeInto(JSON.stringify(await this.database.overview()));}
    else if(asset){if(req.method!=='GET')throw Error('READ_ONLY_VIEWER');data=await this.context.resourceManager.getRawFileContent('display/'+asset);type=asset.endsWith('.html')?'text/html; charset=utf-8':asset.endsWith('.css')?'text/css':asset.endsWith('.woff')?'font/woff':'text/javascript';}
    else{if(['/connect','/event','/reset'].includes(req.path)?req.method!=='POST':req.method!=='GET')throw Error('DISPLAY_METHOD_INVALID');const devices=req.path.startsWith('/runs')?JSON.stringify((await this.database.overview()).devices):'[]';const body=await this.photo.engine.display(req.path,util.TextDecoder.create('utf-8').decodeToString(req.body),req.displayKey??'',this.address,devices);if(req.path.startsWith('/images/')){const image=JSON.parse(body) as DisplayImage;data=new util.Base64Helper().decodeSync(image.data);type=image.mime;}else data=new util.TextEncoder().encodeInto(body);}
   }catch(e){const message=(e as Error).message;status=message==='DISPLAY_KEY_INVALID'||message==='LOCAL_VIEWER_ONLY'?403:400;data=new util.TextEncoder().encodeInto(JSON.stringify({error:message}));}
   const header=new util.TextEncoder().encodeInto('HTTP/1.1 '+status+' OK\r\nContent-Type: '+type+'\r\nContent-Length: '+data.length+'\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n'),wire=new Uint8Array(header.length+data.length);wire.set(header);wire.set(data,header.length);await client.send({data:wire.buffer});await client.close();
  })().catch(()=>{void client.close().catch(()=>{});});}catch{done=true;clearTimeout(timer);void client.close().catch(()=>{});}});
 });await server.listen({address:'0.0.0.0',port:7460,family:1});this.server=server;}
 async close():Promise<void>{for(const c of this.clients)await c.close().catch(()=>{});this.clients.clear();await this.server?.close().catch(()=>{});this.server=null;}
}

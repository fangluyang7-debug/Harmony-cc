import { http } from '@kit.NetworkKit';
import { image } from '@kit.ImageKit';
import { factory, base64, hash } from 'scheduler';
import { PhotoInput, readPhoto } from './PhotoFiles';
interface DisplayInput {name:string;width:number;height:number;hash:string;preview:string;}
interface DisplayProduct {version:number;format:string;width:number;height:number;image:string;hash:string;}
interface DisplayEvent {seq:number;type:string;runId:string;inputs?:DisplayInput[];phase?:string;completed?:number;total?:number;imageIndex?:number;product?:DisplayProduct;durationMs?:number;error?:string;}
interface ConnectionReply {displayOnly:boolean;nextSeq:number;}
/** Observation only: never registers a device/App, submits a job or receives work. */
export class PhotoDisplay {
 private address:string='';private key:string='';private seq:number=0;private runId:string='';
 private queue:Promise<void>=Promise.resolve();
 private failedConnection:boolean=false;
 private report:(message:string)=>void;
 constructor(report:(message:string)=>void){this.report=report;}
 connected():boolean{return this.address!=='';}
 private async post(route:string,body:string):Promise<string>{
  const request=http.createHttp();
  try{const r=await request.request(this.address+route,{method:http.RequestMethod.POST,header:{'Content-Type':'application/json','X-Display-Key':this.key},extraData:body,connectTimeout:2500,readTimeout:5000});if(r.responseCode!==200)throw Error('展示连接返回 '+r.responseCode);return r.result as string;}finally{request.destroy();}
 }
 async connect(value:string):Promise<void>{
  await this.queue;const match=/^(http:\/\/\d{1,3}(?:\.\d{1,3}){3}:\d{1,5})\/#display=([a-f0-9]{36})$/.exec(value.trim());
  if(!match)throw Error('请扫描展示页二维码或粘贴完整展示连接码');
  this.address=match[1];this.key=match[2];this.failedConnection=false;
  try{const reply=JSON.parse(await this.post('/connect','{}')) as ConnectionReply;if(!reply.displayOnly||!Number.isSafeInteger(reply.nextSeq))throw Error('不是仅展示接收端');this.seq=reply.nextSeq-1;this.report('已连接展示屏 · Windows 不参与计算');}catch(e){this.address='';this.key='';throw e as Error;}
 }
 async disconnect():Promise<void>{await this.queue;this.address='';this.key='';this.report('展示屏已断开，本机处理仍可使用');}
 private send(event:DisplayEvent):void{
  if(!this.connected())return;event.seq=++this.seq;const body=JSON.stringify(event);
  this.queue=this.queue.then(async()=>{if(this.failedConnection)return;try{await this.post('/event',body);}catch(e){try{await this.post('/event',body);}catch{this.failedConnection=true;this.report('展示同步中断，请重连；手机本机处理继续。');}}});
 }
 picking():void{this.send({seq:0,type:'PICKING',runId:this.runId});}
 async select(inputs:PhotoInput[]):Promise<void>{
  if(!this.connected()||this.failedConnection)return;const list:DisplayInput[]=[];
  try{
  for(const input of inputs){const data=readPhoto(input.path),source=image.createImageSource(data.slice().buffer as ArrayBuffer);
   try{const scale=Math.min(0.5,160/input.width,120/input.height),pixel=await source.createPixelMap({desiredSize:{width:Math.max(1,Math.round(input.width*scale)),height:Math.max(1,Math.round(input.height*scale))}});
    try{const packer=image.createImagePacker();try{const preview=new Uint8Array(await packer.packing(pixel,{format:'image/jpeg',quality:70}));list.push({name:input.name,width:input.width,height:input.height,hash:hash(data),preview:'data:image/jpeg;base64,'+base64.encodeToStringSync(preview)});}finally{await packer.release();}}finally{await pixel.release();}
   }finally{await source.release();}
  }
  this.runId=factory.id();this.send({seq:0,type:'SELECTED',runId:this.runId,inputs:list});
  }catch(e){this.failedConnection=true;this.report('展示预览未生成，请重连；手机本机处理仍可继续。');}
 }
 start():void{this.send({seq:0,type:'START',runId:this.runId});}
 progress(index:number,phase:string,completed:number,total:number):void{this.send({seq:0,type:'PROGRESS',runId:this.runId,imageIndex:index,phase,completed,total});}
 result(index:number,encoded:string):void{if(this.connected())this.send({seq:0,type:'RESULT',runId:this.runId,imageIndex:index,product:JSON.parse(encoded) as DisplayProduct});}
 finish(durationMs:number):void{this.send({seq:0,type:'FINISH',runId:this.runId,durationMs});}
 failed(error:string,durationMs:number):void{this.send({seq:0,type:'FAILED',runId:this.runId,error,durationMs});}
}

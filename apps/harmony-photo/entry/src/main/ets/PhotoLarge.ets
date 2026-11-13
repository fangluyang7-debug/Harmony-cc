import { common } from '@kit.AbilityKit';
import { image } from '@kit.ImageKit';
import { fileIo } from '@kit.CoreFileKit';
import { SchedulerSdk, SdkTask, factory, base64, hash, text, monotonic, enhancePhotoLocally, encodePhotoRgbFile } from 'scheduler';
import { PhotoInput, PhotoResult, readPhoto } from './PhotoFiles';
import { PhotoTile, photoTiles } from './PhotoTilePlan';
import { photoWorkflow } from './PhotoWorkflow';
import { photoSession } from './PhotoSession';
import { PhotoDisplay } from './PhotoDisplay';
import { recoverPhotoDelivery, transientPhotoTransport } from './PhotoRecovery';
interface Preview {hash:string;originalHash:string;name:string;width:number;height:number;preview:string;}
interface Product {version?:number;image:string;hash:string;width:number;height:number;format:string;previewOnly?:boolean;imageIndex?:number;}
interface Job {id:string;imageIndex:number;tileIndex:number;}
interface LargeMessage {inputs?:Preview[];job?:Job;result?:Product;state?:string;durationMs?:number;error?:string;}
interface Reply {id:string;}
export interface LargeOptions {cancelled:()=>boolean;progress:(done:number,total:number,phase:string)=>void;result:(r:PhotoResult)=>void;}
async function pack(p:image.PixelMap,format:string):Promise<Uint8Array>{const q=image.createImagePacker();try{return new Uint8Array(await q.packing(p,{format,quality:90}));}finally{await q.release();}}
async function preview(path:string,w:number,h:number):Promise<Uint8Array>{const f=fileIo.openSync(path,fileIo.OpenMode.READ_ONLY),s=image.createImageSource(f.fd);try{const k=Math.min(1,480/w,360/h),p=await s.createPixelMap({desiredSize:{width:Math.max(1,Math.floor(w*k)),height:Math.max(1,Math.floor(h*k))}});try{return await pack(p,'image/png');}finally{await p.release();}}finally{await s.release();fileIo.closeSync(f);}}
async function inputPreview(input:PhotoInput):Promise<Preview>{const f=fileIo.openSync(input.path,fileIo.OpenMode.READ_ONLY),s=image.createImageSource(f.fd);try{const k=Math.min(1,160/input.width,120/input.height),p=await s.createPixelMap({desiredSize:{width:Math.max(1,Math.floor(input.width*k)),height:Math.max(1,Math.floor(input.height*k))}});try{const digest=hash(readPhoto(input.path));return {hash:digest,originalHash:digest,name:input.name,width:input.width,height:input.height,preview:'data:image/jpeg;base64,'+base64.encodeToStringSync(await pack(p,'image/jpeg'))};}finally{await p.release();}}finally{await s.release();fileIo.closeSync(f);}}
async function extract(source:image.ImageSource,t:PhotoTile):Promise<Uint8Array>{const p=await source.createPixelMap({desiredRegion:{x:t.left,y:t.top,size:{width:t.inputWidth,height:t.inputHeight}},desiredPixelFormat:image.PixelMapFormat.RGBA_8888});try{const i=await p.getImageInfo();if(i.size.width!==t.inputWidth||i.size.height!==t.inputHeight)throw Error('PHOTO_REGION_DECODE_UNSUPPORTED');return await pack(p,'image/png');}finally{await p.release();}}
async function writeTile(fd:number,fullWidth:number,t:PhotoTile,encoded:Uint8Array):Promise<void>{
 const product=JSON.parse(text(encoded)) as Product,data=base64.decodeSync(product.image);
 if(hash(data)!==product.hash||product.width!==t.inputWidth*4||product.height!==t.inputHeight*4)throw Error('PHOTO_TILE_INTEGRITY');
 const source=image.createImageSource(data.slice().buffer as ArrayBuffer);try{const p=await source.createPixelMap({desiredRegion:{x:(t.x-t.left)*4,y:(t.y-t.top)*4,size:{width:t.width*4,height:t.height*4}},desiredPixelFormat:image.PixelMapFormat.RGBA_8888});try{
  const info=await p.getImageInfo();if(info.size.width!==t.width*4||info.size.height!==t.height*4)throw Error('PHOTO_TILE_GEOMETRY');
  const rgba=new Uint8Array(t.width*t.height*16*4);await p.readPixelsToBuffer(rgba.buffer as ArrayBuffer);const row=new Uint8Array(t.width*12);
  for(let y=0;y<t.height*4;y++){for(let x=0;x<t.width*4;x++){const offset=(y*t.width*4+x)*4;row[x*3]=rgba[offset];row[x*3+1]=rgba[offset+1];row[x*3+2]=rgba[offset+2];}fileIo.lseek(fd,((t.y*4+y)*fullWidth*4+t.x*4)*3,0);if(fileIo.writeSync(fd,row.buffer as ArrayBuffer)!==row.length)throw Error('PHOTO_DISK_WRITE_FAILED');}
 }finally{await p.release();}}finally{await source.release();}
}
/** Full-size photographs use the same per-tile photo DAG, SDK, model and scheduler.
 * The large raster stays on the source phone; the final PNG is encoded row by row. */
export class PhotoLarge {
 private tasks:SdkTask[]=[];
 async cancel():Promise<void>{await Promise.allSettled(this.tasks.map(t=>t.cancel()));}
 async run(context:common.UIAbilityContext,inputs:PhotoInput[],cooperative:boolean,display:PhotoDisplay,options:LargeOptions):Promise<number>{
  if(cooperative)await photoSession.requireReady();else await photoSession.prepareLocal();
  const start=monotonic(),plans=inputs.map(i=>photoTiles(i.width,i.height)),total=plans.reduce((n:number,p:PhotoTile[])=>n+p.length+1,0),budget=Math.min(86400000,Math.max(180000,total*180000));let done=0,runId='',failed=false,reportQueue:Promise<void>=Promise.resolve();
  const check=():void=>{if(options.cancelled()||failed)throw Error('CANCELLED_SETTLED');if(monotonic()-start>=budget)throw Error('PHOTO_BUDGET_EXHAUSTED');};
  const post=async(body:LargeMessage):Promise<Reply>=>JSON.parse(await photoSession.request('/v2/apps/photo',JSON.stringify({route:'/photo-large-runs'+(runId?'/'+runId:''),method:'POST',body}))) as Reply;
  const report=(body:LargeMessage):Promise<void>=>{const p=reportQueue.then(async()=>{await recoverPhotoDelivery(async()=>post(body),()=>Math.max(1,Math.min(30000,budget-(monotonic()-start))),()=>false,()=>{},transientPhotoTransport);});reportQueue=p.catch(()=>{});return p;};
  try{
   if(cooperative){const previews:Preview[]=[];for(const input of inputs){check();previews.push(await inputPreview(input));}runId=(await post({inputs:previews})).id;}
   else{await display.select(inputs);display.start();}
   const parallel=cooperative?Math.min(4,await photoSession.batchConcurrency()):1;
   for(let imageIndex=0;imageIndex<inputs.length;imageIndex++){
    check();const input=inputs[imageIndex],tiles=plans[imageIndex],id=factory.id(),raw=context.cacheDir+'/photo-large-'+id+'.rgb',output=context.filesDir+'/photo-result-'+id+'.png',f=fileIo.openSync(input.path,fileIo.OpenMode.READ_ONLY),source=image.createImageSource(f.fd),target=fileIo.openSync(raw,fileIo.OpenMode.CREATE|fileIo.OpenMode.TRUNC|fileIo.OpenMode.READ_WRITE);
    let next=0,settled=0,delivered=false;const errors:Error[]=[];
    const worker=async():Promise<void>=>{while(next<tiles.length){check();const tile=tiles[next++];options.progress(done,total,'照片 '+(imageIndex+1)+' · 原分辨率图块 '+(tile.index+1)+' / '+tiles.length);const bytes=await extract(source,tile);let result:Uint8Array;
     if(cooperative){const jobId=factory.id(),sdk=new SchedulerSdk(photoSession.workflowPort(options.cancelled,async()=>{})),ref=await sdk.registerInput(bytes,'image.raster');let task:SdkTask|null=null,timer:number=-1;const job:Job={id:jobId,imageIndex,tileIndex:tile.index};
      try{const tileBudget=Math.min(180000,budget-(monotonic()-start));task=await sdk.submit(photoWorkflow(jobId,ref,tile.inputWidth,tile.inputHeight),{requestId:jobId,budgetMs:tileBudget,resultDestination:'ORIGIN',inputLocation:'ORIGIN'});this.tasks.push(task);await report({job});let reporting=false;timer=setInterval(()=>{if(reporting)return;reporting=true;void report({job}).catch(()=>{}).finally(()=>{reporting=false;});},2000);
       const current=task;result=(await recoverPhotoDelivery(async()=>current.result(Math.max(1,Math.min(180000,budget-(monotonic()-start)))),()=>budget-(monotonic()-start),options.cancelled,()=>{},transientPhotoTransport)).output;clearInterval(timer);timer=-1;await report({job});
      }catch(e){if(task)await task.cancel().catch(()=>{});throw e as Error;}finally{if(timer!==-1)clearInterval(timer);if(task){this.tasks=this.tasks.filter(t=>t.id!==jobId);if(options.cancelled()||failed)await task.cancel().catch(()=>{});}sdk.releaseInput(ref);}
     }else result=await enhancePhotoLocally(context,bytes,{cancelled:()=>options.cancelled()||monotonic()-start>=budget,progress:p=>{options.progress(done,total,'照片 '+(imageIndex+1)+' · 图块 '+(tile.index+1)+' / '+tiles.length+' · '+p.stage);display.progress(imageIndex,p.stage,settled,tiles.length);}});
     check();await writeTile(target.fd,input.width,tile,result);settled++;done++;options.progress(done,total,'照片 '+(imageIndex+1)+' · 已完成 '+settled+' / '+tiles.length+' 个原分辨率图块');
    }};
    try{const workers:Promise<void>[]=[];for(let n=0;n<Math.min(parallel,tiles.length);n++)workers.push(worker().catch((e:Error)=>{failed=true;errors.push(e);void this.cancel();}));await Promise.all(workers);if(errors.length)throw errors[0];check();if(settled!==tiles.length)throw Error('PHOTO_MISSING_TILE');options.progress(done,total,'正在生成原分辨率高清成品 · 不缩小像素');await encodePhotoRgbFile(raw,output,input.width*4,input.height*4);check();const result:PhotoResult={id,name:input.name,path:output,width:input.width*4,height:input.height*4,saved:false},previewBytes=await preview(output,result.width,result.height),product:Product={version:1,imageIndex,width:result.width,height:result.height,format:'png',image:base64.encodeToStringSync(previewBytes),hash:hash(previewBytes),previewOnly:true};
     if(cooperative)await report({result:product});else display.result(imageIndex,JSON.stringify(product));done++;options.result(result);delivered=true;
    }finally{await source.release();fileIo.closeSync(f);fileIo.closeSync(target);if(fileIo.accessSync(raw))fileIo.unlinkSync(raw);if(!delivered&&fileIo.accessSync(output))fileIo.unlinkSync(output);}
   }
   const duration=monotonic()-start;if(cooperative)await report({state:'SUCCEEDED',durationMs:duration});else display.finish(duration);options.progress(total,total,'处理完成 · 原分辨率成品可保存到相册');return duration;
  }catch(e){await this.cancel();if(cooperative&&runId)await report({state:options.cancelled()?'CANCELLED':'FAILED',durationMs:monotonic()-start,error:(e as Error).message}).catch(()=>{});else if(!cooperative)display.failed((e as Error).message,monotonic()-start);throw e as Error;}
 }
}

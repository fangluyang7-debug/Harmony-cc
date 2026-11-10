import { common } from '@kit.AbilityKit';
import { image } from '@kit.ImageKit';
import { SchedulerSdk, SdkTask, factory, base64, hash, text, monotonic } from 'scheduler';
import { photoSession } from './PhotoSession';
import { PhotoInput, PhotoResult, readPhoto, storePhotoResult } from './PhotoFiles';
import { photoWorkflow } from './PhotoWorkflow';
interface InputMeta {name:string;bytes:number;originalHash:string;hash:string;width:number;height:number;}
interface Prepared {meta:InputMeta;data:Uint8Array;}
interface PhotoJob {id:string;imageIndex:number;}
interface Delivery {imageIndex:number;hash:string;}
interface Mutation {revision?:number;mode?:string;budgetMs?:number;inputs?:InputMeta[];state?:string;jobs?:PhotoJob[];deliveredImage?:Delivery;sourceDurationMs?:number;error?:string;}
interface Message {route:string;method:string;body?:Mutation;data?:string;}
interface NodeView {id:string;state:string;committed:boolean;}
interface WorkflowView {imageIndex:number;nodes:NodeView[];}
interface Run {id:string;revision:number;jobs:PhotoJob[];workflows?:WorkflowView[];}
export interface BatchProgress {phase:string;completed:number;total:number;}
export interface BatchOptions {cancelled:()=>boolean;progress:(value:BatchProgress)=>void;result:(index:number,value:PhotoResult)=>void;}
function label(id:string):string{switch(id.split('-')[0]){case 'analyze':return '分析照片';case 'prepare':return '准备图块';case 'enhance':return 'AI 高清增强';case 'assemble':return '合成并校验';case 'deliver':return '交付高清成品';default:return '正在处理';}}
async function request(route:string,method:string='GET',body?:Mutation,data?:Uint8Array):Promise<Run>{
 const message:Message={route,method};if(body)message.body=body;if(data)message.data=base64.encodeToStringSync(data);
 return JSON.parse(await photoSession.request('/v2/apps/photo',JSON.stringify(message))) as Run;
}
async function prepare(input:PhotoInput):Promise<Prepared>{
 const original=readPhoto(input.path),source=image.createImageSource(original.slice().buffer as ArrayBuffer),packer=image.createImagePacker();
 try{const pixels=await source.createPixelMap();try{const data=new Uint8Array(await packer.packing(pixels,{format:'image/png',quality:100}));if(data.length>8388608)throw Error('图片编码后超过 8 MiB');return {data,meta:{name:input.name,bytes:data.length,originalHash:hash(original),hash:hash(data),width:input.width,height:input.height}};}finally{await pixels.release();}}
 finally{await source.release();await packer.release();}
}
/** Native business orchestration. No device dispatch, credentials or forced target IDs. */
export class PhotoBatch {
 private tasks:SdkTask[]=[];
 async cancel():Promise<void>{await Promise.allSettled(this.tasks.map(task=>task.cancel()));}
 async run(context:common.UIAbilityContext,inputs:PhotoInput[],options:BatchOptions):Promise<number>{
  if(inputs.length<1||inputs.length>8)throw Error('请选择 1～8 张照片');
  const began=monotonic(),budget=180000,prepared:Prepared[]=[];let run:Run|null=null,queue:Promise<void>=Promise.resolve(),polling=false,active=true;
  const check=():void=>{if(options.cancelled())throw Error('已取消');if(monotonic()-began>=budget)throw Error('180 秒预算已用尽');};
  const update=(changes:Mutation,job?:PhotoJob):Promise<void>=>{const next=queue.then(async()=>{if(!run)throw Error('PHOTO_RUN_REQUIRED');if(job)changes.jobs=[...run.jobs,job];changes.revision=run.revision;run=await request('/photo-runs/'+run.id,'POST',changes);});queue=next.catch(()=>{});return next;};
  const total=inputs.reduce((count:number,i:PhotoInput)=>{const edge=Math.max(64,Math.ceil(Math.max(i.width,i.height)/2));return count+3+2*Math.ceil(i.width/edge)*Math.ceil(i.height/edge);},0);
  const watch=async():Promise<void>=>{if(polling||!run||!active)return;polling=true;try{const view=await request('/photo-runs/'+run.id);if(!active)return;let done=0,current='等待任务规划';for(const w of view.workflows??[]){for(const n of w.nodes){if(n.committed)done++;else if(['RUNNING','ACCEPTED'].includes(n.state))current='照片 '+(w.imageIndex+1)+' · '+label(n.id);}}options.progress({phase:current,completed:done,total});}catch{/* Display polling cannot abort computation. */}finally{polling=false;}};
  const timer=setInterval(()=>{void watch();},750);
  try{
   options.progress({phase:'正在准备原始照片',completed:0,total:1});
   for(const input of inputs){check();prepared.push(await prepare(input));}
   check();run=await request('/photo-runs','POST',{mode:'COOPERATIVE',budgetMs:budget,inputs:prepared.map(p=>p.meta)});
   for(let i=0;i<prepared.length;i++){check();await request('/photo-runs/'+run.id+'/input?image='+i,'PUT',undefined,prepared[i].data);}
   await update({state:'RUNNING'});let next=0;const failures:string[]=[];
   const worker=async():Promise<void>=>{
    while(next<prepared.length&&!options.cancelled()){
     const i=next++,src=prepared[i],id=factory.id();let task:SdkTask|null=null;
     const port=photoSession.workflowPort(options.cancelled,async()=>{if(!run)throw Error('PHOTO_RUN_REQUIRED');await request('/photo-runs/'+run.id+'/capture-result?image='+i,'POST',{});});
     const sdk=new SchedulerSdk(port),input=await sdk.registerInput(src.data,'image.raster');
     try{
      check();task=await sdk.submit(photoWorkflow(id,input,src.meta.width,src.meta.height),{requestId:id,budgetMs:Math.floor(budget-(monotonic()-began)),resultDestination:'ORIGIN'});this.tasks.push(task);
      // The capture hook must know this job before read/received can release output.
      await update({},{id:task.id,imageIndex:i});
      if(options.cancelled()){await task.cancel();throw Error('已取消');}
      const result=await task.result(Math.max(1,Math.min(300000,budget-(monotonic()-began)+5000))),stored=await storePhotoResult(context,text(result.output),inputs[i].name);
      if(stored.width!==src.meta.width*4||stored.height!==src.meta.height*4)throw Error('PHOTO_RESULT_GEOMETRY');
      await update({deliveredImage:{imageIndex:i,hash:stored.id}});options.result(i,stored);
     }catch(e){failures.push(inputs[i].name+'：'+(e as Error).message);try{await (task??sdk.resume(id)).cancel();}catch{} }
     finally{if(task)this.tasks=this.tasks.filter(t=>t.id!==id);sdk.releaseInput(input);}
    }
   };
   const workers:Promise<void>[]=[];for(let i=0;i<Math.min(2,inputs.length);i++)workers.push(worker().catch((e:Error)=>{failures.push(e.message);}));await Promise.all(workers);
   if(options.cancelled())throw Error('已取消');if(failures.length)throw Error(failures.join('；'));
   const duration=monotonic()-began;await update({state:'SUCCEEDED',sourceDurationMs:duration});options.progress({phase:'处理完成',completed:1,total:1});return duration;
  }catch(e){await this.cancel();if(run)try{await update({state:options.cancelled()?'CANCELLED':'FAILED',error:(e as Error).message,sourceDurationMs:monotonic()-began});}catch{}throw e as Error;}
  finally{active=false;clearInterval(timer);}
 }
}

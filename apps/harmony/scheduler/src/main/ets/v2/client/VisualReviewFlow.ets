import { SchedulerSdk, SdkTask, SdkInput, SdkStatus } from './SchedulerSdk';
export interface ReviewImage {id:string;width:number;height:number;rgb:Uint8Array;}
export interface ReviewPair {a:string;b:string;scoreMillion:number;comparisons:number;}
export interface ReviewOutput {algorithm:string;pairs:ReviewPair[];}
export interface ReviewTarget {deviceId:string;targetId:string;slots:number;}
export interface ReviewJob {id:string;index:number;pairs:number;state:string;targetId:string;deviceId?:string;traceId:string;inputHash:string;outputHash:string;error:string;}
export interface ReviewRun {id:string;mode:string;state:string;startedAt:number;durationMs:number;sourceHash:string;inputHashes:string[];resultHash:string;uploadedBytes:number;jobs:ReviewJob[];pairs:ReviewPair[];error:string;}
export interface ReviewPort {
 sdk:SchedulerSdk;now():number;id():string;digest(bytes:Uint8Array):Promise<string>;
 load():Promise<ReviewImage[]>;pack(raw:Uint8Array):Promise<Uint8Array>;encode(text:string):Uint8Array;decode(bytes:Uint8Array):string;
 save(run:ReviewRun):Promise<void>;cancelled():boolean;
 observeStatus?(listener:((status:SdkStatus)=>void)|null):void;
}
export function reviewPartitions(count:number):number[][][]{
 if(!Number.isInteger(count)||count<2||count>32)throw Error('VISUAL_IMAGE_COUNT');
 const parts:number[][][]=[];
 for(let a=0;a<count;a+=8)for(let b=a;b<count;b+=8){const part:number[][]=[];for(let i=a;i<Math.min(a+8,count);i++)for(let j=b;j<Math.min(b+8,count);j++)if(i<j)part.push([i,j]);if(part.length)parts.push(part);}
 return parts.sort((a:number[][],b:number[][])=>b.length-a.length);
}
export function reviewRaw(images:ReviewImage[],pairs:number[][],encode:(s:string)=>Uint8Array):Uint8Array{
 const used:number[]=[];for(const pair of pairs)for(const index of pair)if(!used.includes(index))used.push(index);used.sort((a:number,b:number)=>a-b);
 const selected=used.map((i:number)=>images[i]);let size=8+pairs.length*8;
 for(const im of selected){if(!/^[A-Za-z0-9_.-]{1,100}$/.test(im.id)||im.width<32||im.height<32||im.width>512||im.height>512||im.rgb.length!==im.width*im.height*3)throw Error('VISUAL_IMAGE_INVALID');size+=12+encode(im.id).length+im.rgb.length;}
 if(size>33554432)throw Error('VISUAL_RAW_SIZE');const raw=new Uint8Array(size),view=new DataView(raw.buffer);let pos=0;
 const u32=(n:number):void=>{view.setUint32(pos,n,true);pos+=4;};u32(selected.length);u32(pairs.length);
 for(const im of selected){const id=encode(im.id);u32(id.length);raw.set(id,pos);pos+=id.length;u32(im.width);u32(im.height);raw.set(im.rgb,pos);pos+=im.rgb.length;}
 for(const pair of pairs){u32(used.indexOf(pair[0]));u32(used.indexOf(pair[1]));}return raw;
}
export function reviewMerge(ids:string[],outputs:ReviewOutput[]):ReviewPair[]{
 const seen=new Set<string>(),pairs:ReviewPair[]=[];
 for(const output of outputs){if(output.algorithm!=='dense-hog-rgb-graph-v1'||!Array.isArray(output.pairs))throw Error('VISUAL_RESULT_INVALID');for(const p of output.pairs){const a=ids.indexOf(p.a),b=ids.indexOf(p.b),key=a+':'+b;if(a<0||b<=a||seen.has(key)||!Number.isSafeInteger(p.scoreMillion)||p.scoreMillion<0||p.scoreMillion>1000000||!Number.isSafeInteger(p.comparisons)||p.comparisons<0)throw Error('VISUAL_RESULT_INVALID');seen.add(key);pairs.push(p);}}
 if(pairs.length!==ids.length*(ids.length-1)/2)throw Error('VISUAL_RESULT_INCOMPLETE');return pairs.sort((a:ReviewPair,b:ReviewPair)=>ids.indexOf(a.a)-ids.indexOf(b.a)||ids.indexOf(a.b)-ids.indexOf(b.b));
}
/** Foreground source orchestration; both modes use the identical SDK and input path. */
export async function runVisualReview(port:ReviewPort,phone:ReviewTarget,computer:ReviewTarget|null,mode:string):Promise<ReviewRun>{
 if(!['PHONE','TEAM'].includes(mode)||mode==='TEAM'&&(!computer||computer.deviceId===phone.deviceId))throw Error('TWO_DISTINCT_DEVICES_REQUIRED');
 const start=port.now(),run:ReviewRun={id:port.id(),mode,state:'PREPARING',startedAt:Date.now(),durationMs:0,sourceHash:'',inputHashes:[],resultHash:'',uploadedBytes:0,jobs:[],pairs:[],error:''};await port.save(run);
 const tasks:SdkTask[]=[];let stopped=false;
 port.observeStatus?.((status:SdkStatus)=>{const job=run.jobs.find(j=>j.id===status.jobId);if(!job||job.state===status.state)return;job.state=status.state;job.targetId=status.targetId;job.deviceId=status.deviceId;job.traceId=status.traceId;void port.save(run).catch(()=>{stopped=true;run.error='PROGRESS_SAVE_FAILED';});});
 try{
  const images=await port.load(),parts=reviewPartitions(images.length),inputs:Uint8Array[]=[];
  const hashes:string[]=[];for(const im of images)hashes.push(im.id+':'+im.width+':'+im.height+':'+await port.digest(im.rgb));run.sourceHash=await port.digest(port.encode(hashes.join('|')));
  for(const part of parts){if(port.cancelled())throw Error('USER_CANCELLED');const bytes=await port.pack(reviewRaw(images,part,(s:string)=>port.encode(s)));inputs.push(bytes);run.inputHashes.push(await port.digest(bytes));}
  if(mode==='TEAM'&&parts.length<2)throw Error('NEED_MORE_IMAGES_FOR_PARALLEL_REVIEW');
  run.state='RUNNING';await port.save(run);const outputs:ReviewOutput[]=new Array<ReviewOutput>(parts.length);let cursor=0;
  const concurrency=Math.min(parts.length,mode==='PHONE'?phone.slots:phone.slots+computer!.slots);
  const worker=async():Promise<void>=>{while(!stopped&&cursor<parts.length){const index=cursor++,id=port.id();
   // Explicit coverage mode: phone computes one real shard concurrently with
   // the selected computer. All constraints still go through PlanningService.
   const target=mode==='PHONE'||index===0?phone:computer!;
   const job:ReviewJob={id,index,pairs:parts[index].length,state:'SUBMITTING',targetId:'',traceId:'',inputHash:run.inputHashes[index],outputHash:'',error:''};run.jobs.push(job);await port.save(run);
   let input:SdkInput|null=null;
   try{input=await port.sdk.registerInput(inputs[index],'image.visual-bundle');if(port.cancelled()||port.now()-start>=120000)throw Error('WORKFLOW_CANCELLED_OR_BUDGET');
    const task=await port.sdk.submit({version:3,id,outputContract:'image.visual-evidence',qualityTarget:'reference',nodes:[{id:'visual-review',capability:'image.visual-match.v1',input,parameters:'{}',dependsOn:[],targetId:target?.targetId}]},{requestId:id,budgetMs:30000,resultDestination:'ORIGIN'});tasks.push(task);run.uploadedBytes+=inputs[index].length;
    const result=await task.result(Math.max(1,Math.min(45000,120000-(port.now()-start))));
    if(result.status.state!=='SUCCEEDED'||target&&result.status.targetId!==target.targetId)throw Error('VISUAL_TARGET_OR_RESULT_INVALID');
    job.state=result.status.state;job.deviceId=result.status.deviceId;job.targetId=result.status.targetId;job.traceId=result.status.traceId;job.outputHash=await port.digest(result.output);outputs[index]=JSON.parse(port.decode(result.output)) as ReviewOutput;
   }catch(e){stopped=true;job.state='FAILED';job.error=(e as Error).message;run.error=job.error;}
   finally{if(input)port.sdk.releaseInput(input);await port.save(run);}
  }};
  const workers:Promise<void>[]=[];for(let i=0;i<Math.max(1,concurrency);i++)workers.push(worker());await Promise.all(workers);
  if(stopped||port.cancelled())throw Error(run.error||'USER_CANCELLED');
  run.pairs=reviewMerge(images.map((im:ReviewImage)=>im.id),outputs);run.resultHash=await port.digest(port.encode(JSON.stringify(run.pairs)));
  if(mode==='TEAM'&&(!run.jobs.some((j:ReviewJob)=>j.deviceId===phone.deviceId)||!run.jobs.some((j:ReviewJob)=>j.deviceId===computer!.deviceId)))throw Error('BOTH_DEVICES_NOT_OBSERVED');
  if(port.now()-start>120000)throw Error('WORKFLOW_BUDGET_EXHAUSTED');run.state='SUCCEEDED';
 }catch(e){run.state='FAILED';run.error=(e as Error).message;for(const task of tasks){try{await task.cancel();}catch(_){}}}
 port.observeStatus?.(null);run.durationMs=port.now()-start;await port.save(run);return run;
}

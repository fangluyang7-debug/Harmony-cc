import { SchedulerSdk, SdkInput, SdkTask, ReviewImage, ReviewPair, ReviewOutput, reviewRaw } from 'scheduler';

export interface ShoppingCostEvidence { localMs:number; dispatchRoundTripMs:number; remoteAvailable:boolean; }
export interface ShoppingComputeDecision { collaborate:boolean; reason:string; }
// A connected SDK always submits work; the coordinator chooses local or remote.
// Historical phone timings are observations, not a gate that hides first-run work.
export function shoppingDecision(parts:number,evidence:ShoppingCostEvidence|null):ShoppingComputeDecision {
 return {collaborate:true,reason:'COORDINATOR_PLACEMENT'};
}
export interface ShoppingComputeJob {id:string;deviceId:string;traceId:string;state:string;error?:string;}
export interface ShoppingMatchResult {pairs:ReviewPair[];decision:ShoppingComputeDecision;executionMode:string;computeMs:number;preparationMs:number;jobs:ShoppingComputeJob[];}
export interface ShoppingComputePort {
 sdk:SchedulerSdk|null;originTarget:string|null;originDevice:string;localConcurrency:number;
 now():number;id():string;encode(s:string):Uint8Array;decode(data:Uint8Array):string;
 pack(raw:Uint8Array):Promise<Uint8Array>;local(data:Uint8Array):Promise<Uint8Array>;
 cancelled():boolean;deadline:number;
 observe?(job:ShoppingComputeJob):void;
}
// Only query -> returned candidate pairs. No candidate all-pairs work or repeat rounds.
export function shoppingPairs(count:number):number[][][]{
 if(!Number.isInteger(count)||count<2||count>32)throw Error('SHOPPING_IMAGE_COUNT');
 // A small first shard avoids making the slower origin the critical path.
 // Local and team modes use these exact same partitions; every pair is useful.
 const parts:number[][][]=[[[0,1]]];for(let i=2;i<count;i+=8){const part:number[][]=[];for(let j=i;j<Math.min(i+8,count);j++)part.push([0,j]);parts.push(part);}return parts;
}
export async function matchShoppingPhoto(images:ReviewImage[],port:ShoppingComputePort,evidence:ShoppingCostEvidence|null):Promise<ShoppingMatchResult>{
 const parts=shoppingPairs(images.length),decision=shoppingDecision(parts.length,evidence);
 if(!port.sdk){decision.collaborate=false;decision.reason='LOCAL_HOST_NOT_READY';}
 const output:ReviewOutput[]=[],jobs:ShoppingComputeJob[]=[],tasks:SdkTask[]=[];let cursor=0,failed:Error|null=null,preparationMs=0;
 const started=port.now();
 const check=():void=>{if(port.cancelled())throw Error('SHOPPING_CANCELLED');if(port.now()>=port.deadline)throw Error('SHOPPING_BUDGET_EXHAUSTED');};
 const worker=async():Promise<void>=>{while(cursor<parts.length&&!failed){const index=cursor++;let input:SdkInput|null=null,job:ShoppingComputeJob|null=null;
  try{check();const prepare=port.now(),data=await port.pack(reviewRaw(images,parts[index],port.encode));preparationMs+=port.now()-prepare;check();
   let bytes:Uint8Array;
   if(decision.collaborate){const sdk=port.sdk!,id=port.id();job={id,deviceId:'',traceId:'',state:'SUBMITTING'};jobs.push(job);port.observe?.(job);input=await sdk.registerInput(data,'image.visual-bundle');check();
    const task=await sdk.submit({version:3,id,outputContract:'image.visual-evidence',qualityTarget:'reference',nodes:[{id:'photo-candidates',capability:'image.visual-match.v1',input,parameters:'{}',dependsOn:[]}]},
     {requestId:id,budgetMs:Math.min(30000,Math.max(1,Math.floor(port.deadline-port.now()))),resultDestination:'ORIGIN',inputLocation:'ORIGIN'});
    tasks.push(task);job.state='SUBMITTED';port.observe?.(job);
    const result=await task.result(Math.max(1,Math.min(30000,port.deadline-port.now())));bytes=result.output;job.deviceId=result.status.deviceId;job.traceId=result.status.traceId;job.state=result.status.state;
   }else{bytes=await port.local(data);jobs.push({id:'local-'+index,deviceId:port.originDevice,traceId:'',state:'SUCCEEDED'});}
   check();const value=JSON.parse(port.decode(bytes)) as ReviewOutput;
   if(value.algorithm!=='dense-hog-rgb-graph-v1'||value.pairs.length!==parts[index].length)throw Error('SHOPPING_MATCH_RESULT_INVALID');
   const expected=parts[index].map(p=>images[p[1]].id),seen=new Set<string>();
   for(const pair of value.pairs){if(pair.a!==images[0].id||!expected.includes(pair.b)||seen.has(pair.b)||!Number.isInteger(pair.scoreMillion)||pair.scoreMillion<0||pair.scoreMillion>1000000)throw Error('SHOPPING_MATCH_RESULT_INVALID');seen.add(pair.b);}
   output[index]=value;
   }catch(e){failed=e as Error;if(job){job.state='FAILED_OR_UNCONFIRMED';job.error=(e as Error).message;}}
   finally{if(job)port.observe?.(job);if(input)port.sdk!.releaseInput(input);}
 }};
 const workers:Promise<void>[]=[];const concurrency=decision.collaborate?Math.min(4,parts.length):Math.max(1,Math.min(port.localConcurrency,parts.length));
 for(let n=0;n<concurrency;n++)workers.push(worker());await Promise.all(workers);
 if(failed){await Promise.all(tasks.map(t=>t.cancel().catch(()=>'')));throw failed as Error;}
 const pairs:ReviewPair[]=[];for(const item of output)pairs.push(...item.pairs);
 if(pairs.length!==images.length-1)throw Error('SHOPPING_MATCH_INCOMPLETE');
 const executionMode=!decision.collaborate?'LOCAL':new Set<string>(jobs.map(j=>j.deviceId)).size>1?'MULTI_DEVICE_SDK':'SINGLE_DEVICE_SDK';
 if(executionMode==='SINGLE_DEVICE_SDK')decision.reason='PLANNER_SELECTED_SINGLE_DEVICE';
 return {pairs,decision,executionMode,computeMs:port.now()-started,preparationMs,jobs};
}

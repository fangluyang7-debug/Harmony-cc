import {scaledWorkKey,CostEstimatePolicy,costEstimatePolicy,ComputeSample,canonical,workKeyV2,TraceSpanV2} from '@harmony/scheduler-core';
import {Prisma,PrismaClient} from '../generated/client';

interface Observation {id:string;observedAt?:number;bucket?:string;workKey?:string;configId?:string;ms:number;}
interface Window {identity:string;generation:number;samples:Observation[];}
export async function observeExecution(tx:Prisma.TransactionClient,group:string,holder:string,span:TraceSpanV2){
  if(span.phase!=='EXECUTE'||span.measurementScope!=='LOCAL_INTERVAL'||span.authoritativeSide!=='SELF'||span.durationMs<=0)return;
  const row=await tx.cpuJob.findUnique({where:{id:span.attemptId}});
  if(!row)return;
  const data=JSON.parse(row.metadataJson),e=data.decisionEvidence;
  if(!e?.executionIdentity||!e.calibrationGeneration||span.snapshotVersion!==e.snapshotVersion||
    data.traceId!==span.traceId||data.holderId!==holder||data.offer.target.targetId!==span.targetId||data.offer.allowedConfigs.length!==1)return;
  const targetKey=JSON.stringify([group,holder,span.targetId]);
  const current=await tx.calibrationJob.findUnique({where:{id:targetKey}});
  if(!current)return;
  const job=JSON.parse(current.metadataJson);
  if(job.identity!==e.executionIdentity||job.generation!==e.calibrationGeneration)return;
  const id='execute:'+targetKey,stored=await tx.costObservation.findUnique({where:{id}});
  let window:Window=stored?JSON.parse(stored.metadataJson):{identity:job.identity,generation:job.generation,samples:[]};
  if(window.identity!==job.identity||window.generation!==job.generation)window={identity:job.identity,generation:job.generation,samples:[]};
  if(window.samples.some(s=>s.id===row.id))return;
  let workKey:string;
  try{workKey=workKeyV2(data.offer.task.contract,data.offer.task.parameters,data.input.bytes);}catch{return;}
  const configId=data.offer.allowedConfigs[0].id;
  if(typeof configId!=='string')return;
  window.samples.push({id:row.id,observedAt:Date.now(),workKey,configId,ms:span.durationMs});window.samples=window.samples.slice(-32);
  const fields={groupId:group,revision:job.generation,metadataJson:JSON.stringify(window)};
  await tx.costObservation.upsert({where:{id},create:{id,...fields},update:fields});
}
type SplitReceipt={id:string;overheadMs:number|null;startup:string|null};

function summarize(samples:Observation[],receipts:Map<string,SplitReceipt>,policy:CostEstimatePolicy):ComputeSample[]{
  const groups=new Map<string,{workKey:string;configId:string;startup:string;executionTotal:boolean;times:number[];overheads:number[];oldest:number}>();
  for(const sample of samples){
    const receipt=receipts.get(sample.id);
    if(!receipt)continue;
    const executionTotal=receipt.overheadMs===null,startup=receipt.startup??'UNKNOWN',overhead=receipt.overheadMs??0;
    if(!Number.isFinite(overhead)||overhead<0||overhead>sample.ms)continue;
    const id=canonical([sample.workKey,sample.configId,startup,executionTotal]);
    const group=groups.get(id)??{workKey:sample.workKey!,configId:sample.configId!,startup,executionTotal,times:[],overheads:[],oldest:sample.observedAt!};
    group.times.push(sample.ms-overhead);group.overheads.push(overhead);
    group.oldest=Math.min(group.oldest,sample.observedAt!);groups.set(id,group);
  }
  const rank=(values:number[],q:number)=>values[Math.ceil(values.length*q)-1];
  return [...groups.values()].filter(g=>g.times.length>=(scaledWorkKey(g.workKey)?1:policy.minSamples)).slice(-16).map(g=>{
    g.times.sort((a,b)=>a-b);g.overheads.sort((a,b)=>a-b);
    return {workKey:g.workKey,configId:g.configId,startup:g.startup,count:g.times.length,p50Ms:rank(g.times,.5),p90Ms:rank(g.times,.9),coldP50Ms:rank(g.overheads,.5),observedAt:g.oldest,ttlMs:policy.sampleTtlMs,...(g.executionTotal?{executionTotal:true}:{})};
  });
}

/** Share one consistent read across the targets in this group snapshot. */
export async function computeHistories(tx:Prisma.TransactionClient,groupId:string,identities:Map<string,string>,now:number,policy:CostEstimatePolicy=costEstimatePolicy()){
  const histories=new Map<string,ComputeSample[]>();
  const stored=await tx.costObservation.findMany({where:{groupId,id:{startsWith:'execute:'}},select:{id:true,metadataJson:true}});
  if(!stored.length)return histories;
  const jobs=await tx.calibrationJob.findMany({where:{groupId},select:{id:true,metadataJson:true}});
  const calibrations=new Map(jobs.map(r=>[r.id,JSON.parse(r.metadataJson)]));
  const windows=new Map<string,Observation[]>(),attempts=new Set<string>();
  for(const row of stored){
    const key=row.id.slice('execute:'.length),identity=identities.get(key),calibration=calibrations.get(key);
    if(!identity||calibration?.identity!==identity)continue;
    const window:Window=JSON.parse(row.metadataJson);
    if(window.identity!==identity||window.generation!==calibration.generation)continue;
    const live=window.samples.slice(-policy.windowSamples).filter(s=>s.workKey&&s.configId&&s.observedAt!==undefined&&s.observedAt<=now&&now-s.observedAt<=policy.sampleTtlMs);
    if(!live.length)continue;
    windows.set(key,live);for(const sample of live)attempts.add(sample.id);
  }
  const ids=[...attempts],receipts=new Map<string,SplitReceipt>();
  // Keep SQLite bind parameter counts bounded even in a large group.
  for(let i=0;i<ids.length;i+=500){
    const batch=await tx.receipt.findMany({where:{id:{in:ids.slice(i,i+500)},committed:true},select:{id:true,overheadMs:true,startup:true}});
    for(const receipt of batch)receipts.set(receipt.id,receipt);
  }
  for(const [key,window] of windows)histories.set(key,summarize(window,receipts,policy));
  return histories;
}

export async function sustainedDrift(db:PrismaClient,targetKey:string,identity:string,generation:number){
  const stored=await db.costObservation.findUnique({where:{id:'execute:'+targetKey}});
  if(!stored||stored.revision!==generation)return false;
  const window:Window=JSON.parse(stored.metadataJson);
  if(window.identity!==identity||window.samples.length<6)return false;
  const receipts=await db.receipt.findMany({where:{id:{in:window.samples.map(s=>s.id)},committed:true},select:{id:true}});
  const successful=new Set(receipts.map(r=>r.id)),buckets=new Map<string,number[]>();
  for(const s of window.samples){
    if(!successful.has(s.id))continue;
    const key=s.workKey&&s.configId?canonical([s.workKey,s.configId]):s.bucket;
    if(!key)continue;
    const values=buckets.get(key)??[];values.push(s.ms);buckets.set(key,values);
  }
  for(const values of buckets.values()){
    if(values.length<6)continue;
    const baseline=values.slice(0,3).sort((a,b)=>a-b)[1];
    if(values.slice(-3).every(ms=>ms>Math.max(baseline*2,baseline+50)))return true;
  }
  return false;
}

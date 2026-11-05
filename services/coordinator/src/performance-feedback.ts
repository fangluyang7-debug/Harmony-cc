import {canonical,workKeyV2,TraceSpanV2} from '@harmony/scheduler-core';
import {Prisma,PrismaClient} from '../generated/client';

interface Observation {id:string;bucket?:string;workKey?:string;configId?:string;ms:number;}
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
  window.samples.push({id:row.id,workKey,configId,ms:span.durationMs});window.samples=window.samples.slice(-32);
  const fields={groupId:group,revision:job.generation,metadataJson:JSON.stringify(window)};
  await tx.costObservation.upsert({where:{id},create:{id,...fields},update:fields});
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

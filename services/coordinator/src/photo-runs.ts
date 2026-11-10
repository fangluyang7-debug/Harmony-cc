import {photoReference} from '@harmony/reference-capabilities';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {PrismaClient} from '../generated/client';
import {attemptTraceRows} from './dashboard-history';
/** Read model only. Submission and execution remain exclusively in SchedulerSdk. */
export class PhotoRuns {
 private mutations=Promise.resolve();
 constructor(private directory:string,private db:PrismaClient,private domain:string){}
 private file(group:string,id:string){if(!/^[a-zA-Z0-9-]{1,80}$/.test(group)||!/^[a-zA-Z0-9-]{1,80}$/.test(id))throw Error('PHOTO_RUN_INVALID');return path.join(this.directory,'photo-runs',group,id+'.json');}
 async create(group:string,userId:string,body:any,appInstanceId?:string){
  if(!Array.isArray(body.inputs)||!body.inputs.length||body.inputs.length>8||!['LOCAL','COOPERATIVE','LOCAL_PROCESS_TEST'].includes(body.mode)||!Number.isSafeInteger(body.budgetMs)||body.budgetMs<1000||body.budgetMs>300000)throw Error('PHOTO_RUN_INVALID');
  for(const i of body.inputs)if(typeof i.name!=='string'||i.name.length>180||!/^[a-f0-9]{64}$/.test(i.hash)||!Number.isSafeInteger(i.bytes)||i.bytes<1||i.bytes>8388608)throw Error('PHOTO_RUN_INVALID');
  const sourceDeviceId=typeof body.sourceDeviceId==='string'?body.sourceDeviceId:'';
  if(sourceDeviceId){const device=await this.db.spaceDevice.findUnique({where:{id:sourceDeviceId}});if(!device||device.userId!==userId||device.spaceId!==group)throw Error('PHOTO_SOURCE_SCOPE');}
  if(body.mode==='LOCAL'&&!sourceDeviceId)throw Error('PHOTO_SOURCE_REQUIRED');
  const r={domain:this.domain,sourceDeviceId,...(appInstanceId?{appInstanceId}:{}),model:photoReference().model,scale:4,precision:'qualified-backend-default',id:randomUUID(),group,userId,inputs:body.inputs,mode:body.mode,budgetMs:body.budgetMs,createdAt:Date.now(),updatedAt:Date.now(),state:'PREPARING',jobs:[],sourceDurationMs:null,error:null,revision:0};await this.save(r);return r;
 }
 private async save(r:any){
  const file=this.file(r.group,r.id);await fs.mkdir(path.dirname(file),{recursive:true});const temp=file+'.'+randomUUID()+'.tmp';await fs.writeFile(temp,JSON.stringify(r));
  try{for(let attempt=0;;attempt++)try{await fs.rename(temp,file);break;}catch(e){
   // Windows readers/virus scanners may briefly hold the destination. Keep the
   // previous complete revision visible; never unlink it or expose partial JSON.
   if(attempt>=20||!['EPERM','EACCES','EBUSY'].includes((e as NodeJS.ErrnoException).code??''))throw e;
   await new Promise(resolve=>setTimeout(resolve,Math.min(100,20*(attempt+1))));
  }}finally{await fs.rm(temp,{force:true}).catch(()=>{});}
 }
 async update(group:string,id:string,userId:string,body:any){
  const pending=this.mutations.then(()=>this.updateOne(group,id,userId,body));this.mutations=pending.then(()=>{},()=>{});return pending;
 }
 private async updateOne(group:string,id:string,userId:string,body:any){
  const r=await this.read(group,id);if(r.userId!==userId)throw Error('PHOTO_RUN_FORBIDDEN');
  if(!Number.isSafeInteger(body.revision)||body.revision!==r.revision)throw Error('PHOTO_RUN_REVISION');
  if(body.jobs!==undefined){if(!Array.isArray(body.jobs)||body.jobs.length>8||body.jobs.some((j:any)=>typeof j.id!=='string'||!Number.isInteger(j.imageIndex)||j.imageIndex<0||j.imageIndex>=r.inputs.length))throw Error('PHOTO_RUN_INVALID');
   for(const j of body.jobs){const row=await this.db.sdkWorkflowJob.findUnique({where:{id:j.id}});if(!row||row.groupId!==group)throw Error('PHOTO_JOB_SCOPE');const g=JSON.parse(row.metadataJson),root=g.workflow.nodes.find((n:any)=>n.input);if(g.peer.principalId!==userId||r.appInstanceId&&g.peer.app?.appInstanceId!==r.appInstanceId||g.workflow.outputContract!=='photo.product'||root?.input.contentHash!==r.inputs[j.imageIndex].hash||root?.input.bytes!==r.inputs[j.imageIndex].bytes||r.sourceDeviceId&&g.peer.deviceId!==r.sourceDeviceId)throw Error('PHOTO_JOB_SCOPE');}
   if(new Set(body.jobs.map((j:any)=>j.imageIndex)).size!==body.jobs.length||new Set(body.jobs.map((j:any)=>j.id)).size!==body.jobs.length)throw Error('PHOTO_RUN_INVALID');r.jobs=body.jobs;
  }
  if(body.deliveredImage!==undefined){
   const {imageIndex,hash}=body.deliveredImage??{};
   if(!Number.isInteger(imageIndex)||imageIndex<0||imageIndex>=r.inputs.length||typeof hash!=='string')throw Error('PHOTO_RUN_INVALID');
   const evidence=await this.view(group,id),workflow=evidence.workflows.find((w:any)=>w.imageIndex===imageIndex);
   if(!workflow||workflow.state!=='SUCCEEDED'||!workflow.nodes.every((n:any)=>n.committed&&(r.mode!=='LOCAL'||n.target?.deviceId===r.sourceDeviceId)))throw Error('PHOTO_RESULTS_NOT_COMMITTED');
   const product=JSON.parse((await fs.readFile(this.file(group,id)+'.result-'+imageIndex)).toString());
   if(product.hash!==hash||createHash('sha256').update(Buffer.from(product.image,'base64')).digest('hex')!==hash)throw Error('PHOTO_RESULT_HASH');
   r.deliveries=r.deliveries??[];
   if(!r.deliveries.some((d:any)=>d.imageIndex===imageIndex))r.deliveries.push({imageIndex,hash,receivedAt:Date.now()});
  }
  if(body.state==='SUCCEEDED'){const evidence=await this.view(group,id);if(!evidence.allCommitted)throw Error('PHOTO_RESULTS_NOT_COMMITTED');}
  if(body.state!==undefined){if(!['PREPARING','RUNNING','SUCCEEDED','FAILED','CANCELLED'].includes(body.state))throw Error('PHOTO_RUN_INVALID');r.state=body.state;}
  if(body.sourceDurationMs!==undefined){if(!Number.isFinite(body.sourceDurationMs)||body.sourceDurationMs<0)throw Error('PHOTO_RUN_INVALID');r.sourceDurationMs=body.sourceDurationMs;}
  if(body.error!==undefined)r.error=String(body.error).slice(0,500);
  r.updatedAt=Date.now();r.revision++;await this.save(r);return r;
 }
 async read(group:string,id:string){return JSON.parse(await fs.readFile(this.file(group,id),'utf8'));}
 async preview(group:string,id:string,userId:string,index:number,bytes:Buffer){
  const r=await this.read(group,id);if(r.userId!==userId)throw Error('PHOTO_RUN_FORBIDDEN');
  if(!['PREPARING','RUNNING'].includes(r.state)||!Number.isSafeInteger(index)||index<0||index>=r.inputs.length||bytes.length!==r.inputs[index].bytes||createHash('sha256').update(bytes).digest('hex')!==r.inputs[index].hash)throw Error('PHOTO_INPUT_INVALID');
  // Display-only copy, uploaded after Start. Never registered as an executor input.
  await fs.writeFile(this.file(group,id)+'.input-'+index,bytes);
 }
 async retainInput(group:string,userId:string,bytes:Buffer){const hash=createHash('sha256').update(bytes).digest('hex');for(const r of await this.list(group))if(r.userId===userId&&['PREPARING','RUNNING'].includes(r.state)){for(let i=0;i<r.inputs.length;i++)if(r.inputs[i].hash===hash&&r.inputs[i].bytes===bytes.length)await fs.writeFile(this.file(group,r.id)+'.input-'+i,bytes);}}
 async input(group:string,id:string,index:number){const r=await this.read(group,id);if(!Number.isSafeInteger(index)||index<0||index>=r.inputs.length)throw Error('PHOTO_RUN_INVALID');return fs.readFile(this.file(group,id)+'.input-'+index);}
 async retainResult(group:string,userId:string,jobId:string,bytes:Buffer){for(const r of await this.list(group))if(r.userId===userId&&r.jobs.some((j:any)=>j.id===jobId)){const j=r.jobs.find((j:any)=>j.id===jobId);await fs.writeFile(this.file(group,r.id)+'.result-'+j.imageIndex,bytes);}}
 async result(group:string,id:string,index:number){const r=await this.read(group,id);if(!Number.isSafeInteger(index)||index<0||index>=r.inputs.length)throw Error('PHOTO_RUN_INVALID');if(r.state!=='SUCCEEDED'&&!r.deliveries?.some((d:any)=>d.imageIndex===index))throw Error('PHOTO_RESULT_PENDING');try{return await fs.readFile(this.file(group,id)+'.result-'+index);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')throw Error('PHOTO_RESULT_PENDING');throw e;}}
 async list(group:string){const dir=path.dirname(this.file(group,'index'));let names:string[]=[];try{names=await fs.readdir(dir);}catch{return [];}
  const rows=await Promise.all(names.filter(n=>n.endsWith('.json')).map(n=>this.read(group,n.slice(0,-5))));return rows.sort((a,b)=>b.createdAt-a.createdAt).slice(0,20);
 }
 async view(group:string,id:string){const r=await this.read(group,id),workflows:any[]=[];
  const graphs=await this.db.sdkWorkflowJob.findMany({where:{id:{in:r.jobs.map((j:any)=>j.id)},groupId:group}}),graphMap=new Map(graphs.map(row=>[row.id,row]));
  const ids=graphs.flatMap(row=>JSON.parse(row.metadataJson).nodes.map((n:any)=>n.jobId));
  const [children,attempts,receipts,traceRows]=await Promise.all([this.db.cpuJob.findMany({where:{id:{in:ids},groupId:group}}),this.db.attempt.findMany({where:{id:{in:ids},groupId:group}}),this.db.receipt.findMany({where:{id:{in:ids}}}),attemptTraceRows(this.db,group,ids)]);
  const spansByAttempt=new Map<string,any[]>();
  for(const row of traceRows){const span=JSON.parse(row.metadataJson).span,list=spansByAttempt.get(span.attemptId)??[];list.push(span);spansByAttempt.set(span.attemptId,list);}
  const childMap=new Map(children.map(row=>[row.id,JSON.parse(row.metadataJson)])),attemptMap=new Map(attempts.map(row=>[row.id,row])),receiptMap=new Map(receipts.map(row=>[row.id,row]));
  for(const job of r.jobs){const row=graphMap.get(job.id);if(!row)continue;const g=JSON.parse(row.metadataJson);
   const nodes=[];for(const n of g.workflow.nodes){const state=g.nodes.find((s:any)=>s.id===n.id),d=state?childMap.get(state.jobId):null;
    const attempt=state?attemptMap.get(state.jobId):null,receipt=state?receiptMap.get(state.jobId):null;
    const timing=(spansByAttempt.get(state?.jobId)??[]).map(s=>({phase:s.phase,durationMs:s.durationMs,clockDomainId:s.clockDomainId,startMono:s.startMono,endMono:s.endMono}));
    nodes.push({timing,id:n.id,capability:n.capability,dependsOn:n.dependsOn,inputFroms:n.inputFroms,state:state?.state==='COMMITTED'?'SUCCEEDED':attempt?.state??state?.state??'PENDING',attemptId:state?.jobId,target:d?.offer.target??null,reason:d?.offer.reasonCode??null,inputBytes:d?.input.bytes??null,inputHash:d?.input.ref.contentHash??null,outputBytes:d?.output?.bytes??null,outputHash:d?.output?.ref.contentHash??null,committed:receipt?.committed??false,decision:d?.decisionEvidence??null});
   }
   workflows.push({id:job.id,imageIndex:job.imageIndex,state:row.state,nodes,plan:g.plan.decision,deadlineAt:g.deadlineAt});
  }
  const images=await Promise.all(r.inputs.map(async(input:any,imageIndex:number)=>{
   const w=workflows.find((w:any)=>w.imageIndex===imageIndex),delivery=r.deliveries?.find((d:any)=>d.imageIndex===imageIndex);
   const committed=!!w&&w.state==='SUCCEEDED'&&w.nodes.every((n:any)=>n.committed&&(r.mode!=='LOCAL'||n.target?.deviceId===r.sourceDeviceId));
   const exists=async(suffix:string)=>{try{await fs.access(this.file(group,id)+suffix);return true;}catch{return false;}};
   return {imageIndex,inputAvailable:await exists('.input-'+imageIndex),delivered:committed&&!!(delivery||r.state==='SUCCEEDED')&&await exists('.result-'+imageIndex),receivedAt:delivery?.receivedAt??null};
  }));
  return {...r,workflows,images,serverNow:Date.now(),evidenceDomain:this.domain,allCommitted:workflows.length===r.inputs.length&&workflows.every(w=>w.state==='SUCCEEDED'&&w.nodes.every((n:any)=>n.committed&&(r.mode!=='LOCAL'||n.target?.deviceId===r.sourceDeviceId)))};
 }
}

import {createHash,randomUUID} from 'node:crypto';
import {workKeyV2,canonical,protocolId,sameModelV2,validModelManifestV2,PlacementRequest,SnapshotDecision} from '@harmony/scheduler-core';
import {SdkWorkflow,SdkSubmission,SdkInputTransfer} from '@harmony/scheduler-client';
import {ReferencePack} from '@harmony/reference-capabilities';
import {ArtifactChannel,ArtifactDescriptor} from '@harmony/resource-transport';
import {Prisma,PrismaClient} from '../generated/client';
import {Peer} from './channel';
import {ArtifactRetention} from './retention';
import {CpuJobs} from './cpu-jobs';
import {AppRegistry} from './apps';
interface NodeState {reassignedAttempts?:string[];excludedDeviceId?:string;yieldedAttempts?:string[];id:string;jobId:string;state:'PENDING'|'SUBMITTED'|'COMMITTED';output?:ArtifactDescriptor;local?:boolean;}
interface GraphData {priority?:'REMOTE_INTERACTIVE'|'REMOTE_BATCH';stop?:{state:string;reconciliationJobId?:string};peer:Peer;workflow:SdkWorkflow;fingerprint:string;deadlineAt:number;originLocal:boolean;inputs:Record<string,ArtifactDescriptor>;nodes:NodeState[];plan:SnapshotDecision;failure?:{code:string;reason:string;nodeId:string};resultReceivedAt?:number;}
/** Durable DAG progression. Every node is still dispatched by CpuJobs/PlanningService. */
export class WorkflowJobs {
 private scheduled=new Map<string,Promise<void>>();
 private work=Promise.resolve();private stopped=false;
 constructor(private db:PrismaClient,private jobs:CpuJobs,private apps:AppRegistry,private artifacts:ArtifactChannel,private packs:ReferencePack[],private retention?:ArtifactRetention){}
 async exists(id:string){return !!await this.db.sdkWorkflowJob.findUnique({where:{id}});}
 /** Install a workflow cursor under the existing SDK id, in the transaction confirming non-admission. */
 async adoptUnstarted(tx:Prisma.TransactionClient,id:string){
  const row=await tx.cpuJob.findUnique({where:{id}});
  if(!row||!['DISPATCHING','DISPATCHED'].includes(row.state))return;
  const d=JSON.parse(row.metadataJson),t=d.offer.task;
  if(t.workflowId!==id||t.attemptId!==id||!d.fingerprint||!d.sourcePeer||d.deadlineAt<=Date.now()||
    t.contract.sideEffectPolicy!=='PURE'||d.request.nodes[0].allowedTargetIds?.length||d.choices?.length>1)return;
  const node=await tx.node.findUnique({where:{id:JSON.stringify([id,t.nodeId])}});
  if(!node||node.state!=='REJECTED'||node.currentAttemptId!==id||node.backupAttemptId)return;
  const input=d.input,workflow:SdkWorkflow={version:3,id,qualityTarget:t.qualityTarget,outputContract:t.contract.outputSchemas[0],
    nodes:[{id:t.nodeId,capability:t.contract.capability,modelManifest:d.request.nodes[0].modelManifest??undefined,input:{contentHash:input.ref.contentHash,bytes:input.bytes,schemaId:input.ref.schemaId,schemaVersion:input.ref.schemaVersion},
      parameters:t.parameters,dependsOn:[]}]};
  const data:GraphData={peer:d.sourcePeer,priority:t.priority,workflow,fingerprint:d.fingerprint,deadlineAt:d.deadlineAt,
    originLocal:!!d.request.inputRelayId,inputs:{[t.nodeId]:input},nodes:[{id:t.nodeId,jobId:id,state:'SUBMITTED'}],plan:d.plan};
  await tx.sdkWorkflowJob.upsert({where:{id},create:{id,groupId:row.groupId,sourceHolderId:row.sourceHolderId,state:'ACTIVE',metadataJson:JSON.stringify(data)},update:{}});
 }
 private async owned(peer:Peer,id:string){await this.apps.context(peer);const row=await this.db.sdkWorkflowJob.findUnique({where:{id}});if(!row||row.groupId!==peer.groupId||row.sourceHolderId!==peer.holderInstanceId)throw Error('JOB_SCOPE');return {row,data:JSON.parse(row.metadataJson) as GraphData};}
 private pack(capability:string){const pack=this.packs.find(p=>p.manifest.contract.capability===capability);if(!pack)throw Error('CAPABILITY_UNSUPPORTED');return pack;}
 async submit(peer:Peer,body:SdkSubmission){
  const app=await this.apps.context(peer),w=body.workflow as SdkWorkflow,o=body.options;
  if(!w||!Array.isArray(w.nodes)||w.nodes.length<2||w.nodes.length>16||w.version!==3||!protocolId(w.id)||w.qualityTarget!=='reference'||!o||!protocolId(o.requestId)||o.requestId.length>100||!Number.isSafeInteger(o.budgetMs)||o.budgetMs<=0||o.budgetMs>30000||o.resultDestination!=='ORIGIN'||o.inputLocation!==undefined&&o.inputLocation!=='ORIGIN')throw Error('SDK_GRAPH_INVALID');
  if(Object.keys(body).some(k=>!['workflow','options'].includes(k))||Object.keys(w).some(k=>!['version','id','outputContract','qualityTarget','nodes'].includes(k))||Object.keys(o).some(k=>!['requestId','budgetMs','resultDestination','inputLocation','priority'].includes(k))||o.priority!==undefined&&!['REMOTE_INTERACTIVE','REMOTE_BATCH'].includes(o.priority))throw Error('SDK_GRAPH_INVALID');
  const known=new Set<string>();
  for(const node of w.nodes){
   if(!protocolId(node.id)||known.has(node.id)||!Array.isArray(node.dependsOn)||node.dependsOn.some(id=>!known.has(id))||typeof node.parameters!=='string'||Buffer.byteLength(node.parameters)>32768||node.targetId!==undefined&&!protocolId(node.targetId)||Object.keys(node).some(k=>!['id','capability','input','inputFrom','parameters','dependsOn','targetId','modelManifest','effects','businessIdempotencyKey','privacy'].includes(k))||node.privacy!==undefined&&!['LOCAL_ONLY','OWNER_SERVICE','SHARED'].includes(node.privacy))throw Error('SDK_GRAPH_NODE_INVALID');
   JSON.parse(node.parameters);const pack=this.pack(node.capability);
   const effects=node.effects??'PURE';
   if(!['PURE','COMMIT'].includes(effects)||(effects==='PURE')!==(pack.manifest.contract.sideEffectPolicy==='PURE'))throw Error('SDK_EFFECTS_MISMATCH');
   if(effects==='COMMIT'&&!protocolId(node.businessIdempotencyKey!))throw Error('SDK_IDEMPOTENCY_REQUIRED');
   if(effects==='PURE'&&node.businessIdempotencyKey!==undefined)throw Error('SDK_EFFECTS_MISMATCH');if(!app.identity.allowedContracts.includes(pack.manifest.contract.contractId))throw Error('APP_CONTRACT_FORBIDDEN');
   if(node.modelManifest!==undefined&&(!validModelManifestV2(node.modelManifest)||!sameModelV2(node.modelManifest,pack.manifest.model)))throw Error('SDK_MODEL_MISMATCH');
   if(node.inputFrom!==undefined){if(node.input!==undefined||!node.dependsOn.includes(node.inputFrom))throw Error('SDK_GRAPH_EDGE_INVALID');const parent=w.nodes.find(n=>n.id===node.inputFrom)!;if(!pack.manifest.contract.inputSchemas.includes(this.pack(parent.capability).manifest.contract.outputSchemas[0]))throw Error('SDK_GRAPH_SCHEMA_MISMATCH');}
   else{const input=node.input;if(!input||Object.keys(input).sort().join('|')!=='bytes|contentHash|schemaId|schemaVersion'||!/^[a-f0-9]{64}$/.test(input.contentHash)||!Number.isSafeInteger(input.bytes)||input.bytes<1||input.bytes>8388608||input.schemaVersion!==1||!pack.manifest.contract.inputSchemas.includes(input.schemaId))throw Error('SDK_INPUT_INVALID');}
   known.add(node.id);
  }
  const sinks=w.nodes.filter(n=>!w.nodes.some(other=>other.dependsOn.includes(n.id)));
  if(sinks.length!==1||!this.pack(sinks[0].capability).manifest.contract.outputSchemas.includes(w.outputContract))throw Error('SDK_GRAPH_OUTPUT_INVALID');
  const fingerprint=createHash('sha256').update(canonical(body)).digest('hex');
  if(await this.exists(o.requestId)){const {data}=await this.owned(peer,o.requestId);if(data.fingerprint!==fingerprint)throw Error('JOB_CONFLICT');return this.upload(o.requestId,data);}
  // The graph and node namespace must not shadow an existing single-node request.
  if(await this.db.cpuJob.findUnique({where:{id:o.requestId}})||await this.db.workflow.findUnique({where:{id:o.requestId}}))throw Error('JOB_CONFLICT');
  const now=Date.now(),inputs:Record<string,ArtifactDescriptor>={};
  for(const n of w.nodes)if(n.input)inputs[n.id]={ref:{artifactId:randomUUID(),contentVersion:1,contentHash:n.input.contentHash,schemaId:n.input.schemaId,schemaVersion:1},groupId:peer.groupId,ownerPrincipalId:peer.principalId,domain:this.artifacts.domain,bytes:n.input.bytes,expiresAt:now+3600000};
  const originLocal=o.inputLocation==='ORIGIN',relay=this.jobs.relayId();
  const bounds=new Map<string,number>();for(const n of w.nodes){const p=this.pack(n.capability),inputBytes=n.input?.bytes??bounds.get(n.inputFrom!)!;bounds.set(n.id,p.manifest.contract.outputSchemas.includes('image.raster')?p.maxOutputBytes:Math.min(p.maxOutputBytes,inputBytes*64+4096));}
  const request:PlacementRequest={priority:o.priority??'REMOTE_INTERACTIVE',nodes:w.nodes.map(n=>{const p=this.pack(n.capability);return {id:n.id,workKey:workKeyV2(p.manifest.contract,n.parameters,n.input?.bytes??bounds.get(n.inputFrom!)!),capability:n.capability,serviceId:p.manifest.contract.serviceId,dependencies:n.dependsOn,inputs:[n.inputFrom?'graph-out-'+n.inputFrom:inputs[n.id].ref.artifactId],output:{id:'graph-out-'+n.id,bytes:bounds.get(n.id)!,retainAtExecutor:w.nodes.some(child=>child.inputFrom===n.id)},modelManifest:p.manifest.model,baselineTargetId:n.targetId??'',allowedTargetIds:n.targetId?[n.targetId]:undefined,memoryBytes:p.manifest.resourceLimit.find(r=>r.resourcePoolId==='ram')?.amount??0,minimumQuality:p.manifest.qualityThreshold,candidates:[]};}),
   artifacts:Object.values(inputs).map(a=>({id:a.ref.artifactId,bytes:a.bytes,replicas:[originLocal?{deviceId:peer.deviceId,holderInstanceId:peer.holderInstanceId,readMs:0}:{deviceId:relay,readMs:0}]})),links:[],deviceResources:[],remainingBudgetMs:o.budgetMs,networkAllowed:true,privacy:'AUTHORIZED_REMOTE',localDeviceId:peer.deviceId,domain:this.artifacts.domain,now,committedNodeIds:[],committedArtifacts:[],appInstanceId:app.identity.appInstanceId,originHolderId:peer.holderInstanceId,inputRelayId:relay,localResultHolderId:peer.holderInstanceId,materializeOutputsAt:relay,finalDestination:relay};
  const plan=await this.jobs.graphPlan(peer,request);if(!plan.decision.suggestion)throw Error(plan.decision.reason);
  const data:GraphData={peer,priority:request.priority,workflow:w,fingerprint,deadlineAt:now+o.budgetMs,originLocal,inputs,nodes:w.nodes.map(n=>({id:n.id,jobId:randomUUID(),state:'PENDING'})),plan};
  for(const a of Object.values(inputs))this.artifacts.register(a);
  await this.db.sdkWorkflowJob.create({data:{id:o.requestId,groupId:peer.groupId,sourceHolderId:peer.holderInstanceId,state:'WAITING_INPUT',metadataJson:JSON.stringify(data)}});
  return this.upload(o.requestId,data);
 }
 private upload(id:string,data:GraphData){const tickets=Object.values(data.inputs).map(a=>this.artifacts.issue(a,data.peer,'WRITE')),first=data.plan.decision.suggestion![0];return {jobId:id,targetId:first.targetId,deviceId:first.deviceId,reason:data.plan.decision.reason,inputDelivery:data.originLocal?'LOCAL':'RELAY',inputTicket:tickets[0],inputTickets:tickets};}
 async start(peer:Peer,id:string){const {data}=await this.owned(peer,id);if(!data.originLocal&&Object.values(data.inputs).some(a=>!this.artifacts.available(a)))throw Error('INPUT_NOT_UPLOADED');await this.db.sdkWorkflowJob.updateMany({where:{id,state:'WAITING_INPUT'},data:{state:'ACTIVE'}});return this.status(peer,id);}
 changed(groupId:string){void this.advance(groupId).catch(()=>{});}
 private advance(groupId:string){
  const scheduled=this.scheduled.get(groupId);
  if(scheduled)return scheduled;
  const next=this.work.then(async()=>{
   // Notifications that arrive during this pass need at most one subsequent pass.
   this.scheduled.delete(groupId);
   if(this.stopped)return;
   await this.retention?.sweepRelay();
   const active=await this.db.sdkWorkflowJob.findMany({where:{groupId,state:{in:['ACTIVE','CANCEL_REQUESTED']}}});
   for(const row of active)await this.progress(row.id,JSON.parse(row.metadataJson));
   await this.retention?.sweepRelay();
  });
  this.scheduled.set(groupId,next);
  this.work=next.catch(()=>{});
  return next;
 }
 private async drain(id:string,data:GraphData){
  // Submission and the workflow cursor are separate durable writes. A PENDING
  // cursor may already own a job after a restart.
  const unfinished=data.nodes.filter(n=>n.state!=='COMMITTED'&&n.jobId!==data.stop?.reconciliationJobId);
  const existing=await this.db.cpuJob.findMany({where:{id:{in:unfinished.map(n=>n.jobId)},groupId:data.peer.groupId},select:{id:true}});
  let settled=true;
  for(const job of existing){
   const result=await this.jobs.cancel(data.peer,job.id);
   if(!['CANCELLED','CANCELLED_SETTLED','FAILED','REJECTED','SUCCEEDED','YIELDED'].includes(result.state))settled=false;
  }
  if(settled)await this.db.sdkWorkflowJob.updateMany({where:{id,state:'CANCEL_REQUESTED'},data:{state:data.stop?.state??'CANCELLED_SETTLED'}});
 }
 private async stop(id:string,data:GraphData,state:string,reconciliationJobId?:string){
  data.stop={state,reconciliationJobId};
  const saved=await this.db.sdkWorkflowJob.updateMany({where:{id,state:'ACTIVE'},data:{state:'CANCEL_REQUESTED',metadataJson:JSON.stringify(data)}});
  if(saved.count)await this.drain(id,data);
 }
 /** Replan once after a settled PURE yield or a durable pre-admission rejection. */
 private async restartSettledOrUnstarted(id:string,data:GraphData,node:NodeState){
  // COMMIT never gets an automatic replacement attempt. The installed pack answers without a transaction;
  // the stored offer's contract is re-checked below as the authoritative record for this attempt.
  const installed=this.packs.find(p=>p.manifest.contract.capability===data.workflow.nodes.find(n=>n.id===node.id)?.capability);
  if(installed&&installed.manifest.contract.sideEffectPolicy!=='PURE'||data.deadlineAt<=Date.now()||(node.yieldedAttempts?.length??0)+(node.reassignedAttempts?.length??0)>=1)return false;
  const oldId=node.jobId,nextId=randomUUID();
  const history=[...(node.yieldedAttempts??[]),oldId];
  const replacement:NodeState={id:node.id,jobId:nextId,state:'PENDING',yieldedAttempts:history};
  const saved=await this.db.$transaction(async tx=>{
   const graph=await tx.sdkWorkflowJob.findUniqueOrThrow({where:{id}});
   if(graph.state!=='ACTIVE')return false;
   const row=await tx.attempt.findUnique({where:{id:oldId}});
   if(!row?.offerJson||row.groupId!==graph.groupId||row.workflowId!==id)return false;
   const offer=JSON.parse(row.offerJson),record=row.recordJson&&JSON.parse(row.recordJson);
   if(offer.task.contract.sideEffectPolicy!=='PURE')return false;
   const notice=row.yieldJson&&JSON.parse(row.yieldJson).notice;
   const refusal=row.rejectionJson&&JSON.parse(row.rejectionJson).reply;
   const unstarted=row.state==='REJECTED'&&!record&&refusal?.reasonCode==='QUEUE_STARVED_NOT_STARTED'&&refusal.attemptId===oldId&&
     refusal.holderInstanceId===row.holderInstanceId&&refusal.status==='REJECTED'&&refusal.record===null;
   const yielded=record?.resourcesSettled&&['CANCELLED_SETTLED','YIELDED'].includes(record.state)&&notice?.kind==='RESTART'&&
     notice.attemptId===oldId&&offer.task.contract.sideEffectPolicy==='PURE'&&offer.task.contract.interruptibility==='CANCEL_RESTART';
   if(!yielded&&!unstarted)return false;
   if(unstarted){
    if(data.workflow.nodes.find(n=>n.id===node.id)?.targetId)return false;
    delete replacement.yieldedAttempts;replacement.reassignedAttempts=[oldId];
    replacement.excludedDeviceId=offer.target.deviceId;
   }
   const previous=await tx.cpuJob.findUnique({where:{id:oldId}});
   if(!previous||previous.state==='CANCEL_REQUESTED')return false;
   const changed=await tx.node.updateMany({where:{id:JSON.stringify([id,node.id]),currentAttemptId:oldId,backupAttemptId:null,winnerAttemptId:null,state:row.state},data:{currentAttemptId:null,primaryAttemptId:null,state:'PENDING'}});
   if(!changed.count)return false;
   await tx.sdkWorkflowJob.update({where:{id},data:{metadataJson:JSON.stringify({...data,nodes:data.nodes.map(n=>n.id===node.id?replacement:n)})}});
   return true;
  });
  if(saved)Object.assign(node,replacement);
  return saved;
 }
 private async progress(id:string,data:GraphData){
  await this.apps.context(data.peer);
  if((await this.db.sdkWorkflowJob.findUniqueOrThrow({where:{id}})).state==='CANCEL_REQUESTED'){
   await this.drain(id,data);return;
  }
  for(const node of data.nodes){
   if(node.state==='SUBMITTED'){
    const serving=await this.jobs.winnerFor(data.peer,node.jobId);
    const status=await this.jobs.status(data.peer,serving,false),output=await this.jobs.graphOutput(data.peer,serving);
    if(output){node.jobId=serving;node.state='COMMITTED';node.output=output.descriptor;node.local=output.local;}
    else if(['CANCELLED_SETTLED','YIELDED','REJECTED'].includes(status.state)&&await this.restartSettledOrUnstarted(id,data,node))continue;
    else if(['FAILED','REJECTED','CANCELLED','CANCELLED_SETTLED','YIELDED','SIDE_EFFECT_UNKNOWN','HOLDER_RECORD_MISSING'].includes(status.state)){const needsReconciliation=['SIDE_EFFECT_UNKNOWN','HOLDER_RECORD_MISSING'].includes(status.state);
     await this.stop(id,data,status.state,needsReconciliation?node.jobId:undefined);return;}
   }
  }
  await this.db.sdkWorkflowJob.update({where:{id},data:{metadataJson:JSON.stringify(data)}});
  for(const n of data.workflow.nodes){
   if((await this.db.sdkWorkflowJob.findUniqueOrThrow({where:{id}})).state!=='ACTIVE')return;
   const state=data.nodes.find(s=>s.id===n.id)!;if(state.state==='COMMITTED'||n.dependsOn.some(dep=>data.nodes.find(s=>s.id===dep)!.state!=='COMMITTED'))continue;
   if(data.deadlineAt<=Date.now()){await this.stop(id,data,'BUDGET_EXHAUSTED');return;}
   const parent=n.inputFrom?data.nodes.find(s=>s.id===n.inputFrom)!:null,source=parent?parent.output!:data.inputs[n.id],local=parent?parent.local:data.originLocal;
   try{
    if(state.state==='PENDING'){
     if(n.modelManifest&&!sameModelV2(n.modelManifest,this.pack(n.capability).manifest.model)){
      data.failure={code:'SDK_MODEL_MISMATCH',reason:'REGISTERED_MODEL_CHANGED',nodeId:n.id};await this.stop(id,data,'FAILED');return;
     }
     const assignment=data.plan.decision.suggestion!.find(a=>a.nodeId===n.id)!;
     if(await this.db.cpuJob.findUnique({where:{id:state.jobId}}))await this.jobs.status(data.peer,state.jobId,false);else await this.jobs.submit(data.peer,{requestId:state.jobId,priority:data.priority,capability:n.capability,contentHash:source.ref.contentHash,bytes:source.bytes,parameters:n.parameters,businessIdempotencyKey:n.businessIdempotencyKey,privacy:n.privacy,budgetMs:Math.max(1,data.deadlineAt-Date.now()),targetId:n.targetId,...(local?{inputLocation:'ORIGIN'}:{})},undefined,undefined,{workflowId:id,nodeId:n.id,excludedDeviceId:state.excludedDeviceId,deadlineAt:data.deadlineAt,dependencies:n.dependsOn,retain:!!assignment.outputEndpointId&&data.workflow.nodes.some(child=>child.inputFrom===n.id&&data.plan.decision.suggestion?.find(a=>a.nodeId===child.id)?.inputEndpointOperation==='WRITE'),source:parent?{descriptor:source,attemptId:parent.jobId,nodeId:parent.id}:undefined});
     state.state='SUBMITTED';await this.db.sdkWorkflowJob.update({where:{id},data:{metadataJson:JSON.stringify(data)}});
    }
    if(await this.jobs.graphInput(data.peer,state.jobId,source))continue;
    if((await this.db.sdkWorkflowJob.findUniqueOrThrow({where:{id}})).state!=='ACTIVE')return;
    await this.jobs.start(data.peer,state.jobId);
   }catch(error){if(error instanceof Error&&(error.message.startsWith('ARTIFACT_UNAVAILABLE:')||error.message==='ARTIFACT_CACHE_FULL')){data.failure={code:error.message==='ARTIFACT_CACHE_FULL'?'ARTIFACT_CACHE_FULL':'ARTIFACT_UNAVAILABLE',reason:error.message==='ARTIFACT_CACHE_FULL'?'NO_FEASIBLE_INPUT_PATH':error.message.slice('ARTIFACT_UNAVAILABLE:'.length),nodeId:n.id};await this.stop(id,data,'FAILED');return;}if(error instanceof Error&&['APP_QUOTA_EXCEEDED','NO_LEGAL_PLAN','ALLOTMENT_UNAVAILABLE','PLAN_STALE','INPUT_NOT_UPLOADED','TARGET_UNAVAILABLE','JOB_RECOVERY_REQUIRED'].includes(error.message))continue;throw error;}
  }
  if(data.nodes.every(n=>n.state==='COMMITTED'))await this.db.sdkWorkflowJob.updateMany({where:{id,state:'ACTIVE'},data:{state:'SUCCEEDED'}});
 }
 async status(peer:Peer,id:string){const {row,data}=await this.owned(peer,id);
  if(row.state==='ACTIVE'||row.state==='CANCEL_REQUESTED')this.changed(peer.groupId);
  const last=data.nodes[data.nodes.length-1],assignment=data.plan.decision.suggestion!.find(a=>a.nodeId===last.id)!;
  const inputTransfers:SdkInputTransfer[]=[];
  for(const n of data.workflow.nodes){const s=data.nodes.find(s=>s.id===n.id)!;if(row.state!=='ACTIVE'||s.state!=='SUBMITTED')continue;const source=n.inputFrom?data.nodes.find(s=>s.id===n.inputFrom)!.output!:data.inputs[n.id];const transfer=await this.jobs.graphInput(peer,s.jobId,source,false);if(transfer)inputTransfers.push(transfer);}
  const output=row.state==='SUCCEEDED'&&!data.resultReceivedAt&&last.output&&this.artifacts.lookup(peer.groupId,last.output.ref)?this.artifacts.issueStatusRead(last.output,peer):null;
  const actual=last.state==='COMMITTED'?await this.db.attempt.findUnique({where:{id:last.jobId},select:{offerJson:true}}):null;
  const target=actual?.offerJson?JSON.parse(actual.offerJson).target:assignment;
  return {jobId:id,state:row.state,rejection:data.failure??null,targetId:target.targetId,deviceId:target.deviceId,traceId:id,outputTicket:output,inputTransfers,nodes:data.nodes.map(n=>({id:n.id,jobId:n.jobId,state:n.state,yieldedAttempts:n.yieldedAttempts??[],reassignedAttempts:n.reassignedAttempts??[]})),plan:data.plan};
 }
 async received(peer:Peer,id:string,body:any){
  const {row,data}=await this.owned(peer,id),output=data.nodes[data.nodes.length-1]?.output;
  if(!body||Object.keys(body).sort().join('|')!==(body.sourceInterval?'bytes|ref|sourceInterval':'bytes|ref')||row.state!=='SUCCEEDED'||!output||canonical(body.ref)!==canonical(output.ref)||body.bytes!==output.bytes)throw Error('RESULT_RECEIPT_SCOPE');
  if(body.sourceInterval){const job=await this.db.cpuJob.findUniqueOrThrow({where:{id:data.nodes[data.nodes.length-1].jobId}}),d=JSON.parse(job.metadataJson);await this.jobs.sourceRoot(peer,d,body.sourceInterval);}
  if(!data.resultReceivedAt){const previous=JSON.stringify(data);data.resultReceivedAt=Date.now();await this.db.sdkWorkflowJob.updateMany({where:{id,metadataJson:previous},data:{metadataJson:JSON.stringify(data)}});}await this.retention?.sweepRelay();return {received:true};
 }
 async cancel(peer:Peer,id:string){await this.owned(peer,id);await this.db.sdkWorkflowJob.updateMany({where:{id,state:{in:['ACTIVE','WAITING_INPUT']}},data:{state:'CANCEL_REQUESTED'}});await this.advance(peer.groupId);return {jobId:id,state:(await this.owned(peer,id)).row.state};}
 async close(){this.stopped=true;await this.work;}
}

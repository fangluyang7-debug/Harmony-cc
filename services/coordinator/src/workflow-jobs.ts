import {createHash,randomUUID} from 'node:crypto';
import {canonical,protocolId,PlacementRequest,SnapshotDecision} from '@harmony/scheduler-core';
import {SdkWorkflow,SdkSubmission,SdkInputTransfer} from '@harmony/scheduler-client';
import {ReferencePack} from '@harmony/reference-capabilities';
import {ArtifactChannel,ArtifactDescriptor} from '@harmony/resource-transport';
import {PrismaClient} from '../generated/client';
import {Peer} from './channel';
import {CpuJobs} from './cpu-jobs';
import {AppRegistry} from './apps';
interface NodeState {id:string;jobId:string;state:'PENDING'|'SUBMITTED'|'COMMITTED';output?:ArtifactDescriptor;local?:boolean;}
interface GraphData {peer:Peer;workflow:SdkWorkflow;fingerprint:string;deadlineAt:number;originLocal:boolean;inputs:Record<string,ArtifactDescriptor>;nodes:NodeState[];plan:SnapshotDecision;}
/** Durable DAG progression. Every node is still dispatched by CpuJobs/PlanningService. */
export class WorkflowJobs {
 private work=Promise.resolve();private stopped=false;
 constructor(private db:PrismaClient,private jobs:CpuJobs,private apps:AppRegistry,private artifacts:ArtifactChannel,private packs:ReferencePack[]){}
 async exists(id:string){return !!await this.db.sdkWorkflowJob.findUnique({where:{id}});}
 private async owned(peer:Peer,id:string){await this.apps.context(peer);const row=await this.db.sdkWorkflowJob.findUnique({where:{id}});if(!row||row.groupId!==peer.groupId||row.sourceHolderId!==peer.holderInstanceId)throw Error('JOB_SCOPE');return {row,data:JSON.parse(row.metadataJson) as GraphData};}
 private pack(capability:string){const pack=this.packs.find(p=>p.manifest.contract.capability===capability);if(!pack)throw Error('CAPABILITY_UNSUPPORTED');return pack;}
 async submit(peer:Peer,body:SdkSubmission){
  const app=await this.apps.context(peer),w=body.workflow as SdkWorkflow,o=body.options;
  if(!w||!Array.isArray(w.nodes)||w.nodes.length<2||w.nodes.length>16||w.version!==3||!protocolId(w.id)||w.qualityTarget!=='reference'||!o||!protocolId(o.requestId)||o.requestId.length>100||!Number.isSafeInteger(o.budgetMs)||o.budgetMs<=0||o.budgetMs>30000||o.resultDestination!=='ORIGIN'||o.inputLocation!==undefined&&o.inputLocation!=='ORIGIN')throw Error('SDK_GRAPH_INVALID');
  if(Object.keys(body).some(k=>!['workflow','options'].includes(k))||Object.keys(w).some(k=>!['version','id','outputContract','qualityTarget','nodes'].includes(k))||Object.keys(o).some(k=>!['requestId','budgetMs','resultDestination','inputLocation'].includes(k)))throw Error('SDK_GRAPH_INVALID');
  const known=new Set<string>();
  for(const node of w.nodes){
   if(!protocolId(node.id)||known.has(node.id)||!Array.isArray(node.dependsOn)||node.dependsOn.some(id=>!known.has(id))||typeof node.parameters!=='string'||Buffer.byteLength(node.parameters)>32768||node.targetId!==undefined&&!protocolId(node.targetId)||Object.keys(node).some(k=>!['id','capability','input','inputFrom','parameters','dependsOn','targetId'].includes(k)))throw Error('SDK_GRAPH_NODE_INVALID');
   JSON.parse(node.parameters);const pack=this.pack(node.capability);if(!app.identity.allowedContracts.includes(pack.manifest.contract.contractId))throw Error('APP_CONTRACT_FORBIDDEN');
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
  const request:PlacementRequest={nodes:w.nodes.map(n=>{const p=this.pack(n.capability);return {id:n.id,capability:n.capability,serviceId:p.manifest.contract.serviceId,dependencies:n.dependsOn,inputs:[n.inputFrom?'graph-out-'+n.inputFrom:inputs[n.id].ref.artifactId],output:{id:'graph-out-'+n.id,bytes:bounds.get(n.id)!},baselineTargetId:n.targetId??'',allowedTargetIds:n.targetId?[n.targetId]:undefined,memoryBytes:p.manifest.resourceLimit.find(r=>r.resourcePoolId==='ram')?.amount??0,minimumQuality:p.manifest.qualityThreshold,candidates:[]};}),
   artifacts:Object.values(inputs).map(a=>({id:a.ref.artifactId,bytes:a.bytes,replicas:[originLocal?{deviceId:peer.deviceId,holderInstanceId:peer.holderInstanceId,readMs:0}:{deviceId:relay,readMs:0}]})),links:[],deviceResources:[],remainingBudgetMs:o.budgetMs,networkAllowed:true,privacy:'AUTHORIZED_REMOTE',localDeviceId:peer.deviceId,domain:this.artifacts.domain,now,committedNodeIds:[],committedArtifacts:[],appInstanceId:app.identity.appInstanceId,originHolderId:peer.holderInstanceId,inputRelayId:relay,localResultHolderId:peer.holderInstanceId,materializeOutputsAt:relay,finalDestination:relay};
  const plan=await this.jobs.graphPlan(peer,request);if(!plan.decision.suggestion)throw Error(plan.decision.reason);
  const data:GraphData={peer,workflow:w,fingerprint,deadlineAt:now+o.budgetMs,originLocal,inputs,nodes:w.nodes.map(n=>({id:n.id,jobId:randomUUID(),state:'PENDING'})),plan};
  for(const a of Object.values(inputs))this.artifacts.register(a);
  await this.db.sdkWorkflowJob.create({data:{id:o.requestId,groupId:peer.groupId,sourceHolderId:peer.holderInstanceId,state:'WAITING_INPUT',metadataJson:JSON.stringify(data)}});
  return this.upload(o.requestId,data);
 }
 private upload(id:string,data:GraphData){const tickets=Object.values(data.inputs).map(a=>this.artifacts.issue(a,data.peer,'WRITE')),first=data.plan.decision.suggestion![0];return {jobId:id,targetId:first.targetId,deviceId:first.deviceId,reason:data.plan.decision.reason,inputDelivery:data.originLocal?'LOCAL':'RELAY',inputTicket:tickets[0],inputTickets:tickets};}
 async start(peer:Peer,id:string){const {data}=await this.owned(peer,id);if(!data.originLocal&&Object.values(data.inputs).some(a=>!this.artifacts.available(a)))throw Error('INPUT_NOT_UPLOADED');await this.db.sdkWorkflowJob.updateMany({where:{id,state:'WAITING_INPUT'},data:{state:'ACTIVE'}});await this.advance(peer.groupId);return this.status(peer,id);}
 changed(groupId:string){void this.advance(groupId).catch(()=>{});}
 private advance(groupId:string){const next=this.work.then(async()=>{if(this.stopped)return;for(const row of await this.db.sdkWorkflowJob.findMany({where:{groupId,state:{in:['ACTIVE','CANCEL_REQUESTED']}}}))await this.progress(row.id,JSON.parse(row.metadataJson));});this.work=next.catch(()=>{});return next;}
 private async progress(id:string,data:GraphData){
  await this.apps.context(data.peer);
  if((await this.db.sdkWorkflowJob.findUniqueOrThrow({where:{id}})).state==='CANCEL_REQUESTED'){
   let settled=true;for(const n of data.nodes)if(n.state==='SUBMITTED'){const result=await this.jobs.cancel(data.peer,n.jobId);if(!['CANCELLED','CANCELLED_SETTLED','FAILED','REJECTED','SUCCEEDED'].includes(result.state))settled=false;}
   if(settled)await this.db.sdkWorkflowJob.update({where:{id},data:{state:'CANCELLED_SETTLED'}});return;
  }
  for(const node of data.nodes){
   if(node.state==='SUBMITTED'){
    const status=await this.jobs.status(data.peer,node.jobId),output=await this.jobs.graphOutput(data.peer,node.jobId);
    if(output){node.state='COMMITTED';node.output=output.descriptor;node.local=output.local;}
    else if(['FAILED','REJECTED','CANCELLED','CANCELLED_SETTLED','SIDE_EFFECT_UNKNOWN','HOLDER_RECORD_MISSING'].includes(status.state)){await this.db.sdkWorkflowJob.update({where:{id},data:{state:status.state}});return;}
   }
  }
  await this.db.sdkWorkflowJob.update({where:{id},data:{metadataJson:JSON.stringify(data)}});
  for(const n of data.workflow.nodes){
   if((await this.db.sdkWorkflowJob.findUniqueOrThrow({where:{id}})).state!=='ACTIVE')return;
   const state=data.nodes.find(s=>s.id===n.id)!;if(state.state==='COMMITTED'||n.dependsOn.some(dep=>data.nodes.find(s=>s.id===dep)!.state!=='COMMITTED'))continue;
   if(data.deadlineAt<=Date.now()){await this.db.sdkWorkflowJob.update({where:{id},data:{state:'BUDGET_EXHAUSTED'}});return;}
   const parent=n.inputFrom?data.nodes.find(s=>s.id===n.inputFrom)!:null,source=parent?parent.output!:data.inputs[n.id],local=parent?parent.local:data.originLocal;
   try{
    if(state.state==='PENDING'){
     const assignment=data.plan.decision.suggestion!.find(a=>a.nodeId===n.id)!;
     if(await this.db.cpuJob.findUnique({where:{id:state.jobId}}))await this.jobs.status(data.peer,state.jobId);else await this.jobs.submit(data.peer,{requestId:state.jobId,capability:n.capability,contentHash:source.ref.contentHash,bytes:source.bytes,parameters:n.parameters,budgetMs:Math.max(1,data.deadlineAt-Date.now()),targetId:assignment.targetId,...(local?{inputLocation:'ORIGIN'}:{})},undefined,undefined,{workflowId:id,nodeId:n.id,deadlineAt:data.deadlineAt,dependencies:n.dependsOn});
     state.state='SUBMITTED';await this.db.sdkWorkflowJob.update({where:{id},data:{metadataJson:JSON.stringify(data)}});
    }
    if(await this.jobs.graphInput(data.peer,state.jobId,source))continue;
    if((await this.db.sdkWorkflowJob.findUniqueOrThrow({where:{id}})).state!=='ACTIVE')return;
    await this.jobs.start(data.peer,state.jobId);
   }catch(error){if(error instanceof Error&&['APP_QUOTA_EXCEEDED','NO_LEGAL_PLAN','ALLOTMENT_UNAVAILABLE','PLAN_STALE','INPUT_NOT_UPLOADED','TARGET_UNAVAILABLE','JOB_RECOVERY_REQUIRED'].includes(error.message))continue;throw error;}
  }
  if(data.nodes.every(n=>n.state==='COMMITTED'))await this.db.sdkWorkflowJob.updateMany({where:{id,state:'ACTIVE'},data:{state:'SUCCEEDED'}});
 }
 async status(peer:Peer,id:string){await this.owned(peer,id);await this.advance(peer.groupId);const {row,data}=await this.owned(peer,id),last=data.nodes[data.nodes.length-1],assignment=data.plan.decision.suggestion!.find(a=>a.nodeId===last.id)!;
  const inputTransfers:SdkInputTransfer[]=[];
  for(const n of data.workflow.nodes){const s=data.nodes.find(s=>s.id===n.id)!;if(row.state!=='ACTIVE'||s.state!=='SUBMITTED')continue;const source=n.inputFrom?data.nodes.find(s=>s.id===n.inputFrom)!.output!:data.inputs[n.id];const transfer=await this.jobs.graphInput(peer,s.jobId,source);if(transfer)inputTransfers.push(transfer);}
  const output=row.state==='SUCCEEDED'&&last.output?this.artifacts.issue(last.output,peer,'READ'):null;
  return {jobId:id,state:row.state,targetId:assignment.targetId,deviceId:assignment.deviceId,traceId:id,outputTicket:output,inputTransfers,nodes:data.nodes.map(n=>({id:n.id,jobId:n.jobId,state:n.state})),plan:data.plan};
 }
 async cancel(peer:Peer,id:string){await this.owned(peer,id);await this.db.sdkWorkflowJob.updateMany({where:{id,state:{in:['ACTIVE','WAITING_INPUT']}},data:{state:'CANCEL_REQUESTED'}});await this.advance(peer.groupId);return {jobId:id,state:(await this.owned(peer,id)).row.state};}
 async close(){this.stopped=true;await this.work;}
}

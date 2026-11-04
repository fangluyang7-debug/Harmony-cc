import {ArtifactRetention} from './retention';
import {WorkflowJobs} from './workflow-jobs';
import {createHash} from 'node:crypto';
import {canonical,protocolId,sameModelV2,validModelManifestV2} from '@harmony/scheduler-core';
import {builtinCpuPacks,ReferencePack} from '@harmony/reference-capabilities';
import {SdkSubmission,SdkWorkflow} from '@harmony/scheduler-client';
import {CpuJobs} from './cpu-jobs';
import {Peer} from './channel';
const exact=(v:any,keys:string[],optional:string[]=[])=>v&&typeof v==='object'&&!Array.isArray(v)&&keys.every(k=>k in v)&&Object.keys(v).every(k=>[...keys,...optional].includes(k));
/** C3 metadata adapter. CpuJobs is its one-node server implementation, never a second dispatcher. */
export class SdkJobs {
 constructor(private readonly jobs:CpuJobs,private readonly packs:ReferencePack[]=builtinCpuPacks(),private readonly graphs?:WorkflowJobs,private readonly retention?:ArtifactRetention){}
 contractIds(){return this.packs.map(p=>p.manifest.contract.contractId);}
 inputSchema(capability:string){const pack=this.packs.find(p=>p.manifest.contract.capability===capability);if(!pack)throw Error('CAPABILITY_UNSUPPORTED');return pack.manifest.contract.inputSchemas[0];}
 outputSchema(capability:string){const pack=this.packs.find(p=>p.manifest.contract.capability===capability);if(!pack)throw Error('CAPABILITY_UNSUPPORTED');return pack.manifest.contract.outputSchemas[0];}
 async submit(peer:Peer,body:SdkSubmission){
  if(this.graphs&&body&&body.workflow&&'nodes' in body.workflow&&Array.isArray(body.workflow.nodes)&&body.workflow.nodes.length>1)return this.graphs.submit(peer,body);
  if(!exact(body,['workflow','options'])||!exact(body.options,['requestId','budgetMs','resultDestination'],['inputLocation','priority'])||body.options.priority!==undefined&&!['REMOTE_INTERACTIVE','REMOTE_BATCH'].includes(body.options.priority)||body.options.inputLocation!==undefined&&body.options.inputLocation!=='ORIGIN'||!protocolId(body.options.requestId)||body.options.requestId.length>100||!Number.isSafeInteger(body.options.budgetMs)||body.options.budgetMs<0||body.options.budgetMs>30000)throw Error('SDK_SUBMISSION_INVALID');
  if(body.options.resultDestination!=='ORIGIN')throw Error('SDK_RESULT_DESTINATION_UNSUPPORTED');
  const root=body.workflow;
  if(!root||root.version!==3||!protocolId(root.id)||typeof root.outputContract!=='string'||root.qualityTarget!=='reference')throw Error('SDK_WORKFLOW_INVALID');
  const alternatives='alternatives' in root;
  if(!exact(root,alternatives?['version','id','outputContract','qualityTarget','alternatives']:['version','id','outputContract','qualityTarget','nodes']))throw Error('SDK_WORKFLOW_INVALID');
  const workflows=alternatives?root.alternatives:[root as SdkWorkflow];
  if(!Array.isArray(workflows)||!workflows.length||workflows.length>8)throw Error('SDK_ALTERNATIVES_INVALID');
  for(const w of workflows){
   if(!exact(w,['version','id','outputContract','qualityTarget','nodes'])||w.version!==3||!protocolId(w.id)||!Array.isArray(w.nodes)||!w.nodes.length)throw Error('SDK_WORKFLOW_INVALID');
   if(w.outputContract!==root.outputContract||w.qualityTarget!==root.qualityTarget)throw Error('SDK_ALTERNATIVES_NOT_EQUIVALENT');
   if(w.nodes.length!==1)throw Error('SDK_MULTI_NODE_REQUIRES_S5');
   const n=w.nodes[0];
   if(!exact(n,['id','capability','input','parameters','dependsOn'],['targetId','modelManifest'])||!protocolId(n.id)||!Array.isArray(n.dependsOn)||n.dependsOn.length||typeof n.parameters!=='string'||Buffer.byteLength(n.parameters)>32768||n.targetId!==undefined&&!protocolId(n.targetId))throw Error('SDK_NODE_INVALID');
   try{JSON.parse(n.parameters);}catch{throw Error('SDK_NODE_INVALID');}
   const pack=this.packs.find(p=>p.manifest.contract.capability===n.capability),input=n.input!;
   if(!pack||!pack.manifest.contract.outputSchemas.includes(w.outputContract))throw Error('SDK_OUTPUT_CONTRACT_INVALID');
   if(n.modelManifest!==undefined&&(!validModelManifestV2(n.modelManifest)||!sameModelV2(n.modelManifest,pack.manifest.model)))throw Error('SDK_MODEL_MISMATCH');
   if(!exact(input,['contentHash','bytes','schemaId','schemaVersion'])||!/^[a-f0-9]{64}$/.test(input.contentHash)||!Number.isSafeInteger(input.bytes)||input.bytes<1||input.bytes>8388608||input.schemaVersion!==1||!pack.manifest.contract.inputSchemas.includes(input.schemaId))throw Error('SDK_INPUT_INVALID');
  }
  const node=workflows[0].nodes[0];
  // S3's initial adapter shares one input and capability. General multi-stage/data paths are S5.
  if(workflows.some(w=>w.nodes[0].capability!==node.capability||canonical(w.nodes[0].input)!==canonical(node.input)))throw Error('SDK_ALTERNATIVES_REQUIRE_S5');
  const fingerprint=createHash('sha256').update(canonical(body)).digest('hex');
  return this.jobs.submit(peer,{requestId:body.options.requestId,priority:body.options.priority,capability:node.capability,contentHash:node.input!.contentHash,bytes:node.input!.bytes,budgetMs:body.options.budgetMs,parameters:node.parameters,...(body.options.inputLocation?{inputLocation:body.options.inputLocation}:{})},workflows.map(w=>({parameters:w.nodes[0].parameters,...(w.nodes[0].targetId?{targetId:w.nodes[0].targetId}:{})})),fingerprint);
 }
 async start(peer:Peer,id:string){return this.graphs&&await this.graphs.exists(id)?this.graphs.start(peer,id):this.jobs.start(peer,id);}
 async received(peer:Peer,id:string,body:unknown){if(await this.graphs?.exists(id))return this.graphs!.received(peer,id,body);const result=await this.jobs.received(peer,await this.jobs.winnerFor(peer,id),body);await this.retention?.sweepRelay();return result;}
 async status(peer:Peer,id:string){if(this.graphs&&await this.graphs.exists(id))return this.graphs.status(peer,id);
  const result=await this.jobs.logicalStatus(peer,id);
  if(result.state==='REJECTED'&&this.graphs&&await this.graphs.exists(id))return this.graphs.status(peer,id);
  return result;}
 async cancel(peer:Peer,id:string){return this.graphs&&await this.graphs.exists(id)?this.graphs.cancel(peer,id):this.jobs.cancel(peer,id);}
}

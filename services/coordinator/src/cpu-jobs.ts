import { randomUUID } from 'node:crypto';
import { canonical, DispatchOfferV2, sampleUsableV2, protocolId } from '@harmony/scheduler-core';
import { ArtifactChannel, ArtifactDescriptor } from '@harmony/resource-transport';
import { builtinCpuPacks } from '@harmony/reference-capabilities';
import { PrismaClient } from '../generated/client';
import { Peer } from './channel';
import { DeviceDirectory } from './directory';
import { CoordinatorStore } from './store';
import { AllotmentIssuer } from './allotments';
import { ProfileProjection } from './profile-projection';
import { SnapshotBuilder } from './planning';

interface JobData {offer:DispatchOfferV2;holderId:string;input:ArtifactDescriptor;output:ArtifactDescriptor|null;traceId:string;decisionEvidence?:{snapshotVersion:number;profileSequence:number;profileSampledAt:number};}
/** First usable single-node submission path. Uses qualified available targets, with an optional explicit target. */
export class CpuJobs {
  constructor(private readonly db:PrismaClient,private readonly directory:DeviceDirectory,private readonly profiles:ProfileProjection,
    private readonly snapshots:SnapshotBuilder,private readonly allotments:AllotmentIssuer,private readonly artifacts:ArtifactChannel,
    private readonly store:CoordinatorStore,private readonly epoch:()=>number,private readonly flush:()=>Promise<void>){}
  async submit(peer:Peer,input:any){
    if(!input||!protocolId(input.requestId)||input.requestId.length>100||typeof input.capability!=='string'||typeof input.contentHash!=='string'||!/^[a-f0-9]{64}$/.test(input.contentHash)||
      !Number.isSafeInteger(input.bytes)||input.bytes<1||input.bytes>8388608||input.targetId!==undefined&&!protocolId(input.targetId)||
      Object.keys(input).some(k=>!['requestId','capability','contentHash','bytes','targetId'].includes(k)))throw Error('JOB_INPUT_INVALID');
    const id=input.requestId,existing=await this.db.cpuJob.findUnique({where:{id}});
    if(existing){const d=await this.owned(peer,id);if(d.input.ref.contentHash!==input.contentHash||d.input.bytes!==input.bytes||d.offer.task.contract.capability!==input.capability||input.targetId&&d.offer.target.targetId!==input.targetId)throw Error('JOB_CONFLICT');return this.upload(peer,id,d);}
    const pack=builtinCpuPacks().find(p=>p.manifest.contract.capability===input.capability);if(!pack)throw Error('CAPABILITY_UNSUPPORTED');
    if(!(await this.directory.profiles(peer.groupId)).length)throw Error('NO_AVAILABLE_TARGET');
    await this.profiles.refresh(peer.groupId);
    const {snapshot,policy}=await this.snapshots.build(peer.groupId),now=Date.now();
    const candidates=snapshot.candidates.filter(c=>c.capability===input.capability&&policy.allowedTargetIds.includes(c.targetId)&&(!input.targetId||c.targetId===input.targetId)&&c.observedAt+c.ttlMs>now)
      .sort((a,b)=>(a.computeMs??Infinity)+(a.queueMs??Infinity)-(b.computeMs??Infinity)-(b.queueMs??Infinity)||a.targetId.localeCompare(b.targetId));
    if(policy.revoked||!candidates.length)throw Error('NO_AVAILABLE_TARGET');
    const selected=candidates[0],profile=(await this.directory.profiles(peer.groupId)).find(p=>p.holderInstanceId===selected.holderInstanceId),executor=profile?.executors.find(e=>e.target.targetId===selected.targetId);
    if(!profile||!executor||canonical(executor.contract)!==canonical(pack.manifest.contract))throw Error('TARGET_UNAVAILABLE');
    const grant=(await this.allotments.reservations(profile.deviceId)).find(a=>a.grant.groupId===peer.groupId&&a.grant.holderInstanceId===profile.holderInstanceId)?.grant;
    if(!grant||grant.coordinatorEpoch!==this.epoch())throw Error('ALLOTMENT_UNAVAILABLE');
    const artifact:ArtifactDescriptor={ref:{artifactId:'in-'+id,contentVersion:1,contentHash:input.contentHash,schemaId:pack.manifest.contract.inputSchemas[0],schemaVersion:1},
      groupId:peer.groupId,ownerPrincipalId:peer.principalId,domain:this.directory.domain,bytes:input.bytes,expiresAt:now+3600000};
    const offer:DispatchOfferV2={task:{groupId:peer.groupId,sessionId:null,originDeviceId:peer.deviceId,resultDestination:peer.deviceId,workflowId:id,nodeId:'compute',attemptId:id,
      coordinatorEpoch:this.epoch(),planRevision:1,app:{groupId:peer.groupId,principalId:peer.principalId,appId:'cpu-console',appInstanceId:peer.holderInstanceId,allowedContracts:[pack.manifest.contract.contractId]},
      contract:executor.contract,budget:{remainingMs:30000,deadlineAt:now+30000},inputs:[artifact.ref],allowedTargetIds:[executor.target.targetId],qualityTarget:'reference',privacy:'AUTHORIZED_REMOTE',
      priority:'REMOTE_INTERACTIVE',parameters:'{}',allowedConfigurations:executor.configurations.map(c=>c.id),businessIdempotencyKey:null},target:executor.target,resources:executor.resources,allowedConfigs:executor.configurations,
      allotmentId:grant.allotmentId,allotmentVersion:grant.version,leaseMs:30000,transferPlan:[],dependencies:[],reasonCode:input.targetId?'USER_TARGET':'QUALIFIED_CPU_BASELINE'};
    const data:JobData={offer,holderId:profile.holderInstanceId,input:artifact,output:null,traceId:randomUUID(),decisionEvidence:{snapshotVersion:snapshot.version,profileSequence:profile.sequence,profileSampledAt:profile.ownerActivity.sampledAt}};
    this.artifacts.register(artifact);
    await this.db.cpuJob.create({data:{id,groupId:peer.groupId,principalId:peer.principalId,sourceHolderId:peer.holderInstanceId,state:'WAITING_INPUT',metadataJson:JSON.stringify(data)}});
    return this.upload(peer,id,data);
  }
  private upload(peer:Peer,id:string,d:JobData){return {jobId:id,targetId:d.offer.target.targetId,deviceId:d.offer.target.deviceId,reason:d.offer.reasonCode,inputTicket:this.artifacts.issue(d.input,peer,'WRITE')};}
  private async owned(peer:Peer,id:string):Promise<JobData>{
    const row=await this.db.cpuJob.findUnique({where:{id}});if(!row||row.groupId!==peer.groupId||row.principalId!==peer.principalId||row.sourceHolderId!==peer.holderInstanceId)throw Error('JOB_SCOPE');return JSON.parse(row.metadataJson);
  }
  async start(peer:Peer,id:string){
    let data=await this.owned(peer,id),row=await this.db.cpuJob.findUniqueOrThrow({where:{id}});
    if(!this.artifacts.available(data.input))throw Error('INPUT_NOT_UPLOADED');
    if(row.state==='WAITING_INPUT'){
      const grant=(await this.allotments.reservations(data.offer.target.deviceId)).find(r=>r.grant.groupId===peer.groupId&&r.grant.holderInstanceId===data.holderId)?.grant;
      if(!grant||grant.coordinatorEpoch!==this.epoch())throw Error('ALLOTMENT_UNAVAILABLE');
      data.offer.allotmentVersion=grant.version;data.offer.task.coordinatorEpoch=this.epoch();data.offer.task.budget.deadlineAt=Date.now()+30000;
      await this.db.cpuJob.updateMany({where:{id,state:'WAITING_INPUT'},data:{state:'DISPATCHING',metadataJson:JSON.stringify(data)}});
      row=await this.db.cpuJob.findUniqueOrThrow({where:{id}});data=JSON.parse(row.metadataJson);
    }
    if(row.state==='DISPATCHING'){
      if(data.offer.task.coordinatorEpoch!==this.epoch())throw Error('JOB_RECOVERY_REQUIRED');
      await this.store.persistOffer(data.offer,data.holderId,{protocolVersion:2,messageId:'job-'+id,type:'DispatchOffer',groupId:peer.groupId,senderInstanceId:this.store.senderInstanceId,
        coordinatorEpoch:this.epoch(),seq:1,ackOf:null,traceId:data.traceId,payload:JSON.stringify(data.offer),extensions:[]});
      await this.db.cpuJob.update({where:{id},data:{state:'DISPATCHED'}});
    }
    await this.flush();return this.status(peer,id);
  }
  async status(peer:Peer,id:string){
    const d=await this.owned(peer,id),attempt=await this.db.attempt.findUnique({where:{id}}),receipt=await this.db.receipt.findUnique({where:{id}});
    const result=receipt?JSON.parse(receipt.recordJson):null;
    const committed=receipt?.committed===true&&result?.state==='SUCCEEDED'&&d.output&&result.outputs.some((r:any)=>canonical(r)===canonical(d.output!.ref));
    return {jobId:id,state:attempt?.state??'WAITING_INPUT',targetId:d.offer.target.targetId,deviceId:d.offer.target.deviceId,traceId:d.traceId,
      decisionEvidence:d.decisionEvidence??null,
      rejection:attempt?.rejectionJson?JSON.parse(attempt.rejectionJson):null,
      dispatch:{coordinatorEpoch:d.offer.task.coordinatorEpoch,planRevision:d.offer.task.planRevision,allotmentId:d.offer.allotmentId,allotmentVersion:d.offer.allotmentVersion},
      outputTicket:committed&&d.output&&this.artifacts.available(d.output)?this.artifacts.issue(d.output,peer,'READ'):null};
  }
  async execution(peer:Peer,id:string,action:string,body:any){
    const row=await this.db.cpuJob.findUnique({where:{id}}),attempt=await this.db.attempt.findUnique({where:{id}});
    if(!row||row.groupId!==peer.groupId||!attempt||attempt.holderInstanceId!==peer.holderInstanceId)throw Error('EXECUTION_SCOPE');
    const d:JobData=JSON.parse(row.metadataJson),offer=d.offer;
    if(offer.target.deviceId!==peer.deviceId||offer.task.coordinatorEpoch!==this.epoch()||!['OFFERED','ACCEPTED','RUNNING'].includes(attempt.state))throw Error('EXECUTION_EXPIRED');
    const evidence=await this.directory.qualification(peer,offer.target.targetId);
    if(!['CANARY','ACTIVE'].includes(evidence.admission.state)||!sampleUsableV2(evidence.admission.quality,Date.now(),this.directory.domain))throw Error('CAPABILITY_NOT_QUALIFIED');
    if(action==='authorize')return {offer,inputTicket:this.artifacts.issue(d.input,peer,'READ')};
    if(action==='input')return {ticket:this.artifacts.issue(d.input,peer,'READ')};
    if(action!=='output'||!body||!Number.isSafeInteger(body.bytes)||body.bytes<1||body.bytes>8388608||typeof body.contentHash!=='string'||!/^[a-f0-9]{64}$/.test(body.contentHash)||!offer.task.contract.outputSchemas.includes(body.schemaId))throw Error('OUTPUT_INVALID');
    const output:ArtifactDescriptor={...d.input,ref:{artifactId:'out-'+id,contentVersion:1,contentHash:body.contentHash,schemaId:body.schemaId,schemaVersion:1},bytes:body.bytes};
    if(d.output&&canonical(d.output)!==canonical(output))throw Error('OUTPUT_CONFLICT');
    this.artifacts.register(output);d.output=output;await this.db.cpuJob.update({where:{id},data:{metadataJson:JSON.stringify(d)}});
    return {ticket:this.artifacts.issue(output,peer,'WRITE')};
  }
}

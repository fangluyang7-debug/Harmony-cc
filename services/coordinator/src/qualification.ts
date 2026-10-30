import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '../generated/client';
import { CapabilityPackV2, CapabilityAdmissionV2, ExecutorV2, ExecutionConfigV2, canonical, sameModelV2, validCapabilityPackV2, validExecutionConfigV2, sampleUsableV2, vectorFitsV2 } from '@harmony/scheduler-core';
import { DeviceDirectory, executorIdentity } from './directory';
import { Peer } from './channel';

export interface EvaluationCase {id:string;input:Buffer;parameters:string;config:ExecutionConfigV2;maxOutputBytes:number;}
/** Installed by the host, never constructed from a device advertisement or an HTTP payload. */
export interface TrustedPack {manifest:CapabilityPackV2;cases:EvaluationCase[];evaluate:(test:EvaluationCase,output:Buffer)=>Promise<number>;}
export interface EvaluationPolicy {maxRuns:number;maxDurationMs:number;maxBytes:number;maxConcurrent:number;caseTimeoutMs:number;canarySamples:number;activeSamples:number;evidenceTtlMs:number;cooldownMs:number;}
export interface EvaluationPermit {id:string;groupId:string;holderInstanceId:string;targetId:string;identity:string;packDigest:string;caseId:string;inputHash:string;config:ExecutionConfigV2;maxOutputBytes:number;timeoutMs:number;domain:'REAL'|'SIMULATED';}
export interface EvaluationResult {settled:true;output:Buffer;durationMs:number;permitId:string;domain:'REAL'|'SIMULATED';}
/** Adapter MUST enforce permit scope and real quota, persist attempt identity, and only return after engine settlement. */
export interface EvaluationRunner {
  run(permit:EvaluationPermit,test:EvaluationCase,executor:ExecutorV2,signal:AbortSignal):Promise<EvaluationResult>;
  reconcile(permit:EvaluationPermit):Promise<EvaluationResult|null>;
}
interface Job {
  identity:string;packDigest:string;ledgerEpoch:number;generation:number;next:number;runs:number;durationMs:number;bytes:number;
  paused:boolean;cooldownUntil:number;expiresAt:number;quality:number|null;inFlight:EvaluationPermit|null;lastDurationMs:number|null;
}
const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
const inputHash=(input:Buffer)=>createHash('sha256').update(input).digest('hex');
export class QualificationService {
  private readonly installed:ReadonlyArray<{pack:TrustedPack;digest:string}>;
  private readonly busy=new Map<string,AbortController>();
  constructor(private readonly db:PrismaClient,private readonly directory:DeviceDirectory,packs:TrustedPack[],
    private readonly runner:EvaluationRunner,private readonly policy:EvaluationPolicy,
    private readonly gate:(peer:Peer,executor:ExecutorV2)=>Promise<'AUTH'|'MODEL'|'RESOURCE'|'WINDOW'|null>,private readonly now:()=>number=Date.now){
    if(Object.values(policy).some(n=>!Number.isSafeInteger(n)||n<1)||policy.canarySamples>policy.activeSamples||policy.activeSamples>policy.maxRuns||policy.maxConcurrent>16)throw Error('EVALUATION_POLICY_INVALID');
    this.installed=packs.map(original=>{
      const pack={manifest:structuredClone(original.manifest),cases:original.cases.map(c=>({...structuredClone(c),input:Buffer.from(c.input)})),evaluate:original.evaluate};
      if(!validCapabilityPackV2(pack.manifest)||pack.manifest.contract.sideEffectPolicy!=='PURE'||pack.cases.length<1||pack.cases.length>128||new Set(pack.cases.map(c=>c.id)).size!==pack.cases.length||
        pack.cases.some(c=>!c.id||!validExecutionConfigV2(c.config)||c.input.length>8388608||!Number.isSafeInteger(c.maxOutputBytes)||c.maxOutputBytes<1||c.maxOutputBytes>8388608))throw Error('TRUSTED_PACK_INVALID');
      for(const c of pack.cases)JSON.parse(c.parameters);
      return {pack,digest:digest({manifest:pack.manifest,cases:pack.cases.map(c=>({...c,input:inputHash(c.input)}))})};
    });
  }
  private key(peer:Peer,targetId:string){return JSON.stringify([peer.groupId,peer.holderInstanceId,targetId]);}
  async pause(peer:Peer,targetId:string,paused:boolean){
    const id=this.key(peer,targetId),row=await this.db.calibrationJob.findUnique({where:{id}});if(!row)throw Error('CALIBRATION_UNKNOWN');
    const job:Job=JSON.parse(row.metadataJson);job.paused=paused;
    await this.db.calibrationJob.update({where:{id},data:{revision:{increment:1},metadataJson:JSON.stringify(job)}});
    if(paused)this.busy.get(id)?.abort();
  }
  private async publish(peer:Peer,targetId:string,job:Job,state:string,reasonCode:string){
    const id=this.key(peer,targetId);
    await this.db.$transaction(async tx=>{
      const row=await tx.capabilityState.findUnique({where:{id}});if(!row||JSON.parse(row.metadataJson).identity!==job.identity)throw Error('EVIDENCE_INVALIDATED');
      const admission:CapabilityAdmissionV2={groupId:peer.groupId,holderInstanceId:peer.holderInstanceId,targetId,identity:job.identity,domain:this.directory.domain,
        revision:row.revision+1,state,reasonCode,quality:{value:job.quality,source:job.quality===null?'UNKNOWN':this.directory.domain==='REAL'?'MEASURED':'SIMULATED',
          sampledAt:job.expiresAt>0?job.expiresAt-this.policy.evidenceTtlMs:this.now(),ttlMs:this.policy.evidenceTtlMs,unit:'score'}};
      await tx.capabilityState.update({where:{id},data:{revision:admission.revision,metadataJson:JSON.stringify(admission)}});
      const data={groupId:peer.groupId,revision:admission.revision,metadataJson:JSON.stringify(job)};
      await tx.calibrationJob.upsert({where:{id},create:{id,...data},update:data});
    });
    return state;
  }
  /** One bounded step. Host calls periodically and on fresh profile/authorization events. */
  async advance(peer:Peer,targetId:string):Promise<string>{
    const id=this.key(peer,targetId);if(this.busy.has(id)||this.busy.size>=this.policy.maxConcurrent)return 'BUSY';
    const abort=new AbortController();this.busy.set(id,abort);
    try{
      const profile=(await this.directory.profiles(peer.groupId)).find(p=>p.holderInstanceId===peer.holderInstanceId&&p.deviceId===peer.deviceId);
      const executor=profile?.executors.find(e=>e.target.targetId===targetId);if(!profile||!executor)throw Error('EXECUTOR_UNKNOWN');
      const identity=executorIdentity(executor),installed=this.installed.find(p=>canonical(p.pack.manifest.contract)===canonical(executor.contract)&&p.pack.manifest.executorIds.includes(executor.target.executorId)&&sameModelV2(p.pack.manifest.model,executor.model));
      const old=await this.db.calibrationJob.findUnique({where:{id}});let job:Job=old?JSON.parse(old.metadataJson):
        {identity,packDigest:installed?.digest??'',ledgerEpoch:profile.ledgerEpoch,generation:1,next:0,runs:0,durationMs:0,bytes:0,paused:false,cooldownUntil:0,expiresAt:0,quality:null,inFlight:null,lastDurationMs:null};
      if(job.inFlight){
        const recovered=await this.runner.reconcile(job.inFlight);
        if(!recovered)return this.publish(peer,targetId,job,'WAITING_RESOURCE','EVALUATION_SETTLEMENT_UNKNOWN');
        // Recovered output is not new quality evidence; resume with a new bounded evaluation only after confirmed settlement.
        if(!recovered.settled||recovered.permitId!==job.inFlight.id||recovered.domain!==this.directory.domain)throw Error('EVALUATION_RECONCILE_INVALID');
        job.inFlight=null;
      }
      if(job.identity!==identity||job.packDigest!==(installed?.digest??'')||job.ledgerEpoch!==profile.ledgerEpoch||job.expiresAt>0&&job.expiresAt<=this.now()){
        job={identity,packDigest:installed?.digest??'',ledgerEpoch:profile.ledgerEpoch,generation:job.generation+1,next:0,runs:0,durationMs:0,bytes:0,paused:job.paused,cooldownUntil:0,expiresAt:0,quality:null,inFlight:null,lastDurationMs:null};
        return this.publish(peer,targetId,job,'SUSPENDED','EVIDENCE_INVALIDATED');
      }
      if(!installed)return this.publish(peer,targetId,job,'SUSPENDED','TRUSTED_PACK_REQUIRED');
      const pack=installed.pack;
      if(job.paused)return this.publish(peer,targetId,job,'WAITING_WINDOW','CALIBRATION_PAUSED');
      const gate=await this.gate(peer,executor);
      if(gate)return this.publish(peer,targetId,job,'WAITING_'+gate,'EVALUATION_'+gate+'_REQUIRED');
      if(!sampleUsableV2(profile.ownerActivity,this.now(),this.directory.domain)||profile.ownerActivity.value!=='IDLE'||
        !sampleUsableV2(profile.foreground,this.now(),this.directory.domain)||profile.foreground.value!=='FOREGROUND')
        return this.publish(peer,targetId,job,'WAITING_WINDOW','OWNER_OR_HOST_NOT_AVAILABLE');
      if(job.cooldownUntil>this.now())return this.publish(peer,targetId,job,'SUSPENDED','EVALUATION_COOLDOWN');
      if(job.quality!==null&&job.next>=Math.max(pack.cases.length,this.policy.activeSamples))return this.publish(peer,targetId,job,'ACTIVE','EVALUATION_PASSED');
      await this.publish(peer,targetId,job,'VALIDATING','CHECKING_TRUSTED_SUITE');
      const test=pack.cases[job.next%pack.cases.length];
      if(!executor.configurations.some(c=>canonical(c)===canonical(test.config))||!vectorFitsV2(executor.resources,pack.manifest.resourceLimit))return this.publish(peer,targetId,job,'SUSPENDED','PACK_EXECUTOR_INCOMPATIBLE');
      const bytes=test.input.length+test.maxOutputBytes;
      if(job.runs>=this.policy.maxRuns||job.durationMs+this.policy.caseTimeoutMs>this.policy.maxDurationMs||job.bytes+bytes>this.policy.maxBytes)return this.publish(peer,targetId,job,'SUSPENDED','EVALUATION_BUDGET_EXHAUSTED');
      const permit:EvaluationPermit={id:randomUUID(),groupId:peer.groupId,holderInstanceId:peer.holderInstanceId,targetId,identity,packDigest:installed.digest,caseId:test.id,
        inputHash:inputHash(test.input),config:structuredClone(test.config),maxOutputBytes:test.maxOutputBytes,timeoutMs:this.policy.caseTimeoutMs,domain:this.directory.domain};
      job.inFlight=permit;job.runs++;job.durationMs+=permit.timeoutMs;job.bytes+=bytes;
      await this.publish(peer,targetId,job,'CALIBRATING','RUNNING_TRUSTED_SUITE');
      const timer=setTimeout(()=>abort.abort(),permit.timeoutMs);
      let result:EvaluationResult;
      try{result=await this.runner.run(permit,{...test,input:Buffer.from(test.input)},executor,abort.signal);}
      catch{const saved=await this.db.calibrationJob.findUniqueOrThrow({where:{id}});job.paused=JSON.parse(saved.metadataJson).paused;return this.publish(peer,targetId,job,'WAITING_RESOURCE','EVALUATION_SETTLEMENT_UNKNOWN');}
      finally{clearTimeout(timer);}
      if(!result.settled||result.permitId!==permit.id||result.domain!==this.directory.domain)return this.publish(peer,targetId,job,'WAITING_RESOURCE','EVALUATION_SETTLEMENT_UNKNOWN');
      job.inFlight=null;
      const latest=await this.db.calibrationJob.findUniqueOrThrow({where:{id}});job.paused=JSON.parse(latest.metadataJson).paused;
      const current=(await this.directory.profiles(peer.groupId)).find(p=>p.holderInstanceId===peer.holderInstanceId);
      if(!current||current.ledgerEpoch!==profile.ledgerEpoch||!current.executors.some(e=>executorIdentity(e)===identity))return this.publish(peer,targetId,job,'SUSPENDED','EVIDENCE_INVALIDATED');
      if(abort.signal.aborted||job.paused)return this.publish(peer,targetId,job,'WAITING_WINDOW','EVALUATION_INTERRUPTED');
      if(!sampleUsableV2(current.ownerActivity,this.now(),this.directory.domain)||current.ownerActivity.value!=='IDLE'||!sampleUsableV2(current.foreground,this.now(),this.directory.domain)||current.foreground.value!=='FOREGROUND')return this.publish(peer,targetId,job,'WAITING_WINDOW','OWNER_OR_HOST_NOT_AVAILABLE');
      const afterGate=await this.gate(peer,executor);if(afterGate)return this.publish(peer,targetId,job,'WAITING_'+afterGate,'EVALUATION_'+afterGate+'_REQUIRED');
      let quality=NaN;
      if(Buffer.isBuffer(result.output)&&result.output.length<=permit.maxOutputBytes&&Number.isFinite(result.durationMs)&&result.durationMs>=0&&result.durationMs<=permit.timeoutMs){
        try{quality=await pack.evaluate(test,result.output);}catch{/* Malformed output fails the suite. */}
      }
      if(!Number.isFinite(quality)||quality<pack.manifest.qualityThreshold||quality>1){
        job.quality=null;job.next=0;job.expiresAt=0;job.cooldownUntil=this.now()+this.policy.cooldownMs;return this.publish(peer,targetId,job,'SUSPENDED','QUALITY_EVALUATION_FAILED');
      }
      job.durationMs-=permit.timeoutMs-result.durationMs;job.bytes-=permit.maxOutputBytes-result.output.length;
      job.lastDurationMs=result.durationMs;job.quality=Math.min(job.quality??1,quality);job.next++;job.expiresAt=this.now()+this.policy.evidenceTtlMs;
      const state=job.next>=Math.max(pack.cases.length,this.policy.activeSamples)?'ACTIVE':job.next>=Math.max(pack.cases.length,this.policy.canarySamples)?'CANARY':'CALIBRATING';
      return this.publish(peer,targetId,job,state,'EVALUATION_PASSED');
    }finally{this.busy.delete(id);}
  }
}

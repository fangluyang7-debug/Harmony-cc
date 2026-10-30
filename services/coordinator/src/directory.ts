import { createHash } from 'node:crypto';
import { Prisma, PrismaClient } from '../generated/client';
import { canonical, DeviceProfileV2, ExecutorV2, validDeviceProfileV2, sampleUsableV2, PlanningSnapshot, PlacementCandidate, DeviceResources, CapabilityAdmissionV2, validCapabilityAdmissionV2 } from '@harmony/scheduler-core';
import { Peer } from './channel';

export interface ContributionPolicy {minimumBattery:number|null;maximumTemperature:number|null;allowMetered:boolean;priority:'ORIGIN_INTERACTIVE'|'REMOTE_INTERACTIVE'|'REMOTE_BATCH';requireForeground:boolean;}
export function executorIdentity(e:ExecutorV2):string{return createHash('sha256').update(canonical({target:e.target,contract:e.contract,model:e.model,resources:e.resources,configurations:e.configurations})).digest('hex');}
export class DeviceDirectory {
  constructor(private readonly db:PrismaClient,readonly domain:'REAL'|'SIMULATED',private readonly now:()=>number=Date.now){}
  async ingest(peer:Peer,profile:DeviceProfileV2,transaction?:Prisma.TransactionClient){
    if(!validDeviceProfileV2(profile)||profile.domain!==this.domain||profile.deviceId!==peer.deviceId||profile.holderInstanceId!==peer.holderInstanceId)throw Error('PROFILE_INVALID');
    const samples=[profile.ownerActivity,profile.foreground,profile.charging,profile.powerSave,profile.battery,profile.temperature,
      ...profile.pools.flatMap(p=>[p.total,p.admissionLimit,p.occupied,p.drainMs]),...profile.executors.flatMap(e=>[e.compute,e.queue,e.cold,e.publish,e.uncertainty]),...profile.links.flatMap(l=>[l.fixedMs,l.bytesPerSecond])];
    if(samples.some(s=>s.sampledAt>this.now()||this.domain==='REAL'&&s.source==='SIMULATED'||this.domain==='SIMULATED'&&s.source==='MEASURED'))throw Error('PROFILE_EVIDENCE_DOMAIN');
    const id=JSON.stringify(['profile',peer.groupId,peer.holderInstanceId]);
    const write=async(tx:Prisma.TransactionClient)=>{
      const row=await tx.deviceInstance.findUnique({where:{id}});
      if(row){
        const old=JSON.parse(row.metadataJson) as DeviceProfileV2;
        if(old.deviceId!==profile.deviceId)throw Error('PROFILE_BINDING_CHANGED');
        if(canonical(old)===canonical(profile))return false;
        if(profile.ledgerEpoch<old.ledgerEpoch||profile.ledgerEpoch===old.ledgerEpoch&&(profile.sequence<=old.sequence||profile.deviceInstanceId!==old.deviceInstanceId))throw Error('PROFILE_REPLAY');
        if(profile.ledgerEpoch!==old.ledgerEpoch&&old.pools.some(p=>p.occupied.value===null||p.occupied.value>0))throw Error('PROFILE_RECOVERY_REQUIRED');
        if(old.pools.some(p=>!profile.pools.some(next=>next.resourcePoolId===p.resourcePoolId)&&(p.occupied.value===null||p.occupied.value>0)))throw Error('PROFILE_POOL_UNSETTLED');
      }
      const others=(await tx.deviceInstance.findMany({where:{groupId:peer.groupId}})).filter(r=>r.id!==id&&r.id.startsWith('["profile",')).map(r=>JSON.parse(r.metadataJson) as DeviceProfileV2);
      if(others.some(p=>p.deviceInstanceId===profile.deviceInstanceId||p.executors.some(e=>profile.executors.some(x=>x.target.targetId===e.target.targetId))))throw Error('PROFILE_INSTANCE_COLLISION');
      await tx.deviceInstance.upsert({where:{id},create:{id,groupId:peer.groupId,revision:profile.sequence,metadataJson:JSON.stringify(profile)},update:{revision:profile.sequence,metadataJson:JSON.stringify(profile)}});
      for(const executor of profile.executors){
        const key=JSON.stringify([peer.groupId,peer.holderInstanceId,executor.target.targetId]);
        const existing=await tx.capabilityState.findUnique({where:{id:key}}),identity=executorIdentity(executor);
        const old=existing?JSON.parse(existing.metadataJson):null;
        if(!old||!validCapabilityAdmissionV2(old)||old.identity!==identity||row&&JSON.parse(row.metadataJson).ledgerEpoch!==profile.ledgerEpoch){
          const admission:CapabilityAdmissionV2={groupId:peer.groupId,holderInstanceId:peer.holderInstanceId,targetId:executor.target.targetId,
            identity,domain:this.domain,revision:(existing?.revision??0)+1,state:existing?'SUSPENDED':'DISCOVERED',
            reasonCode:existing?'EVIDENCE_INVALIDATED':'EVALUATION_REQUIRED',quality:{value:null,source:'UNKNOWN',sampledAt:this.now(),ttlMs:1,unit:'score'}};
          const data={revision:admission.revision,metadataJson:JSON.stringify(admission)};
          await tx.capabilityState.upsert({where:{id:key},create:{id:key,groupId:peer.groupId,...data},update:data});
        }
      }
      // Removing and re-advertising an executor must not resurrect its previous approval.
      for(const previous of row?(JSON.parse(row.metadataJson) as DeviceProfileV2).executors:[]){
        if(profile.executors.some(e=>e.target.targetId===previous.target.targetId))continue;
        const key=JSON.stringify([peer.groupId,peer.holderInstanceId,previous.target.targetId]);
        await tx.capabilityState.deleteMany({where:{id:key}});
      }
      return true;
    };
    return transaction?write(transaction):this.db.$transaction(write);
  }
  async profiles(groupId:string,db:Prisma.TransactionClient=this.db):Promise<DeviceProfileV2[]>{
    const rows=await db.deviceInstance.findMany({where:{groupId}});
    return rows.filter(r=>r.id.startsWith('["profile",')).map(r=>JSON.parse(r.metadataJson)).filter(p=>validDeviceProfileV2(p)&&p.domain===this.domain);
  }
  reason(p:DeviceProfileV2,policy:ContributionPolicy,now:number):string|null{
    if(!sampleUsableV2(p.ownerActivity,now,this.domain)||p.ownerActivity.value!=='IDLE')return 'OWNER_ACTIVE_OR_UNKNOWN';
    if(policy.requireForeground&&(!sampleUsableV2(p.foreground,now,this.domain)||p.foreground.value!=='FOREGROUND'))return 'BACKGROUND';
    if(!sampleUsableV2(p.powerSave,now,this.domain)||p.powerSave.value!=='OFF')return 'POWER_SAVE_OR_UNKNOWN';
    if(policy.minimumBattery!==null&&(!sampleUsableV2(p.battery,now,this.domain)||p.battery.value!<policy.minimumBattery&&(!sampleUsableV2(p.charging,now,this.domain)||p.charging.value!=='CHARGING')))return 'BATTERY_LOW_OR_UNKNOWN';
    if(policy.maximumTemperature!==null&&(!sampleUsableV2(p.temperature,now,this.domain)||p.temperature.value!>policy.maximumTemperature))return 'TEMPERATURE_HIGH_OR_UNKNOWN';
    if(!p.credits.some(c=>c.priority===policy.priority&&c.slots>0))return 'NO_CREDIT';
    return null;
  }
  async snapshot(groupId:string,policyVersion:string,version:number,policy:ContributionPolicy,db:Prisma.TransactionClient=this.db):Promise<PlanningSnapshot>{
    const now=this.now(),profiles=await this.profiles(groupId,db),candidates:PlacementCandidate[]=[],resources:DeviceResources[]=[];
    const capacity=new Map<string,{deviceId:string;poolId:string;total:number|null;occupied:number|null;sampledAt:number;ttlMs:number;kind:string}>();
    for(const p of profiles)for(const pool of p.pools){
      const key=JSON.stringify([p.deviceId,pool.resourcePoolId]),old=capacity.get(key);
      const valid=sampleUsableV2(pool.total,now,this.domain)&&sampleUsableV2(pool.occupied,now,this.domain);
      const total=valid?Math.min(pool.contributionLimit,pool.total.value!-pool.ownerReserved):null;
      capacity.set(key,{deviceId:p.deviceId,poolId:pool.resourcePoolId,total:old?(old.total===total&&old.kind===pool.kind?total:null):total,
        occupied:!valid||old?.occupied===null?null:(old?.occupied??0)+pool.occupied.value!,sampledAt:Math.min(old?.sampledAt??now,pool.total.sampledAt,pool.occupied.sampledAt),ttlMs:Math.min(old?.ttlMs??Infinity,pool.total.ttlMs,pool.occupied.ttlMs),kind:pool.kind});
    }
    for(const c of capacity.values())resources.push({deviceId:c.deviceId,resourcePoolId:c.poolId,available:c.total===null||c.occupied===null?null:Math.max(0,c.total-c.occupied),availableMemoryBytes:null,availableSlots:null,observedAt:c.sampledAt,ttlMs:c.ttlMs});
    for(const p of profiles){
      if(this.reason(p,policy,now))continue;
      for(const e of p.executors){
        const state=await db.capabilityState.findUnique({where:{id:JSON.stringify([groupId,p.holderInstanceId,e.target.targetId])}});
        const qualification=state?JSON.parse(state.metadataJson):null;
        if(!qualification||!validCapabilityAdmissionV2(qualification)||qualification.groupId!==groupId||qualification.holderInstanceId!==p.holderInstanceId||
          qualification.targetId!==e.target.targetId||qualification.revision!==state!.revision||!['CANARY','ACTIVE'].includes(qualification.state)||qualification.identity!==executorIdentity(e)||qualification.domain!==this.domain)continue;
        // The published candidate must expire when ANY gating signal expires, even without another heartbeat.
        const times=[e.compute,e.queue,e.cold,e.publish,e.uncertainty,qualification.quality,p.ownerActivity,p.powerSave,
          ...(policy.requireForeground?[p.foreground]:[]),...(policy.minimumBattery!==null?[p.battery,...(p.battery.value!==null&&p.battery.value<policy.minimumBattery?[p.charging]:[])]:[]),
          ...(policy.maximumTemperature!==null?[p.temperature]:[]),...e.resources.flatMap(r=>{const pool=p.pools.find(x=>x.resourcePoolId===r.resourcePoolId)!;return [pool.admissionLimit,pool.occupied];})];
        if(times.some(s=>!sampleUsableV2(s,now,this.domain)))continue;
        if(e.resources.some(r=>{const pool=p.pools.find(x=>x.resourcePoolId===r.resourcePoolId)!;return pool.draining||!sampleUsableV2(pool.admissionLimit,now,this.domain)||!sampleUsableV2(pool.occupied,now,this.domain)||pool.admissionLimit.value!-pool.occupied.value!<r.amount;}))continue;
        const ram=e.resources.filter(r=>p.pools.some(pool=>pool.resourcePoolId===r.resourcePoolId&&pool.kind==='RAM_BYTES')).reduce((n,r)=>n+r.amount,0);
        const freeRam=p.pools.filter(pool=>pool.kind==='RAM_BYTES'&&e.resources.some(r=>r.resourcePoolId===pool.resourcePoolId)).reduce((n,pool)=>n+pool.admissionLimit.value!-pool.occupied.value!,0);
        candidates.push({targetId:e.target.targetId,deviceId:p.deviceId,holderInstanceId:p.holderInstanceId,executorId:e.target.executorId,capability:e.contract.capability,
          resourcePoolIds:e.target.resourcePoolIds,resourceDemand:e.resources,modelManifest:e.model,requiredMemoryBytes:ram,
          trusted:true,source:this.domain,observedAt:now,ttlMs:Math.max(0,Math.min(...times.map(s=>s.sampledAt+s.ttlMs))-now),availableSlots:p.credits.find(c=>c.priority===policy.priority)!.slots,
          availableMemoryBytes:freeRam,quality:qualification.quality.value,computeMs:e.compute.value,queueMs:e.queue.value,coldMs:e.cold.value,publishMs:e.publish.value!,uncertaintyMs:e.uncertainty.value!});
      }
    }
    const reportedLinks=profiles.flatMap(p=>p.links).filter(l=>sampleUsableV2(l.fixedMs,now,this.domain)&&sampleUsableV2(l.bytesPerSecond,now,this.domain));
    // A directional link with conflicting network epochs is unknown, not the fastest report.
    const links=reportedLinks.filter(l=>(!l.metered||policy.allowMetered)&&l.via===null&&
      !reportedLinks.some(other=>other.from===l.from&&other.to===l.to&&other.networkEpoch!==l.networkEpoch))
      .filter((l,index,all)=>all.findIndex(other=>other.from===l.from&&other.to===l.to)===index)
      .map(l=>({from:l.from,to:l.to,bytesPerSecond:l.bytesPerSecond.value!,fixedMs:l.fixedMs.value!,effective:false,source:this.domain,observedAt:Math.min(l.fixedMs.sampledAt,l.bytesPerSecond.sampledAt),ttlMs:Math.min(l.fixedMs.ttlMs,l.bytesPerSecond.ttlMs)}));
    return {groupId,policyVersion,version,domain:this.domain,capturedAt:now,devices:profiles.map(p=>({deviceId:p.deviceId,holderInstanceId:p.holderInstanceId,deviceInstanceId:p.deviceInstanceId,ledgerEpoch:p.ledgerEpoch,sampledAt:p.ownerActivity.sampledAt,ttlMs:p.ownerActivity.ttlMs})),resources,candidates,links};
  }
}

import {computeHistories} from './performance-feedback';
import {settledProfile} from './dispatch-capacity';
import { createHash } from 'node:crypto';
import { Prisma, PrismaClient } from '../generated/client';
import { CostEstimatePolicy,availability, canonical, DeviceProfileV2, DispatchOfferV2, ExecutorV2, validDeviceProfileV2, sampleUsableV2, PlanningSnapshot, PlacementCandidate, DeviceResources, CapabilityAdmissionV2, validCapabilityAdmissionV2 } from '@harmony/scheduler-core';
import { Peer } from './channel';
import {deviceMembershipActive} from './device-membership';
import type {PlacementLink} from '@harmony/scheduler-core';

export interface ContributionPolicy {minimumBattery:number|null;maximumTemperature:number|null;allowMetered:boolean;priority:'ORIGIN_INTERACTIVE'|'REMOTE_INTERACTIVE'|'REMOTE_BATCH';requireForeground:boolean;}
export function executorIdentity(e:ExecutorV2):string{return createHash('sha256').update(canonical({target:e.target,contract:e.contract,model:e.model,resources:e.resources,configurations:e.configurations})).digest('hex');}
export class DeviceDirectory {
  constructor(private readonly db:PrismaClient,readonly domain:'REAL'|'SIMULATED',private readonly now:()=>number=Date.now,
    private readonly directLinks?:(db:Prisma.TransactionClient,groupId:string)=>Promise<PlacementLink[]>,private readonly registeredEndpoints?:(db:Prisma.TransactionClient,groupId:string)=>Promise<{id:string;epoch:string;holderInstanceId:string}[]>){}
  controlState?:(group:string,holder:string,instance:string,epoch:number)=>string;
  async ingest(peer:Peer,profile:DeviceProfileV2,transaction?:Prisma.TransactionClient){
    if(!validDeviceProfileV2(profile)||profile.domain!==this.domain||profile.deviceId!==peer.deviceId||profile.holderInstanceId!==peer.holderInstanceId)throw Error('PROFILE_INVALID');
    if(peer.app&&profile.executors.some(e=>!peer.app!.allowedContracts.includes(e.contract.contractId)))throw Error('APP_CONTRACT_FORBIDDEN');
    const samples=[...(profile.queued??[]).map(q=>q.elapsed),...(profile.inFlight??[]).flatMap(f=>[f.elapsed,f.remaining]),profile.ownerActivity,profile.foreground,profile.charging,profile.powerSave,profile.battery,profile.temperature,
      ...profile.pools.flatMap(p=>[p.total,p.admissionLimit,p.occupied,p.drainMs]),...profile.executors.flatMap(e=>[e.compute,e.queue,e.cold,e.publish,e.uncertainty]),...profile.links.flatMap(l=>[l.fixedMs,l.bytesPerSecond])];
    if(samples.some(s=>s.sampledAt>this.now()||this.domain==='REAL'&&s.source==='SIMULATED'||this.domain==='SIMULATED'&&s.source==='MEASURED'))throw Error('PROFILE_EVIDENCE_DOMAIN');
    const id=JSON.stringify(['profile',peer.groupId,peer.holderInstanceId]);
    const write=async(tx:Prisma.TransactionClient)=>{
      if(!await deviceMembershipActive(tx,peer.deviceId))throw Error('DEVICE_LEFT_SPACE');
      const row=await tx.deviceInstance.findUnique({where:{id}});
      if(row){
        const old=JSON.parse(row.metadataJson) as DeviceProfileV2;
        if(old.deviceId!==profile.deviceId)throw Error('PROFILE_BINDING_CHANGED');
        if(canonical(old)===canonical(profile))return false;
        if(profile.ledgerEpoch<old.ledgerEpoch||profile.ledgerEpoch===old.ledgerEpoch&&(profile.sequence<=old.sequence||profile.deviceInstanceId!==old.deviceInstanceId))throw Error('PROFILE_REPLAY');
        if(profile.ledgerEpoch!==old.ledgerEpoch&&old.pools.some(p=>p.occupied.value===null||p.occupied.value>0)){
          // A settled recovery must be able to replace the pre-crash occupied profile.
          // Use the authenticated persisted lease acknowledgement, not a zero claimed
          // by the new profile alone; unresolved attempts still block admission.
          const lease=await tx.allotment.findUnique({where:{id:JSON.stringify(['allotment',peer.groupId,peer.holderInstanceId])}});
          const reservation=lease?JSON.parse(lease.metadataJson):null,g=reservation?.grant,a=reservation?.ack;
          const reconciled=g&&a&&g.deviceId===peer.deviceId&&g.ledgerEpoch===profile.ledgerEpoch&&
            a.persisted===true&&a.holderInstanceId===peer.holderInstanceId&&a.allotmentId===g.allotmentId&&
            a.ledgerEpoch===g.ledgerEpoch&&a.coordinatorEpoch===g.coordinatorEpoch&&a.version===g.version&&
            Array.isArray(a.occupied)&&a.occupied.every((v:{amount:number})=>v.amount===0)&&
            profile.pools.every(p=>sampleUsableV2(p.occupied,this.now(),this.domain)&&p.occupied.value===0);
          if(!reconciled)throw Error('PROFILE_RECOVERY_REQUIRED');
          const attempts=await tx.attempt.findMany({where:{groupId:peer.groupId,holderInstanceId:peer.holderInstanceId,state:{not:'REJECTED'}},select:{recordJson:true}});
          if(attempts.some(a=>!a.recordJson||JSON.parse(a.recordJson).resourcesSettled!==true))throw Error('PROFILE_RECOVERY_REQUIRED');
        }
        if(old.pools.some(p=>!profile.pools.some(next=>next.resourcePoolId===p.resourcePoolId)&&(p.occupied.value===null||p.occupied.value>0)))throw Error('PROFILE_POOL_UNSETTLED');
      }
      const others=(await tx.deviceInstance.findMany({where:{groupId:peer.groupId}})).filter(r=>r.id!==id&&r.id.startsWith('["profile",')).map(r=>JSON.parse(r.metadataJson) as DeviceProfileV2);
      if(others.some(p=>p.deviceInstanceId===profile.deviceInstanceId||p.executors.some(e=>profile.executors.some(x=>x.target.targetId===e.target.targetId))))throw Error('PROFILE_INSTANCE_COLLISION');
      await tx.deviceInstance.upsert({where:{id},create:{id,groupId:peer.groupId,revision:profile.sequence,metadataJson:JSON.stringify(profile)},update:{revision:profile.sequence,metadataJson:JSON.stringify(profile)}});
      const evidenceRows=await tx.capabilityState.findMany({where:{id:{in:profile.executors.map(e=>JSON.stringify([peer.groupId,peer.holderInstanceId,e.target.targetId]))}}});
      const evidenceById=new Map(evidenceRows.map(e=>[e.id,e]));
      for(const executor of profile.executors){
        const key=JSON.stringify([peer.groupId,peer.holderInstanceId,executor.target.targetId]);
        const existing=evidenceById.get(key),identity=executorIdentity(executor);
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
    const profiles=rows.filter(r=>r.id.startsWith('["profile",')).map(r=>JSON.parse(r.metadataJson)).filter(p=>validDeviceProfileV2(p)&&p.domain===this.domain);
    const active=await Promise.all(profiles.map(p=>deviceMembershipActive(db,p.deviceId)));
    const visible=profiles.filter((_,index)=>active[index]);
    const ids=visible.flatMap(p=>[...(p.inFlight??[]),...(p.queued??[])].map(f=>f.attemptId));
    const settled=ids.length?await db.attempt.findMany({where:{groupId,id:{in:ids},recordJson:{not:null}},select:{id:true,holderInstanceId:true,offerJson:true,recordJson:true}}):[];
    return visible.map(p=>settledProfile(p,settled,this.now(),this.domain));
  }
  /** Credential-scoped evidence read; a device cannot read or approve another holder's execution targets. */
  async qualification(peer:Peer,targetId:string){
    return this.db.$transaction(async tx=>{
      const profile=(await this.profiles(peer.groupId,tx)).find(p=>p.holderInstanceId===peer.holderInstanceId&&p.deviceId===peer.deviceId);
      const executor=profile?.executors.find(e=>e.target.targetId===targetId);
      const row=await tx.capabilityState.findUnique({where:{id:JSON.stringify([peer.groupId,peer.holderInstanceId,targetId])}});
      const admission=row?JSON.parse(row.metadataJson):null;
      if(!executor||!row||!validCapabilityAdmissionV2(admission)||admission.groupId!==peer.groupId||admission.holderInstanceId!==peer.holderInstanceId||
        admission.targetId!==targetId||admission.domain!==this.domain||admission.revision!==row.revision||admission.identity!==executorIdentity(executor))throw Error('QUALIFICATION_UNAVAILABLE');
      return {executor,admission};
    });
  }
  reason(p:DeviceProfileV2,policy:ContributionPolicy,now:number):string|null{
    if(p.energyGate)return p.energyGate;
    if(!sampleUsableV2(p.ownerActivity,now,this.domain)||p.ownerActivity.value!=='IDLE')return 'OWNER_ACTIVE_OR_UNKNOWN';
    if(policy.requireForeground&&(!sampleUsableV2(p.foreground,now,this.domain)||p.foreground.value!=='FOREGROUND'))return 'BACKGROUND';
    if(!sampleUsableV2(p.powerSave,now,this.domain)||p.powerSave.value!=='OFF')return 'POWER_SAVE_OR_UNKNOWN';
    if(policy.minimumBattery!==null&&(!sampleUsableV2(p.battery,now,this.domain)||p.battery.value!<policy.minimumBattery&&(!sampleUsableV2(p.charging,now,this.domain)||p.charging.value!=='CHARGING')))return 'BATTERY_LOW_OR_UNKNOWN';
    if(policy.maximumTemperature!==null&&(!sampleUsableV2(p.temperature,now,this.domain)||p.temperature.value!>policy.maximumTemperature))return 'TEMPERATURE_HIGH_OR_UNKNOWN';
    if(!p.credits.some(c=>c.priority===policy.priority&&c.slots>0))return 'NO_CREDIT';
    return null;
  }
  /** Runs in the same transaction as first dispatch. An offer can precede the next device profile. */
  async hasDispatchCredit(tx:Prisma.TransactionClient,offer:DispatchOfferV2,holderId:string,identity?:string){
    return !!await this.dispatchAdmission(tx,offer,holderId,identity);
  }
  async dispatchAdmission(tx:Prisma.TransactionClient,offer:DispatchOfferV2,holderId:string,identity?:string,queueWaitMs?:number):Promise<'IMMEDIATE'|'GPU_QUEUE'|null>{
    if(!await deviceMembershipActive(tx,offer.target.deviceId))return null;
    const row=await tx.deviceInstance.findUnique({where:{id:JSON.stringify(['profile',offer.task.groupId,holderId])}});
    if(!row)return null;
    const reported=JSON.parse(row.metadataJson) as DeviceProfileV2,now=this.now();
    const observedIds=[...(reported.inFlight??[]),...(reported.queued??[])].map(f=>f.attemptId);
    const observedFilter=observedIds.length?Prisma.sql`id IN (${Prisma.join(observedIds)})`:Prisma.sql`0`;
    const pending=await tx.$queryRaw<Array<{id:string;holderInstanceId:string;offerJson:string|null;recordJson:string|null}>>`
      SELECT id,holderInstanceId,offerJson,recordJson FROM Attempt
      WHERE groupId=${offer.task.groupId} AND holderInstanceId=${holderId} AND state<>'REJECTED'
      AND (recordJson IS NULL OR json_extract(recordJson,'$.resourcesSettled') IS NOT 1 OR ${observedFilter})`;
    const profile=settledProfile(reported,pending,now,this.domain);
    if(identity){const executor=profile.executors.find(e=>e.target.targetId===offer.target.targetId);if(!executor||executorIdentity(executor)!==identity)return null;}
    if(this.controlState&&this.controlState(offer.task.groupId,holderId,profile.deviceInstanceId,profile.ledgerEpoch)!=='ONLINE')return null;
    if(profile.deviceId!==offer.target.deviceId||profile.energyGate||!sampleUsableV2(profile.ownerActivity,now,this.domain))return null;
    const slots=profile.credits.find(c=>c.priority===offer.task.priority)?.slots??0;
    const observed=new Set((profile.inFlight??[]).map(f=>f.attemptId));
    const reserved=new Map<string,number>();
    let sameCategory=0;
    for(const attempt of pending){
      if(observed.has(attempt.id)||attempt.recordJson&&JSON.parse(attempt.recordJson).resourcesSettled)continue;
      if(!attempt.offerJson)return null;
      const earlier=JSON.parse(attempt.offerJson) as DispatchOfferV2;
      if(earlier.task.priority===offer.task.priority)sameCategory++;
      for(const r of earlier.resources)reserved.set(r.resourcePoolId,(reserved.get(r.resourcePoolId)??0)+r.amount);
    }
    const fits=offer.resources.every(r=>{
      const pool=profile.pools.find(p=>p.resourcePoolId===r.resourcePoolId);
      return !!pool&&sampleUsableV2(pool.admissionLimit,now,this.domain)&&sampleUsableV2(pool.occupied,now,this.domain)&&
        pool.admissionLimit.value!-pool.occupied.value!-(reserved.get(r.resourcePoolId)??0)>=r.amount;
    });
    if(fits&&sameCategory<slots)return 'IMMEDIATE';
    // Existing PC micro-queues can wait without holding physical resources.
    // Keep a short pipeline of prepared GPU work, rather than one offer per RTT.
    if(queueWaitMs===undefined||!Number.isFinite(queueWaitMs)||queueWaitMs<0||queueWaitMs>2000||
      queueWaitMs+1000>=offer.task.budget.remainingMs||offer.task.contract.sideEffectPolicy!=='PURE'||
      !['VULKAN','CUDA'].includes(offer.target.backend)||profile.ownerActivity.value!=='IDLE'||
      !profile.inFlight||!profile.queued)return null;
    const gpu=offer.resources.find(r=>profile.pools.some(p=>p.resourcePoolId===r.resourcePoolId&&p.kind==='GPU_SLOTS'));
    if(!gpu||!offer.resources.every(r=>{const p=profile.pools.find(p=>p.resourcePoolId===r.resourcePoolId);return p&&!p.draining&&sampleUsableV2(p.admissionLimit,now,this.domain)&&sampleUsableV2(p.occupied,now,this.domain)&&r.amount<=p.admissionLimit.value!;}))return null;
    const contenders=new Set(profile.inFlight.filter(f=>f.resources.some(r=>r.resourcePoolId===gpu.resourcePoolId&&r.amount>0)).map(f=>f.attemptId));
    for(const a of pending){if(a.recordJson&&JSON.parse(a.recordJson).resourcesSettled)continue;
      if(a.offerJson&&JSON.parse(a.offerJson).resources.some((r:{resourcePoolId:string;amount:number})=>r.resourcePoolId===gpu.resourcePoolId&&r.amount>0))contenders.add(a.id);}
    // A reported local queue may contain work unknown to this coordinator.
    for(const q of profile.queued)if(q.resources.some(r=>r.resourcePoolId===gpu.resourcePoolId&&r.amount>0))contenders.add(q.attemptId);
    // The PC agent already supports eight pending offers. Limit this physical
    // GPU to its execution lanes + three waiting (at most seven), also bounded by predicted wait
    // and the original budget above. Queueing does not acquire physical slots.
    const unsettled=new Set([...(profile.inFlight??[]).map(f=>f.attemptId),...profile.queued.map(q=>q.attemptId),
      ...pending.filter(a=>!a.recordJson||!JSON.parse(a.recordJson).resourcesSettled).map(a=>a.id)]);
    const lanes=profile.pools.find(p=>p.resourcePoolId===gpu.resourcePoolId)!.admissionLimit.value!;
    if(contenders.size<1||contenders.size>=Math.min(7,lanes+3)||unsettled.size>=7)return null;
    // Category credits describe immediately free execution slots, not queue
    // capacity. Zero credits while this GPU is running must not disable its
    // prepared successor queue; the device still admits execution atomically.
    return 'GPU_QUEUE';
  }
  async snapshot(groupId:string,policyVersion:string,version:number,policy:ContributionPolicy,db:Prisma.TransactionClient=this.db,estimatePolicy?:CostEstimatePolicy):Promise<PlanningSnapshot>{
    const excludedTargets:NonNullable<PlanningSnapshot['excludedTargets']>=[];
    const now=this.now(),profiles=await this.profiles(groupId,db),candidates:PlacementCandidate[]=[],resources:DeviceResources[]=[];
    const admissions=await db.capabilityState.findMany({where:{groupId},select:{id:true,revision:true,metadataJson:true}});
    const states=new Map(admissions.map(row=>[row.id,{revision:row.revision,admission:JSON.parse(row.metadataJson) as CapabilityAdmissionV2}]));
    const identities=new Map<string,string>();
    for(const [key,state] of states)if(state.admission&&validCapabilityAdmissionV2(state.admission)&&['CANARY','ACTIVE'].includes(state.admission.state))identities.set(key,state.admission.identity);
    const histories=await computeHistories(db,groupId,identities,now,estimatePolicy);
    const installations=await db.registeredInstallation.findMany({where:{groupId},select:{id:true,holderInstanceId:true,deviceId:true,state:true}});
    const reservations=(await db.allotment.findMany()).filter(row=>row.id.startsWith('["allotment",')).map(row=>JSON.parse(row.metadataJson));
    const deviceIds=[...new Set(profiles.map(p=>p.deviceId))];
    const budgetRows=await db.device.findMany({where:{id:{in:deviceIds.map(id=>JSON.stringify(['budget',id]))}}});
    const budgets=new Map<string,any>(budgetRows.map(row=>[JSON.parse(row.id)[1],JSON.parse(row.metadataJson)]));
    const allInstallations=await db.registeredInstallation.findMany({where:{deviceId:{in:deviceIds}}});
    // A dormant App must not expire a live sibling's physical capacity. Its durable
    // reservation remains fully deducted below; expiry never releases resources.
    const capacityProfiles=profiles.filter(p=>p.pools.every(pool=>sampleUsableV2(pool.total,now,this.domain)&&sampleUsableV2(pool.occupied,now,this.domain))||
      !budgets.get(p.deviceId)?.bindings.some((b:any)=>b.groupId===groupId&&b.holderInstanceId===p.holderInstanceId)||
      !reservations.some(r=>r.grant.deviceId===p.deviceId&&r.grant.groupId===groupId&&r.grant.holderInstanceId===p.holderInstanceId));
    const capacity=new Map<string,{deviceId:string;poolId:string;total:number|null;occupied:number|null;sampledAt:number;ttlMs:number;kind:string}>();
    for(const p of capacityProfiles)for(const pool of p.pools){
      const key=JSON.stringify([p.deviceId,pool.resourcePoolId]),old=capacity.get(key);
      const valid=sampleUsableV2(pool.total,now,this.domain)&&sampleUsableV2(pool.occupied,now,this.domain);
      const total=valid?Math.min(pool.contributionLimit,pool.total.value!-pool.ownerReserved):null;
      capacity.set(key,{deviceId:p.deviceId,poolId:pool.resourcePoolId,total:old?(old.total===total&&old.kind===pool.kind?total:null):total,
        occupied:!valid||old?.occupied===null?null:(old?.occupied??0)+pool.occupied.value!,sampledAt:Math.min(old?.sampledAt??now,pool.total.sampledAt,pool.occupied.sampledAt),ttlMs:Math.min(old?.ttlMs??Infinity,pool.total.ttlMs,pool.occupied.ttlMs),kind:pool.kind});
    }
    // A process contribution is its own ceiling, not the capacity of the entire device.
    // Use the owner-confirmed physical budget when multiple bound holders report one device.
    for(const deviceId of new Set(profiles.map(p=>p.deviceId))){
      const budget=budgets.get(deviceId);if(!budget)continue;
      const members=capacityProfiles.filter(p=>p.deviceId===deviceId);
      const unissued=allInstallations.filter(i=>i.deviceId===deviceId&&!reservations.some(r=>r.grant.deviceId===deviceId&&r.grant.holderInstanceId===i.holderInstanceId));
      for(const c of capacity.values())if(c.deviceId===deviceId){
        const physical=budget.capacity.find((r:any)=>r.resourcePoolId===c.poolId)?.amount;
        const pools=members.map(p=>p.pools.find(pool=>pool.resourcePoolId===c.poolId));
        if(physical===undefined||members.some(p=>!budget.bindings.some((b:any)=>b.groupId===groupId&&b.holderInstanceId===p.holderInstanceId))||pools.some(pool=>!pool||!sampleUsableV2(pool.total,now,this.domain)||pool.kind!==c.kind)){c.total=null;continue;}
        const hidden=reservations.filter(r=>r.grant.deviceId===deviceId&&!members.some(p=>r.grant.groupId===groupId&&r.grant.holderInstanceId===p.holderInstanceId)).reduce((sum,r)=>sum+(r.reserved.find((v:any)=>v.resourcePoolId===c.poolId)?.amount??0),0);
        const base=unissued.reduce((sum,i)=>sum+(JSON.parse(i.offlineJson).find((v:any)=>v.resourcePoolId===c.poolId)?.amount??0),0);
        c.total=Math.max(0,Math.min(physical,...pools.map(pool=>pool!.total.value!))-hidden-base);
      }
    }
    const inFlight:NonNullable<PlanningSnapshot['inFlight']>=[],queued:NonNullable<PlanningSnapshot['queued']>=[];
    const queuedIds=profiles.flatMap(p=>[...(p.queued??[]),...(p.inFlight??[])].map(q=>q.attemptId));
    const queuedJobs=new Map((await db.cpuJob.findMany({where:{id:{in:queuedIds}}})).map(row=>[row.id,row]));
    const projected=new Set<string>();
    const forecastProfiles=new Map<string,DeviceProfileV2>();
    for(const profile of profiles){
      const live=profile.inFlight;
      const connection=this.controlState?.(groupId,profile.holderInstanceId,profile.deviceInstanceId,profile.ledgerEpoch);
      if(capacityProfiles.includes(profile)&&(connection===undefined||connection==='ONLINE')&&live!==undefined&&profile.pools.every(pool=>!pool.draining&&sampleUsableV2(pool.occupied,now,this.domain)&&sampleUsableV2(pool.admissionLimit,now,this.domain)&&live.reduce((sum,f)=>sum+(f.resources.find(r=>r.resourcePoolId===pool.resourcePoolId)?.amount??0),0)===pool.occupied.value)){
        projected.add(profile.holderInstanceId);
        const forecastFlights:NonNullable<DeviceProfileV2['inFlight']>=[];
        for(const f of live){
          const contract=profile.executors.find(e=>e.target.targetId===f.targetId)?.contract;
          const overdue=contract?.interruptibility==='NON_INTERRUPTIBLE'&&contract.maxNonPreemptibleMs!==null&&sampleUsableV2(f.elapsed,now,this.domain)&&f.elapsed.value!>contract.maxNonPreemptibleMs;
          let releaseAt={...f.remaining,value:f.remaining.value===null?null:f.remaining.sampledAt+f.remaining.value};
          // Estimate waiting; never release actual ledger capacity from a forecast.
          // Fresh elapsed + the admitted decision is a fallback when the host has
          // no same-work survivor history (including its first real input).
          if((!sampleUsableV2(releaseAt,now,this.domain)||releaseAt.value!<=now)&&contract?.sideEffectPolicy==='PURE'&&sampleUsableV2(f.elapsed,now,this.domain)&&f.elapsed.value!==null){
            const row=queuedJobs.get(f.attemptId),data=row?.groupId===groupId?JSON.parse(row.metadataJson):null;
            const selected=data?.holderId===profile.holderInstanceId&&data.offer?.target.targetId===f.targetId?data.plan?.decision?.suggestion?.[0]:null;
            const estimate=selected?selected.executionMs-(selected.policyQueueMs??0)+(selected.uncertaintyMs??0):null;
            if(typeof estimate==='number'&&Number.isFinite(estimate)&&estimate>0&&data.deadlineAt>now){
              const remaining=Math.max(100,estimate-f.elapsed.value,Math.min(estimate,Math.max(100,f.elapsed.value*.25)));
              releaseAt={value:now+remaining,unit:'ms',source:'PRIOR',sampledAt:now,ttlMs:Math.min(1000,f.elapsed.ttlMs)};
            }
          }
          inFlight.push({deviceId:profile.deviceId,holderInstanceId:profile.holderInstanceId,targetId:f.targetId,resources:f.resources,overdue,releaseAt});
          forecastFlights.push({...f,remaining:{...releaseAt,value:releaseAt.value===null?null:Math.max(0,releaseAt.value-releaseAt.sampledAt)}});
        }
        // Use the same forecast for candidate eligibility and pool reservations.
        // Previously the latter knew when a busy GPU would finish, while the
        // former still rejected it as RESOURCE_WAIT_UNKNOWN using raw telemetry.
        forecastProfiles.set(profile.holderInstanceId,{...profile,inFlight:forecastFlights});
      }
      for(const q of profile.queued??[]){
        const job=queuedJobs.get(q.attemptId);
        const data=job?.groupId===groupId?JSON.parse(job.metadataJson):null;
        const selected=data?.holderId===profile.holderInstanceId&&data.offer?.target.targetId===q.targetId?data.plan?.decision?.suggestion?.[0]:null;
        const duration=selected?selected.executionMs-(selected.policyQueueMs??0):null;
        const value=typeof duration==="number"&&Number.isFinite(duration)&&duration>=0?duration:null;
        queued.push({deviceId:profile.deviceId,holderInstanceId:profile.holderInstanceId,targetId:q.targetId,resources:q.resources,priority:q.priority,attemptId:q.attemptId,elapsedMs:q.elapsed.value??0,holdEstimate:{unit:'ms',value,source:value===null?'UNKNOWN':'PRIOR',sampledAt:q.elapsed.sampledAt,ttlMs:q.elapsed.ttlMs}});
      }
    }
    for(const f of inFlight)for(const d of f.resources){const pool=capacity.get(JSON.stringify([f.deviceId,d.resourcePoolId]));if(pool?.occupied!==null&&pool)pool.occupied-=d.amount;}
    // A durable offer already consumes dispatch credit before the next heartbeat.
    // Price that queue in the planner too, instead of repeatedly selecting the
    // same apparently idle GPU and discovering the reservation only at admission.
    const offered=await db.$queryRaw<Array<{id:string;holderInstanceId:string;offerJson:string;metadataJson:string|null}>>`
      SELECT a.id,a.holderInstanceId,a.offerJson,j.metadataJson FROM Attempt a
      LEFT JOIN CpuJob j ON j.id=a.id WHERE a.groupId=${groupId} AND a.state<>'REJECTED'
      AND a.offerJson IS NOT NULL AND (a.recordJson IS NULL OR json_extract(a.recordJson,'$.resourcesSettled') IS NOT 1)`;
    for(const row of offered){
      const p=profiles.find(p=>p.holderInstanceId===row.holderInstanceId);
      if(!p||!projected.has(p.holderInstanceId)||(p.inFlight??[]).some(f=>f.attemptId===row.id)||(p.queued??[]).some(q=>q.attemptId===row.id))continue;
      const offer=JSON.parse(row.offerJson) as DispatchOfferV2;
      if(offer.target.deviceId!==p.deviceId||offer.task.attemptId!==row.id)continue;
      const data=row.metadataJson?JSON.parse(row.metadataJson):null,selected=data?.plan?.decision?.suggestion?.[0];
      // Match the heartbeat-reported queue's expected service duration. The
      // candidate's own uncertainty remains in its completion estimate; adding
      // that margin to every pending predecessor inflated GPU queues until ACK.
      const estimate=selected?selected.executionMs-(selected.policyQueueMs??0):null;
      const value=typeof estimate==='number'&&Number.isFinite(estimate)&&estimate>0&&data.deadlineAt>now?estimate:null;
      queued.push({deviceId:p.deviceId,holderInstanceId:p.holderInstanceId,targetId:offer.target.targetId,resources:offer.resources,priority:offer.task.priority,attemptId:row.id,elapsedMs:0,
        holdEstimate:{value,unit:'ms',source:value===null?'UNKNOWN':'PRIOR',sampledAt:now,ttlMs:1000}});
    }
    for(const c of capacity.values())resources.push({deviceId:c.deviceId,resourcePoolId:c.poolId,capacity:c.total,available:c.total===null||c.occupied===null?null:Math.max(0,c.total-c.occupied),availableMemoryBytes:null,availableSlots:null,observedAt:c.sampledAt,ttlMs:c.ttlMs});
    for(const p of profiles){
      const connection=this.controlState?.(groupId,p.holderInstanceId,p.deviceInstanceId,p.ledgerEpoch);
      const gate=connection&&connection!=='ONLINE'?'CONTROL_'+connection:this.reason(p,policy,now);
      const installation=installations.find(i=>i.holderInstanceId===p.holderInstanceId);
      if(installation&&(installation.state!=='ACTIVE'||installation.deviceId!==p.deviceId))continue;
      if(gate&&!(gate==='NO_CREDIT'&&(p.inFlight!==undefined||p.credits.some(c=>c.priority!=='ORIGIN_INTERACTIVE'&&c.slots>0)))){
        for(const e of p.executors)excludedTargets.push({deviceId:p.deviceId,targetId:e.target.targetId,executorId:e.target.executorId,
          capability:e.contract.capability,appInstanceId:installation?.id,code:gate});
        continue;
      }
      for(const e of p.executors){
        const targetKey=JSON.stringify([groupId,p.holderInstanceId,e.target.targetId]),state=states.get(targetKey);
        const qualification=state?.admission;
        if(!qualification||!validCapabilityAdmissionV2(qualification)||qualification.groupId!==groupId||qualification.holderInstanceId!==p.holderInstanceId||
          qualification.targetId!==e.target.targetId||qualification.revision!==state!.revision||!['CANARY','ACTIVE'].includes(qualification.state)||qualification.identity!==executorIdentity(e)||qualification.domain!==this.domain)continue;
        // The published candidate must expire when ANY gating signal expires, even without another heartbeat.
        const times=[qualification.quality,p.ownerActivity,p.powerSave,
          ...(policy.requireForeground?[p.foreground]:[]),...(policy.minimumBattery!==null?[p.battery,...(p.battery.value!==null&&p.battery.value<policy.minimumBattery?[p.charging]:[])]:[]),
          ...(policy.maximumTemperature!==null?[p.temperature]:[]),...e.resources.flatMap(r=>{const pool=p.pools.find(x=>x.resourcePoolId===r.resourcePoolId)!;return [pool.admissionLimit,pool.occupied];})];
        if(times.some(s=>!sampleUsableV2(s,now,this.domain)))continue;
        const projects=projected.has(p.holderInstanceId);
        if(e.resources.some(r=>{
          const pool=p.pools.find(x=>x.resourcePoolId===r.resourcePoolId)!;
          // Finishing an attempt can release occupied units, but cannot raise the owner's admission ceiling.
          return pool.admissionLimit.value!<r.amount||pool.draining||(!projects&&pool.admissionLimit.value!-pool.occupied.value!<r.amount&&p.inFlight===undefined);
        }))continue;
        const ram=e.resources.filter(r=>p.pools.some(pool=>pool.resourcePoolId===r.resourcePoolId&&pool.kind==='RAM_BYTES')).reduce((n,r)=>n+r.amount,0);
        const freeRam=p.pools.filter(pool=>pool.kind==='RAM_BYTES'&&e.resources.some(r=>r.resourcePoolId===pool.resourcePoolId)).reduce((n,pool)=>n+pool.admissionLimit.value!-(projects?0:pool.occupied.value!),0);
        const forecast=forecastProfiles.get(p.holderInstanceId)??p;
        const categoryCapacity=p.credits.filter(c=>c.priority!=='ORIGIN_INTERACTIVE').map(c=>({...c,availability:availability(forecast,e,c.priority,version,now)}));
        const holderCapacity=e.resources.map(r=>{const pool=p.pools.find(x=>x.resourcePoolId===r.resourcePoolId)!;return {resourcePoolId:r.resourcePoolId,amount:Math.max(0,pool.admissionLimit.value!-(projects?0:pool.occupied.value!))};});
        const slots=Math.min(...e.resources.filter(r=>r.amount>0).map(r=>Math.floor(holderCapacity.find(h=>h.resourcePoolId===r.resourcePoolId)!.amount/r.amount)));
        candidates.push({queueObserved:p.queued!==undefined,holderCapacity,...(projects&&Number.isFinite(slots)?{projectedSlots:slots}:{}),categoryCapacity,availability:availability(forecast,e,policy.priority,version,now),targetId:e.target.targetId,deviceId:p.deviceId,holderInstanceId:p.holderInstanceId,executorId:e.target.executorId,capability:e.contract.capability,
          ...(installation?{appInstanceId:installation.id}:{}),
          resourcePoolIds:e.target.resourcePoolIds,resourceDemand:e.resources,modelManifest:e.model,requiredMemoryBytes:ram,
          ...(e.contract.serviceId?{serviceId:e.contract.serviceId}:{}),trusted:true,source:this.domain,observedAt:now,ttlMs:Math.max(0,Math.min(...times.map(s=>s.sampledAt+s.ttlMs))-now),availableSlots:p.credits.find(c=>c.priority===policy.priority)!.slots,
          availableMemoryBytes:freeRam,quality:qualification.quality.value,computeMs:null,queueMs:null,coldMs:null,publishMs:null,uncertaintyMs:null,
          costEvidence:{compute:e.compute,cold:e.cold,publish:e.publish},configId:e.configurations[0]?.id,startup:e.startup,
          computeSamples:histories.get(targetKey)});
      }
    }
    const reportedLinks=profiles.flatMap(p=>p.links).filter(l=>sampleUsableV2(l.fixedMs,now,this.domain)&&sampleUsableV2(l.bytesPerSecond,now,this.domain));
    // A directional link with conflicting network epochs is unknown, not the fastest report.
    const links:PlacementLink[]=reportedLinks.filter(l=>(!l.metered||policy.allowMetered)&&l.via===null&&
      !reportedLinks.some(other=>other.from===l.from&&other.to===l.to&&other.networkEpoch!==l.networkEpoch))
      .filter((l,index,all)=>all.findIndex(other=>other.from===l.from&&other.to===l.to)===index)
      .map(l=>({from:l.from,to:l.to,bytesPerSecond:l.bytesPerSecond.value!,fixedMs:l.fixedMs.value!,effective:false,source:this.domain,observedAt:Math.min(l.fixedMs.sampledAt,l.bytesPerSecond.sampledAt),ttlMs:Math.min(l.fixedMs.ttlMs,l.bytesPerSecond.ttlMs)}));
    if(policy.allowMetered&&this.directLinks)links.push(...await this.directLinks(db,groupId));
    const endpoints=await this.registeredEndpoints?.(db,groupId)??[];
    for(const candidate of candidates){
      const endpoint=endpoints.find(e=>e.holderInstanceId===candidate.holderInstanceId);
      if(endpoint)candidate.dataEndpoint={id:endpoint.id,epoch:endpoint.epoch};
    }
    return {groupId,policyVersion,version,domain:this.domain,capturedAt:now,devices:profiles.map(p=>({deviceId:p.deviceId,holderInstanceId:p.holderInstanceId,deviceInstanceId:p.deviceInstanceId,ledgerEpoch:p.ledgerEpoch,sampledAt:p.ownerActivity.sampledAt,ttlMs:p.ownerActivity.ttlMs})),resources,candidates,links,excludedTargets,inFlight,queued};
  }
}

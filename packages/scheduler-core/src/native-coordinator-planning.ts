// Native coordinator projection into the same planner used by the Windows service.
import {photoOutputBound} from './photo-size';
import {plan} from './planning-api';
import {availability} from './availability';
import {sampleUsableV2} from './resources-v2';
import {canonical} from './cost';
import {workKeyV2} from './capability-cost-model';
export function nativePlanJson(profilesJson:string,evidenceJson:string,requestJson:string,now:number,monotonic:()=>number):string {
 const profiles=JSON.parse(profilesJson),evidence=JSON.parse(evidenceJson),input=JSON.parse(requestJson);
 const version=now,priority=input.priority??'REMOTE_INTERACTIVE',candidates:any[]=[],resources:any[]=[],links:any[]=[],inFlight:any[]=[],queued:any[]=[];
 const backlog=(input.backlog??[]).map((s:string)=>JSON.parse(s));
 const usable=(s:any)=>sampleUsableV2(s,now,'REAL');
 for(const p of profiles){
  if(input.originLocal&&p.holderInstanceId!==input.originHolderId)continue;
  if(!usable(p.ownerActivity)||p.ownerActivity.value!=='IDLE'||!usable(p.foreground)||p.foreground.value!=='FOREGROUND'||!usable(p.powerSave)||p.powerSave.value==='ON'||p.energyGate&&p.energyGate!=='NONE')continue;
  const jobs=backlog.filter((j:any)=>j.owner.groupId===input.groupId&&j.holder===p.holderInstanceId&&j.deadlineAt>now);
  const selected=(id:string,target:string)=>{const j=jobs.find((j:any)=>j.offer?.task.attemptId===id&&j.offer.target.targetId===target);return j?JSON.parse(j.decision).decision.suggestion?.[0]:null;};
  // Unacknowledged durable offers were added to occupied by the database adapter.
  // Represent them once as queue reservations instead of both occupied and queued.
  const pending=jobs.filter((j:any)=>!p.inFlight?.some((f:any)=>f.attemptId===j.offer.task.attemptId)&&!p.queued?.some((q:any)=>q.attemptId===j.offer.task.attemptId));
  for(const j of pending){if(p.queued===undefined)continue;for(const r of j.offer.resources){const pool=p.pools.find((v:any)=>v.resourcePoolId===r.resourcePoolId);if(pool&&usable(pool.occupied))pool.occupied.value=Math.max(0,pool.occupied.value-r.amount);}if(p.queued)p.queued.push({attemptId:j.offer.task.attemptId,targetId:j.offer.target.targetId,resources:j.offer.resources,priority:j.offer.task.priority,elapsed:{value:0,source:'PRIOR',sampledAt:now,ttlMs:1000,unit:'ms'}});}
  for(const f of p.inFlight??[]){
   if(usable(f.remaining)&&f.remaining.sampledAt+f.remaining.value>now)continue;
   const e=p.executors.find((e:any)=>e.target.targetId===f.targetId),s=selected(f.attemptId,f.targetId),estimate=s?s.executionMs-(s.policyQueueMs??0)+(s.uncertaintyMs??0):null;
   if(e?.contract.sideEffectPolicy==='PURE'&&usable(f.elapsed)&&Number.isFinite(estimate)&&estimate>0){const left=Math.max(100,estimate-f.elapsed.value,Math.min(estimate,Math.max(100,f.elapsed.value*.25)));f.remaining={value:left,source:'PRIOR',sampledAt:now,ttlMs:Math.min(1000,f.elapsed.ttlMs),unit:'ms'};}
  }
  const projects=p.inFlight!==undefined&&p.pools.every((pool:any)=>!pool.draining&&usable(pool.occupied)&&usable(pool.admissionLimit)&&p.inFlight.reduce((sum:number,f:any)=>sum+(f.resources.find((r:any)=>r.resourcePoolId===pool.resourcePoolId)?.amount??0),0)===pool.occupied.value);
  if(projects)for(const f of p.inFlight){const c=p.executors.find((e:any)=>e.target.targetId===f.targetId)?.contract,overdue=c?.interruptibility==='NON_INTERRUPTIBLE'&&c.maxNonPreemptibleMs!==null&&usable(f.elapsed)&&f.elapsed.value>c.maxNonPreemptibleMs;inFlight.push({deviceId:p.deviceId,holderInstanceId:p.holderInstanceId,targetId:f.targetId,resources:f.resources,overdue,releaseAt:{...f.remaining,value:f.remaining.value===null?null:f.remaining.sampledAt+f.remaining.value}});}
  for(const q of p.queued??[]){const s=selected(q.attemptId,q.targetId),duration=s?s.executionMs-(s.policyQueueMs??0):null,value=typeof duration==='number'&&Number.isFinite(duration)&&duration>=0?duration:null;queued.push({deviceId:p.deviceId,holderInstanceId:p.holderInstanceId,targetId:q.targetId,resources:q.resources,priority:q.priority,attemptId:q.attemptId,elapsedMs:q.elapsed.value??0,holdEstimate:{value,source:value===null?'UNKNOWN':'PRIOR',sampledAt:q.elapsed.sampledAt,ttlMs:q.elapsed.ttlMs,unit:'ms'}});}
  for(const pool of p.pools){
   if(!usable(pool.admissionLimit)||!usable(pool.occupied)||pool.draining)continue;
   const free=Math.max(0,pool.admissionLimit.value-(projects?0:pool.occupied.value)),existing=resources.find(r=>r.deviceId===p.deviceId&&r.resourcePoolId===pool.resourcePoolId);
   if(existing)existing.available+=free;else resources.push({deviceId:p.deviceId,resourcePoolId:pool.resourcePoolId,available:free,availableMemoryBytes:null,availableSlots:null,observedAt:now,ttlMs:1000});
  }
  for(const e of p.executors){
   const q=evidence.find((v:any)=>v.admission.targetId===e.target.targetId&&v.admission.holderInstanceId===p.holderInstanceId);
   if(!q||q.admission.state!=='ACTIVE'||!usable(q.admission.quality))continue;
   const shares=e.resources.map((r:any)=>{const pool=p.pools.find((v:any)=>v.resourcePoolId===r.resourcePoolId);return {resourcePoolId:r.resourcePoolId,amount:pool&&usable(pool.admissionLimit)&&usable(pool.occupied)&&!pool.draining?Math.max(0,pool.admissionLimit.value-(projects?0:pool.occupied.value)):0}});
   if(e.resources.some((r:any)=>shares.find((v:any)=>v.resourcePoolId===r.resourcePoolId).amount<r.amount))continue;
   const ram=e.resources.filter((r:any)=>p.pools.some((v:any)=>v.resourcePoolId===r.resourcePoolId&&v.kind==='RAM_BYTES')).reduce((sum:number,r:any)=>sum+r.amount,0);
   const compute=usable(e.compute)?e.compute.value:q.computeMs;
   // Explicit empty execution and waiting lists establish zero local queue delay.
   const idle=p.inFlight!==undefined&&p.queued?.length===0;
   const projected=idle&&!usable(e.queue)?{...e,queue:{value:0,source:'MEASURED',sampledAt:now,ttlMs:1000,unit:'ms'}}:e;
   const forecast=availability(p,projected,priority,version,now),slots=Math.min(...e.resources.filter((r:any)=>r.amount>0).map((r:any)=>Math.floor(shares.find((v:any)=>v.resourcePoolId===r.resourcePoolId).amount/r.amount)));
   candidates.push({...(projects?{projectedSlots:slots,categoryCapacity:[{priority,slots:p.credits.find((v:any)=>v.priority===priority)?.slots??0,availability:forecast}]}:{}),holderInstanceId:p.holderInstanceId,targetId:e.target.targetId,deviceId:p.deviceId,executorId:e.target.executorId,capability:e.contract.capability,
    resourcePoolIds:e.target.resourcePoolIds,resourceDemand:e.resources,holderCapacity:shares,modelManifest:e.model,requiredMemoryBytes:ram,
    trusted:true,source:'REAL',observedAt:now,ttlMs:1000,availableSlots:p.credits.find((v:any)=>v.priority===priority)?.slots??0,
    availableMemoryBytes:shares.filter((r:any)=>p.pools.some((v:any)=>v.resourcePoolId===r.resourcePoolId&&v.kind==='RAM_BYTES')).reduce((sum:number,r:any)=>sum+r.amount,0),
    queueObserved:p.queued!==undefined,computeSamples:nativeComputeSamples(input.history??[],p,e,q,now),costEvidence:{compute:usable(e.compute)?e.compute:{value:q.computeMs,source:q.computeMs===null?'UNKNOWN':'PRIOR',sampledAt:now,ttlMs:1000,unit:'ms'},cold:e.cold,publish:e.publish},configId:e.configurations[0]?.id,startup:e.startup,quality:q.admission.quality.value,computeMs:compute,queueMs:usable(projected.queue)?projected.queue.value:null,coldMs:usable(e.cold)?e.cold.value:null,publishMs:usable(e.publish)?e.publish.value:null,uncertaintyMs:compute===null?null:compute*.5,
    availability:forecast,...(e.contract.serviceId?{serviceId:e.contract.serviceId}:{})});
  }
  for(const l of p.links){if(l.via!==null||!usable(l.fixedMs)||!usable(l.bytesPerSecond)||l.bytesPerSecond.value<=0)continue;
   if(!links.some(v=>v.from===l.from&&v.to===l.to))links.push({from:l.from,to:l.to,bytesPerSecond:l.bytesPerSecond.value,fixedMs:l.fixedMs.value,effective:false,source:'REAL',observedAt:now,ttlMs:1000});}
 }
 const contract=input.contract,node=input.node;
 const request:any={priority,nodes:[{id:node.id,workKey:workKeyV2(contract,node.parameters,node.input.bytes),capability:node.capability,dependencies:[],inputs:[input.artifactId],output:{id:'out-'+input.id,bytes:photoOutputBound(node.capability,node.parameters,Math.min(8388608,node.input.bytes*64+4096))},baselineTargetId:node.targetId??'',...(node.targetId?{allowedTargetIds:[node.targetId]}:{}),...(node.executionScope==='ORIGIN_DEVICE'||node.privacy==='LOCAL_ONLY'?{dataScope:'LOCAL_ONLY'}:{}),memoryBytes:0,minimumQuality:1,candidates:[]}],
 artifacts:[{id:input.artifactId,bytes:node.input.bytes,replicas:[input.originLocal?{deviceId:input.originDeviceId,holderInstanceId:input.originHolderId,readMs:0}:{deviceId:input.coordinatorId,readMs:0}]}],links:[],deviceResources:[],remainingBudgetMs:input.budgetMs,networkAllowed:true,privacy:node.privacy==='LOCAL_ONLY'?'LOCAL_ONLY':'AUTHORIZED_REMOTE',localDeviceId:input.originDeviceId,originHolderId:input.originHolderId,appInstanceId:input.appInstanceId,domain:'REAL',now,committedNodeIds:[],committedArtifacts:[],materializeOutputsAt:input.coordinatorId,finalDestination:input.coordinatorId};
 const snapshot:any={version,policyVersion:'native-photo-perf-v3',groupId:input.groupId,domain:'REAL',capturedAt:now,devices:profiles.map((p:any)=>({deviceId:p.deviceId,holderInstanceId:p.holderInstanceId,deviceInstanceId:p.deviceInstanceId,ledgerEpoch:p.ledgerEpoch,sampledAt:p.ownerActivity.sampledAt,ttlMs:p.ownerActivity.ttlMs})),resources,candidates,links,inFlight,queued};
 const policy={version:snapshot.policyVersion,revoked:false,allowedTargetIds:candidates.map(c=>c.targetId),limits:{maxCandidates:64,lookahead:8,beamWidth:16,planningBudgetMs:50,switchCostMs:0,hysteresisMs:0}};
 return JSON.stringify(plan(snapshot,request,policy,{now,monotonic}));
}

/** Only committed, matching-executor observations may replace calibration priors. */
export function nativeComputeSamples(rows:any[],profile:any,executor:any,qualification:any,now:number):any[]{
 const groups=new Map<string,any[]>(),seen=new Set<string>();
 for(const row of rows){
  const j=JSON.parse(row.job),s=JSON.parse(row.span),offer=j.offer;
  if(j.state!=='SUCCEEDED'||j.owner.groupId!==qualification.admission.groupId||j.holder!==profile.holderInstanceId||!j.executionIdentity||j.executionIdentity!==qualification.admission.identity||j.startup!==executor.startup||offer?.target.targetId!==executor.target.targetId||canonical(offer.target)!==canonical(executor.target)||offer.allowedConfigs.length!==1||offer.allowedConfigs[0].id!==executor.configurations[0]?.id||canonical(offer.task.contract)!==canonical(executor.contract))continue;
  const at=j.settledAt??s.snapshotVersion;
  if(s.phase!=='EXECUTE'||s.measurementScope!=='LOCAL_INTERVAL'||s.authoritativeSide!=='SELF'||s.attemptId!==offer.task.attemptId||s.traceId!==j.traceId||s.targetId!==executor.target.targetId||s.snapshotVersion!==JSON.parse(j.decision).snapshotVersion||!(s.durationMs>0)||!Number.isFinite(s.durationMs)||at>now||now-at>600000||seen.has(s.attemptId))continue;
  seen.add(s.attemptId);const key=workKeyV2(offer.task.contract,offer.task.parameters,j.input.bytes),group=groups.get(key)??[];group.push({ms:s.durationMs,at});groups.set(key,group);
 }
 const quantile=(values:any[],q:number)=>{const weighted=values.map((s,i)=>({...s,w:Math.pow(.65,values.length-1-i)})),threshold=weighted.reduce((n,s)=>n+s.w,0)*q;let total=0;for(const s of weighted.sort((a,b)=>a.ms-b.ms)){total+=s.w;if(total>=threshold)return s.ms;}return weighted[weighted.length-1].ms;};
 return [...groups].map(([workKey,g])=>{const recent=g.sort((a,b)=>a.at-b.at).slice(-8);return {workKey,configId:executor.configurations[0].id,startup:executor.startup,count:recent.length,p50Ms:quantile(recent,.5),p90Ms:quantile(recent,.9),coldP50Ms:0,executionTotal:true,observedAt:recent[0].at,ttlMs:600000};});
}

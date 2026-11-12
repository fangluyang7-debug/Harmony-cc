// Native coordinator projection into the same planner used by the Windows service.
import {plan} from './planning-api';
import {availability} from './availability';
import {sampleUsableV2} from './resources-v2';
import {workKeyV2} from './capability-cost-model';
export function nativePlanJson(profilesJson:string,evidenceJson:string,requestJson:string,now:number,monotonic:()=>number):string {
 const profiles=JSON.parse(profilesJson),evidence=JSON.parse(evidenceJson),input=JSON.parse(requestJson);
 const version=now,priority=input.priority??'REMOTE_INTERACTIVE',candidates:any[]=[],resources:any[]=[],links:any[]=[];
 const usable=(s:any)=>sampleUsableV2(s,now,'REAL');
 for(const p of profiles){
  if(!usable(p.ownerActivity)||p.ownerActivity.value!=='IDLE'||!usable(p.foreground)||p.foreground.value!=='FOREGROUND'||!usable(p.powerSave)||p.powerSave.value==='ON'||p.energyGate&&p.energyGate!=='NONE')continue;
  for(const pool of p.pools){
   if(!usable(pool.admissionLimit)||!usable(pool.occupied)||pool.draining)continue;
   const free=Math.max(0,pool.admissionLimit.value-pool.occupied.value),existing=resources.find(r=>r.deviceId===p.deviceId&&r.resourcePoolId===pool.resourcePoolId);
   if(existing)existing.available+=free;else resources.push({deviceId:p.deviceId,resourcePoolId:pool.resourcePoolId,available:free,availableMemoryBytes:null,availableSlots:null,observedAt:now,ttlMs:1000});
  }
  for(const e of p.executors){
   const q=evidence.find((v:any)=>v.admission.targetId===e.target.targetId&&v.admission.holderInstanceId===p.holderInstanceId);
   if(!q||q.admission.state!=='ACTIVE'||!usable(q.admission.quality))continue;
   const shares=e.resources.map((r:any)=>{const pool=p.pools.find((v:any)=>v.resourcePoolId===r.resourcePoolId);return {resourcePoolId:r.resourcePoolId,amount:pool&&usable(pool.admissionLimit)&&usable(pool.occupied)&&!pool.draining?Math.max(0,pool.admissionLimit.value-pool.occupied.value):0}});
   if(e.resources.some((r:any)=>shares.find((v:any)=>v.resourcePoolId===r.resourcePoolId).amount<r.amount))continue;
   const ram=e.resources.filter((r:any)=>p.pools.some((v:any)=>v.resourcePoolId===r.resourcePoolId&&v.kind==='RAM_BYTES')).reduce((sum:number,r:any)=>sum+r.amount,0);
   const compute=usable(e.compute)?e.compute.value:q.computeMs;
   // Explicit empty execution and waiting lists establish zero local queue delay.
   const idle=p.inFlight?.length===0&&p.queued?.length===0;
   const projected=idle&&!usable(e.queue)?{...e,queue:{value:0,source:'MEASURED',sampledAt:now,ttlMs:1000,unit:'ms'}}:e;
   candidates.push({holderInstanceId:p.holderInstanceId,targetId:e.target.targetId,deviceId:p.deviceId,executorId:e.target.executorId,capability:e.contract.capability,
    resourcePoolIds:e.target.resourcePoolIds,resourceDemand:e.resources,holderCapacity:shares,modelManifest:e.model,requiredMemoryBytes:ram,
    trusted:true,source:'REAL',observedAt:now,ttlMs:1000,availableSlots:p.credits.find((v:any)=>v.priority===priority)?.slots??0,
    availableMemoryBytes:shares.filter((r:any)=>p.pools.some((v:any)=>v.resourcePoolId===r.resourcePoolId&&v.kind==='RAM_BYTES')).reduce((sum:number,r:any)=>sum+r.amount,0),
    quality:q.admission.quality.value,computeMs:compute,queueMs:usable(projected.queue)?projected.queue.value:null,coldMs:usable(e.cold)?e.cold.value:null,publishMs:usable(e.publish)?e.publish.value:null,uncertaintyMs:compute===null?null:compute*.5,
    availability:availability(p,projected,priority,version,now),...(e.contract.serviceId?{serviceId:e.contract.serviceId}:{})});
  }
  for(const l of p.links){if(l.via!==null||!usable(l.fixedMs)||!usable(l.bytesPerSecond)||l.bytesPerSecond.value<=0)continue;
   if(!links.some(v=>v.from===l.from&&v.to===l.to))links.push({from:l.from,to:l.to,bytesPerSecond:l.bytesPerSecond.value,fixedMs:l.fixedMs.value,effective:false,source:'REAL',observedAt:now,ttlMs:1000});}
 }
 const contract=input.contract,node=input.node;
 const request:any={priority,nodes:[{id:node.id,workKey:workKeyV2(contract,node.parameters,node.input.bytes),capability:node.capability,dependencies:[],inputs:[input.artifactId],output:{id:'out-'+input.id,bytes:Math.min(8388608,node.input.bytes*64+4096)},baselineTargetId:node.targetId??'',...(node.targetId?{allowedTargetIds:[node.targetId]}:{}),...(node.executionScope==='ORIGIN_DEVICE'||node.privacy==='LOCAL_ONLY'?{dataScope:'LOCAL_ONLY'}:{}),memoryBytes:0,minimumQuality:1,candidates:[]}],
 artifacts:[{id:input.artifactId,bytes:node.input.bytes,replicas:[{deviceId:input.coordinatorId,readMs:0}]}],links:[],deviceResources:[],remainingBudgetMs:input.budgetMs,networkAllowed:true,privacy:node.privacy==='LOCAL_ONLY'?'LOCAL_ONLY':'AUTHORIZED_REMOTE',localDeviceId:input.originDeviceId,originHolderId:input.originHolderId,appInstanceId:input.appInstanceId,domain:'REAL',now,committedNodeIds:[],committedArtifacts:[],materializeOutputsAt:input.coordinatorId,finalDestination:input.coordinatorId};
 const snapshot:any={version,policyVersion:'native-main-v1',groupId:input.groupId,domain:'REAL',capturedAt:now,devices:profiles.map((p:any)=>({deviceId:p.deviceId,holderInstanceId:p.holderInstanceId,deviceInstanceId:p.deviceInstanceId,ledgerEpoch:p.ledgerEpoch,sampledAt:p.ownerActivity.sampledAt,ttlMs:p.ownerActivity.ttlMs})),resources,candidates,links};
 const policy={version:snapshot.policyVersion,revoked:false,allowedTargetIds:candidates.map(c=>c.targetId),limits:{maxCandidates:64,lookahead:8,beamWidth:16,planningBudgetMs:50,switchCostMs:0,hysteresisMs:0}};
 return JSON.stringify(plan(snapshot,request,policy,{now,monotonic}));
}

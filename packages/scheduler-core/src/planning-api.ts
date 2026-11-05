import { poolOccupancyKey,earliestFeasibleV2,Occupancy,PoolDemand,DeviceResources, PlacementCandidate, PlacementLink, PlacementRequest, PlannerLimits, WorkflowPlacementPlanner, WorkflowPlacementDecision } from './planner';

export interface DeviceEpoch { deviceId:string; holderInstanceId?:string; deviceInstanceId:string; ledgerEpoch:number; sampledAt:number; ttlMs:number; }
export interface ExcludedTarget {
  deviceId:string;targetId:string;executorId:string;capability:string;appInstanceId?:string;code:string;
}
export interface FlightReservation {deviceId:string;holderInstanceId:string;targetId:string;resources:ResourceAmountV2[];releaseAt:NumericSampleV2;overdue:boolean;}
export interface QueueReservation {deviceId:string;holderInstanceId:string;targetId:string;priority:string;attemptId:string;resources:ResourceAmountV2[];holdEstimate:NumericSampleV2;elapsedMs:number;}
export interface PlanningSnapshot {
  inFlight?:FlightReservation[];queued?:QueueReservation[];
  excludedTargets?:ExcludedTarget[];
  version:number; policyVersion:string; groupId:string; domain:'REAL'|'SIMULATED'; capturedAt:number;
  devices:DeviceEpoch[]; resources:DeviceResources[]; candidates:PlacementCandidate[]; links:PlacementLink[];
}
export interface CostEstimatePolicy {sampleTtlMs:number;minSamples:number;windowSamples:number;}
export function costEstimatePolicy(settings?:Partial<CostEstimatePolicy>):CostEstimatePolicy{
  const policy={sampleTtlMs:600000,minSamples:3,windowSamples:32,...settings};
  if(![policy.sampleTtlMs,policy.minSamples,policy.windowSamples].every(v=>Number.isSafeInteger(v)&&v>0)||policy.minSamples>policy.windowSamples||policy.windowSamples>32)throw Error("COST_POLICY_INVALID");
  return policy;
}
export interface PlanningPolicy { costEstimate?:Partial<CostEstimatePolicy>; priorUncertaintyRatio?:number; version:string; revoked:boolean; allowedTargetIds:string[]; limits:PlannerLimits; }
export interface PlanningClock { now:number; monotonic:()=>number; }
export interface SnapshotDecision { groupId:string; domain:'REAL'|'SIMULATED'; snapshotVersion:number; policyVersion:string; decision:WorkflowPlacementDecision; }

import {NumericSampleV2,ResourceAmountV2,sampleUsableV2} from './resources-v2';
import type {PlacementNode} from './planner';

function resolveCost(c:PlacementCandidate,node:PlacementNode,policy:PlanningPolicy,minSamples:number,now:number,domain:string):PlacementCandidate {
  if(!c.costEvidence)return c;
  const e=c.costEvidence;
  const usable=(s:typeof e.compute)=>sampleUsableV2(s,now,domain)?s.value:null;
  const measured=c.computeSamples?.find(s=>s.count>=minSamples&&s.workKey===node.workKey&&s.configId===c.configId&&s.startup===c.startup&&s.observedAt<=now&&now-s.observedAt<=s.ttlMs);
  const compute=measured?.p50Ms??usable(e.compute);
  return {...c,computeMs:compute,coldMs:measured?.coldP50Ms??usable(e.cold),publishMs:usable(e.publish),queueMs:c.availability?(c.queueObserved===false?usable(c.availability.policyWait):0):c.queueMs,
    uncertaintyMs:measured?measured.p90Ms-measured.p50Ms:compute===null?null:Math.round(compute*(policy.priorUncertaintyRatio??0.5)),
    costSource:measured?'MEASURED':compute===null?'UNKNOWN':'PRIOR',costConfidence:measured?(measured.count<8?'LOW':'NORMAL'):undefined};
}

function seedReservations(snapshot:PlanningSnapshot,priority:string|undefined,now:number):Pick<PlacementRequest,'initialOccupancy'|'queuedOccupancy'>{
  if(!snapshot.inFlight&&!snapshot.queued)return {};
  const initialOccupancy:Occupancy[]=[],queuedOccupancy:Occupancy[]=[];

  function demands(item:FlightReservation|QueueReservation):PoolDemand[]{
    const candidate=snapshot.candidates.find(c=>c.targetId===item.targetId&&c.deviceId===item.deviceId&&c.holderInstanceId===item.holderInstanceId);
    const result=[{key:'target:'+item.targetId,amount:1,capacity:candidate?.projectedSlots??candidate?.availableSlots??1}];
    for(const resource of item.resources){
      const pool=snapshot.resources.find(p=>p.deviceId===item.deviceId&&p.resourcePoolId===resource.resourcePoolId);
      const share=candidate?.holderCapacity?.find(p=>p.resourcePoolId===resource.resourcePoolId);
      result.push({key:poolOccupancyKey(item.deviceId,resource.resourcePoolId),amount:resource.amount,capacity:pool?.available??0},
        {key:poolOccupancyKey(item.deviceId,resource.resourcePoolId,item.holderInstanceId),amount:resource.amount,capacity:share?.amount??resource.amount});
    }
    return result;
  }
  for(const flight of snapshot.inFlight??[]){
    const sample=flight.releaseAt;
    const end=!flight.overdue&&sampleUsableV2(sample,now,snapshot.domain)&&sample.value!>now?sample.value!-now:Infinity;
    for(const demand of demands(flight))initialOccupancy.push({key:demand.key,amount:demand.amount,start:0,end});
  }
  const ranks=['ORIGIN_INTERACTIVE','REMOTE_INTERACTIVE','REMOTE_BATCH'],rank=ranks.indexOf(priority??'REMOTE_INTERACTIVE');
  const queue=(snapshot.queued??[]).filter(item=>ranks.indexOf(item.priority)<=rank)
    .sort((a,b)=>ranks.indexOf(a.priority)-ranks.indexOf(b.priority)||b.elapsedMs-a.elapsedMs||a.attemptId.localeCompare(b.attemptId));
  for(const item of queue){
    const demand=demands(item),known=sampleUsableV2(item.holdEstimate,now,snapshot.domain);
    const duration=known?item.holdEstimate.value!:Infinity;
    const earliest=known?earliestFeasibleV2([...initialOccupancy,...queuedOccupancy],demand,0,duration):0;
    // An unplaceable earlier task conservatively blocks only the pools it needs.
    const start=Number.isFinite(earliest)?earliest:0,end=Number.isFinite(earliest)?earliest+duration:Infinity;
    for(const resource of demand)queuedOccupancy.push({key:resource.key,amount:resource.amount,start,end});
  }
  return {initialOccupancy,queuedOccupancy};
}

/** Snapshot construction performs I/O outside this API. All candidates come from that snapshot. */
export function plan(snapshot:PlanningSnapshot,request:PlacementRequest,policy:PlanningPolicy,clock:PlanningClock):SnapshotDecision {
  if(!Number.isSafeInteger(snapshot.version)||snapshot.version<1||snapshot.policyVersion!==policy.version||policy.revoked||
    !Number.isFinite(clock.now)||!Number.isFinite(snapshot.capturedAt)||snapshot.capturedAt>clock.now||snapshot.devices.length>1024||snapshot.candidates.length>4096||snapshot.resources.length>4096||snapshot.links.length>4096)throw new Error('SNAPSHOT_OR_POLICY_INVALID');
  if(policy.priorUncertaintyRatio!==undefined&&(!Number.isFinite(policy.priorUncertaintyRatio)||policy.priorUncertaintyRatio<=0||policy.priorUncertaintyRatio>2))throw Error('SNAPSHOT_OR_POLICY_INVALID');
  const deviceIds=new Set<string>();
  const validDevices=new Set(snapshot.devices.filter(d=>{
    const key=d.deviceId+':'+(d.holderInstanceId??'');
    if(deviceIds.has(key))throw new Error('DEVICE_IDENTITY_AMBIGUOUS');deviceIds.add(key);
    return !!d.deviceId&&!!d.deviceInstanceId&&Number.isSafeInteger(d.ledgerEpoch)&&d.ledgerEpoch>0&&Number.isFinite(d.sampledAt)&&d.sampledAt<=clock.now&&Number.isFinite(d.ttlMs)&&d.ttlMs>0&&clock.now-d.sampledAt<=d.ttlMs;
  }).map(d=>d.deviceId+':'+(d.holderInstanceId??'')));
  const candidates=snapshot.candidates.filter(c=>(c.appInstanceId===undefined||c.appInstanceId===request.appInstanceId)&&validDevices.has(c.deviceId+':'+(c.holderInstanceId??''))&&policy.allowedTargetIds.includes(c.targetId)).map(c=>{
    const priority=request.priority??'REMOTE_INTERACTIVE';
    const capacity=c.categoryCapacity?.find(v=>v.priority===priority);
    if(capacity)return {...c,availability:capacity.availability,availableSlots:capacity.slots||((capacity.availability.reason==="RESOURCE_CAPACITY"||capacity.availability.reason==="LOCAL_QUEUE_PENDING")?c.projectedSlots??0:0)};
    // Snapshots from before category-aware planning have only the interactive allowance.
    return request.priority==='REMOTE_BATCH'?{...c,availableSlots:0}:c;
  });
  const estimatePolicy=costEstimatePolicy(policy.costEstimate);
  const reservations=seedReservations(snapshot,request.priority,clock.now);
  const effective:PlacementRequest={...request,...reservations,snapshotVersion:snapshot.version,now:clock.now,domain:snapshot.domain,deviceResources:snapshot.resources,links:snapshot.links,
    nodes:request.nodes.map(node=>({...node,candidates:candidates.filter(c=>c.capability===node.capability&&(!node.allowedTargetIds||node.allowedTargetIds.includes(c.targetId))).map(c=>resolveCost(c,node,policy,estimatePolicy.minSamples,clock.now,snapshot.domain))}))};
  const decision=new WorkflowPlacementPlanner(policy.limits,clock.monotonic).plan(effective);
  for(const target of snapshot.excludedTargets??[]){
    if(!policy.allowedTargetIds.includes(target.targetId)||target.appInstanceId!==undefined&&target.appInstanceId!==request.appInstanceId)continue;
    for(const node of effective.nodes){
      if(node.capability===target.capability&&!request.committedNodeIds.includes(node.id)&&(!node.allowedTargetIds||node.allowedTargetIds.includes(target.targetId)))
        decision.rejections.push({nodeId:node.id,targetId:target.targetId,deviceId:target.deviceId,executorId:target.executorId,code:target.code});
    }
  }
  return {groupId:snapshot.groupId,domain:snapshot.domain,snapshotVersion:snapshot.version,policyVersion:policy.version,decision};
}

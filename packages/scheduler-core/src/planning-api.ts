import { DeviceResources, PlacementCandidate, PlacementLink, PlacementRequest, PlannerLimits, WorkflowPlacementPlanner, WorkflowPlacementDecision } from './planner';

export interface DeviceEpoch { deviceId:string; holderInstanceId?:string; deviceInstanceId:string; ledgerEpoch:number; sampledAt:number; ttlMs:number; }
export interface PlanningSnapshot {
  version:number; policyVersion:string; groupId:string; domain:'REAL'|'SIMULATED'; capturedAt:number;
  devices:DeviceEpoch[]; resources:DeviceResources[]; candidates:PlacementCandidate[]; links:PlacementLink[];
}
export interface PlanningPolicy { version:string; revoked:boolean; allowedTargetIds:string[]; limits:PlannerLimits; }
export interface PlanningClock { now:number; monotonic:()=>number; }
export interface SnapshotDecision { groupId:string; domain:'REAL'|'SIMULATED'; snapshotVersion:number; policyVersion:string; decision:WorkflowPlacementDecision; }

/** Snapshot construction performs I/O outside this API. All candidates come from that snapshot. */
export function plan(snapshot:PlanningSnapshot,request:PlacementRequest,policy:PlanningPolicy,clock:PlanningClock):SnapshotDecision {
  if(!Number.isSafeInteger(snapshot.version)||snapshot.version<1||snapshot.policyVersion!==policy.version||policy.revoked||
    !Number.isFinite(clock.now)||!Number.isFinite(snapshot.capturedAt)||snapshot.capturedAt>clock.now||snapshot.devices.length>1024||snapshot.candidates.length>4096||snapshot.resources.length>4096||snapshot.links.length>4096)throw new Error('SNAPSHOT_OR_POLICY_INVALID');
  const deviceIds=new Set<string>();
  const validDevices=new Set(snapshot.devices.filter(d=>{
    const key=d.deviceId+':'+(d.holderInstanceId??'');
    if(deviceIds.has(key))throw new Error('DEVICE_IDENTITY_AMBIGUOUS');deviceIds.add(key);
    return !!d.deviceId&&!!d.deviceInstanceId&&Number.isSafeInteger(d.ledgerEpoch)&&d.ledgerEpoch>0&&Number.isFinite(d.sampledAt)&&d.sampledAt<=clock.now&&Number.isFinite(d.ttlMs)&&d.ttlMs>0&&clock.now-d.sampledAt<=d.ttlMs;
  }).map(d=>d.deviceId+':'+(d.holderInstanceId??'')));
  const candidates=snapshot.candidates.filter(c=>validDevices.has(c.deviceId+':'+(c.holderInstanceId??''))&&policy.allowedTargetIds.includes(c.targetId));
  const effective:PlacementRequest={...request,now:clock.now,domain:snapshot.domain,deviceResources:snapshot.resources,links:snapshot.links,
    nodes:request.nodes.map(node=>({...node,candidates:candidates.filter(c=>c.capability===node.capability)}))};
  return {groupId:snapshot.groupId,domain:snapshot.domain,snapshotVersion:snapshot.version,policyVersion:policy.version,decision:new WorkflowPlacementPlanner(policy.limits,clock.monotonic).plan(effective)};
}

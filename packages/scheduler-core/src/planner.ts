import { ModelCompatibility, compatibleModel } from './protocol-v1';
import { NumericSampleV2, ModelManifestV2, ResourceAmountV2, sameModelV2 } from './resources-v2';

import type {AvailabilityEstimate} from './availability';
import {sampleUsableV2} from './resources-v2';

// Metrics are comparable only within the same versioned evaluation context.
export interface QualityEvidence {
  metric: string; evaluationId: string; direction: 'higher' | 'lower'; value: number;
}
export interface PlacementReplica { deviceId: string; readMs: number | null; holderInstanceId?:string; localOnly?:boolean; transferOperation?:'READ'|'WRITE'; endpointId?:string;endpointEpoch?:string; }
export interface PlacementArtifact { id: string; bytes: number; replicas: PlacementReplica[]; }
export interface PlacementLink { from: string; to: string; bytesPerSecond: number; fixedMs: number; effective: boolean; observedAt: number; ttlMs: number; source: 'REAL' | 'SIMULATED'; endpointId?:string; endpointEpoch?:string; endpointOperation?:'READ'|'WRITE'; fromHolderInstanceId?:string; toHolderInstanceId?:string; }
export interface ComputeSample { workKey:string;configId:string;startup:string;count:number;p50Ms:number;p90Ms:number;coldP50Ms:number;observedAt:number;ttlMs:number; }
export interface PlacementCandidate {
  costEvidence?:{compute:NumericSampleV2;cold:NumericSampleV2;publish:NumericSampleV2};
  queueObserved?:boolean;projectedSlots?:number;holderCapacity?:ResourceAmountV2[];
  configId?:string;startup?:string;computeSamples?:ComputeSample[];costSource?:string;costConfidence?:string;
  /** Authenticated endpoint projection; never accepted from a self-reported executor. */
  categoryCapacity?:{priority:string;slots:number;availability:AvailabilityEstimate}[];
  availability?:AvailabilityEstimate;
  dataEndpoint?:{id:string;epoch:string};
  serviceId?:string;
  holderInstanceId?:string;
  /** Bound by the authenticated directory, never by an executor profile. */
  appInstanceId?:string;
  resourceDemand?:ResourceAmountV2[];
  modelManifest?:ModelManifestV2|null;
  requiredMemoryBytes?: number;
  qualityEvidence?: QualityEvidence[];
  targetId: string; resourcePoolIds: string[]; deviceId: string; executorId: string; capability: string; trusted: boolean; source: 'REAL' | 'SIMULATED';
  observedAt: number; ttlMs: number; availableSlots: number; availableMemoryBytes: number;
  quality: number | null; computeMs: number | null; queueMs: number | null; coldMs: number | null;
  uncertaintyMs: number|null; publishMs: number|null; model?: ModelCompatibility;
}
export interface PlacementNode {
  workKey?:string;
  serviceId?:string;
  allowedTargetIds?: string[];
  modelManifest?:ModelManifestV2|null;
  qualityRequirements?: QualityEvidence[];
  maxMemoryBytes?: number;
  id: string; capability: string; dependencies: string[]; inputs: string[]; output: { id: string; bytes: number; retainAtExecutor?:boolean };
  baselineTargetId: string; memoryBytes: number; minimumQuality: number; model?: ModelCompatibility;
  candidates: PlacementCandidate[];
}
export interface PlacementRequest {
  initialOccupancy?:Occupancy[];queuedOccupancy?:Occupancy[];
  recoveryFromDeviceId?:string;
  priority?:'REMOTE_INTERACTIVE'|'REMOTE_BATCH';
  snapshotVersion?:number;
  excludedInputEndpoints?:string[];
  relayCapacity?:{deviceId:string;availableSlots:number;availableBytes?:number;observedAt:number;ttlMs:number};
  originHolderId?:string;
  localResultHolderId?:string;
  inputRelayId?:string;
  appInstanceId?:string;
  nodes: PlacementNode[]; artifacts: PlacementArtifact[]; links: PlacementLink[]; remainingBudgetMs: number;
  networkAllowed: boolean; privacy: 'LOCAL_ONLY' | 'AUTHORIZED_REMOTE'; localDeviceId: string;
  domain: 'REAL' | 'SIMULATED';
  deviceResources: DeviceResources[];
  now: number; committedNodeIds: string[]; committedArtifacts: PlacementArtifact[];
  finalDestination?: string;
  // Some dispatchers materialize every output through a coordinator instead of peer transfers.
  materializeOutputsAt?: string;
}
export interface PlannerLimits { maxCandidates: number; lookahead: number; beamWidth: number; planningBudgetMs: number; switchCostMs: number; hysteresisMs: number; }
export interface DeviceResources { capacity?:number|null; deviceId: string; resourcePoolId: string; availableMemoryBytes: number | null; availableSlots: number | null; available?:number|null; observedAt: number; ttlMs: number; }
export interface PlannerAssignment { costSource?:string;costConfidence?:string; phaseCosts?:{EXECUTE:number;QUEUE:number;PUBLISH:number}; inputSourceHolderId?:string;inputSourceEndpointId?:string;inputSourceEndpointEpoch?:string; inputRelayId?:string;inputUploadMs?:number;inputDownloadMs?:number; outputEndpointId?:string; outputEndpointEpoch?:string; inputEndpointOperation?:'READ'|'WRITE'; inputEndpointId?:string; inputEndpointEpoch?:string; policyQueueMs?:number; dagResourceWaitMs?:number; startMs?:number; finishMs?:number; targetId: string; nodeId: string; deviceId: string; executorId: string; inputTransferMs: number; executionMs: number; uncertaintyMs: number; }
export interface PlannerRejection { retryAfterMs?:number; targetId: string; nodeId: string; deviceId: string; executorId: string; code: string; }
export interface WorkflowPlacementDecision { status: 'ready' | 'blocked'; baseline: PlannerAssignment[] | null; suggestion: PlannerAssignment[] | null;
  baselineMs: number | null; suggestionMs: number | null; rejections: PlannerRejection[]; truncated: number; planningMs: number; reason: string; }
export function poolOccupancyKey(deviceId:string,poolId:string,holderId?:string):string {
  return JSON.stringify([deviceId,poolId,holderId??null]);
}
export interface Occupancy {key:string;start:number;end:number;amount:number;}
export interface PoolDemand {key:string;amount:number;capacity:number;}
interface Beam { assignments: PlannerAssignment[]; artifacts: Map<string, PlacementArtifact>; ready:Map<string,number>; completed:Map<string,number>; occupancy:Occupancy[]; cost: number; }

  /** Earliest feasible interval in this beam; no execution or reservation side effects. */
export function earliestFeasibleV2(occupancy:Occupancy[],demands:PoolDemand[],earliest:number,duration:number):number {
    let start=earliest;
    for(let i=0;i<=occupancy.length;i++){
      let move=start;
      for(const demand of demands){
        const overlaps=occupancy.filter(o=>o.key===demand.key&&o.end>start&&o.start<start+duration);
        for(const time of [start,...overlaps.map(o=>Math.max(start,o.start))]){
          const active=overlaps.filter(o=>o.start<=time&&o.end>time);
          if(active.reduce((sum,o)=>sum+o.amount,0)+demand.amount>demand.capacity)move=Math.max(move,Math.min(...active.map(o=>o.end)));
        }
      }
      if(move===start)return start;start=move;
    }
    return Infinity;
  }

export class WorkflowPlacementPlanner {
  constructor(private readonly limits: PlannerLimits, private readonly clock: () => number) {
    if (![limits.maxCandidates,limits.lookahead,limits.beamWidth].every(n=>Number.isSafeInteger(n)&&n>0&&n<=64) ||
      ![limits.planningBudgetMs,limits.switchCostMs,limits.hysteresisMs].every(n=>Number.isFinite(n)&&n>=0)) throw new Error('PLANNER_CONFIG_INVALID');
  }
  plan(request: PlacementRequest): WorkflowPlacementDecision {
    const started=this.clock(),rejections:PlannerRejection[]=[];let truncated=0;
    const result=(baseline:Beam|null,suggestion:Beam|null,reason:string):WorkflowPlacementDecision=>({status:suggestion?'ready':'blocked',
      baseline:baseline?.assignments??null,suggestion:suggestion?.assignments??null,baselineMs:baseline?.cost??null,suggestionMs:suggestion?.cost??null,
      rejections,truncated,planningMs:Math.max(0,this.clock()-started),reason});
    if(request.nodes.length>64||request.nodes.some(n=>n.candidates.length>64)||request.links.length>4096||request.artifacts.length+request.committedArtifacts.length>4096||!Number.isFinite(request.now))return result(null,null,'REQUEST_LIMIT_OR_CLOCK_INVALID');
    if(!Number.isFinite(request.remainingBudgetMs)||request.remainingBudgetMs<=0)return result(null,null,'BUDGET_EXHAUSTED');
    if(request.nodes.some(n=>new Set(n.candidates.map(c=>c.targetId)).size!==n.candidates.length))return result(null,null,'DUPLICATE_TARGET');
    const pending=request.nodes.filter(n=>!request.committedNodeIds.includes(n.id));
    const known=new Set(request.committedNodeIds);
    for(const node of pending){if(known.has(node.id)||node.dependencies.some(id=>!known.has(id)))return result(null,null,'DEPENDENCY_ORDER_INVALID');known.add(node.id);}
    const initial:Beam={assignments:[],cost:0,ready:new Map(),completed:new Map(request.committedNodeIds.map(id=>[id,0])),occupancy:[...(request.initialOccupancy??[])],artifacts:new Map([...request.artifacts,...request.committedArtifacts].map(a=>[a.id,a]))};
    const legal=new Map<string,PlacementCandidate[]>();
    for(const node of pending){
      const candidates=node.candidates.filter(c=>{const code=this.reject(node,c,request);if(code){
          const sample=c.availability?.resourceWait;
          const delay=code==='RESOURCE_CAPACITY'&&sample?.value?sample.sampledAt+sample.value-request.now:0;
          rejections.push({targetId:c.targetId,nodeId:node.id,deviceId:c.deviceId,executorId:c.executorId,code,...(delay>0?{retryAfterMs:delay}:{})});
        }return !code;})
        .sort((a,b)=>(a.computeMs!+a.queueMs!+a.coldMs!+a.uncertaintyMs!)-(b.computeMs!+b.queueMs!+b.coldMs!+b.uncertaintyMs!)||a.targetId.localeCompare(b.targetId));
      const selected=candidates.slice(0,this.limits.maxCandidates);
      const baseline=candidates.find(c=>c.targetId===node.baselineTargetId);
      if(baseline&&!selected.includes(baseline))selected[selected.length-1]=baseline;
      truncated+=candidates.length-selected.length;legal.set(node.id,selected);
    }
    let baseline:Beam|null=initial;
    for(const node of pending){const c=legal.get(node.id)!.find(c=>c.targetId===node.baselineTargetId);baseline=baseline&&c?this.extend(baseline,node,c,request):null;}
    baseline=this.finish(baseline,pending,request);
    if(pending.length>this.limits.lookahead)return result(baseline,baseline,'LOOKAHEAD_LIMIT_BASELINE');
    let beam=[initial];
    for(const node of pending){
      if(this.clock()-started>=this.limits.planningBudgetMs)return result(baseline,baseline,'PLANNING_BUDGET_BASELINE');
      const next:Beam[]=[];
      for(const state of beam)for(const c of legal.get(node.id)!){
        const rejected:PlannerRejection={targetId:c.targetId,nodeId:node.id,deviceId:c.deviceId,executorId:c.executorId,code:'DATA_UNREACHABLE_OR_BUDGET'};
        const candidate=this.extend(state,node,c,request,rejected);
        if(candidate)next.push(candidate);else rejections.push(rejected);
      }
      beam=next.sort((a,b)=>a.cost-b.cost||JSON.stringify(a.assignments).localeCompare(JSON.stringify(b.assignments))).slice(0,this.limits.beamWidth);
      if(!beam.length)return result(baseline,baseline,baseline?'BASELINE_ONLY':'NO_LEGAL_PLAN');
    }
    const choices=beam.map(b=>this.finish(b,pending,request)).filter((b):b is Beam=>b!==null).sort((a,b)=>a.cost-b.cost);
    const best=choices[0]??baseline;
    if(baseline&&best&&baseline.cost-best.cost<=this.limits.switchCostMs+this.limits.hysteresisMs)return result(baseline,baseline,'INSUFFICIENT_SAVING');
    return result(baseline,best,best?'LEGAL_SUGGESTION':'NO_LEGAL_PLAN');
  }
  private reject(node:PlacementNode,c:PlacementCandidate,r:PlacementRequest):string|null {
    if(!c.trusted||!['REAL','SIMULATED'].includes(r.domain)||c.source!==r.domain)return 'UNTRUSTED_OR_WRONG_DOMAIN';
    if(r.recoveryFromDeviceId===c.deviceId)return 'RECOVERY_PRIMARY_DEVICE';
    if(c.capability!==node.capability)return 'CAPABILITY_UNSUPPORTED';
    if(node.serviceId!==c.serviceId||node.serviceId!==undefined&&(r.originHolderId===undefined||r.appInstanceId===undefined||c.holderInstanceId!==r.originHolderId||c.appInstanceId!==r.appInstanceId))return 'SERVICE_PLACEMENT_FORBIDDEN';
    if(node.model&&(!c.model||!compatibleModel(node.model,c.model)))return 'MODEL_INDEX_MISMATCH';
    if(node.modelManifest!==undefined&&!sameModelV2(node.modelManifest,c.modelManifest??null))return 'MODEL_MANIFEST_MISMATCH';
    if(!Number.isFinite(c.ttlMs)||!Number.isFinite(c.observedAt)||c.observedAt>r.now||r.now-c.observedAt>c.ttlMs||c.ttlMs<=0)return 'OBSERVATION_EXPIRED';
    if(c.deviceId!==r.localDeviceId&&(!r.networkAllowed||r.privacy==='LOCAL_ONLY'))return 'TRANSFER_FORBIDDEN';
    const requiredMemory = c.requiredMemoryBytes ?? node.memoryBytes;
    if(!Number.isSafeInteger(requiredMemory)||requiredMemory<0||
      (node.maxMemoryBytes!==undefined&&(!Number.isSafeInteger(node.maxMemoryBytes)||node.maxMemoryBytes<0||requiredMemory>node.maxMemoryBytes)))return 'EXECUTOR_MEMORY_LIMIT';
    if(c.costEvidence&&[c.computeMs,c.coldMs,c.uncertaintyMs,c.publishMs].some(n=>n===null||!Number.isFinite(n)||n<0))return 'COST_UNKNOWN';
    const a=c.availability;
    if(a){
      if(a.snapshotVersion!==r.snapshotVersion||a.targetId!==c.targetId||a.poolIds.length!==c.resourcePoolIds.length||
        !c.resourcePoolIds.every(id=>a.poolIds.includes(id)))return 'AVAILABILITY_SCOPE_MISMATCH';
      if(!sampleUsableV2(a.resourceWait,r.now,r.domain))return 'RESOURCE_WAIT_UNKNOWN';
      if(a.blockingReason&&c.projectedSlots)return 'RESOURCE_WAIT_UNKNOWN';
      if(!c.projectedSlots&&(a.reason==='RESOURCE_CAPACITY'||a.resourceWait.value!==0))return 'RESOURCE_CAPACITY';
      if(a.reason==='LOCAL_QUEUE_PENDING'&&!r.queuedOccupancy)return 'POLICY_WAIT_UNKNOWN';
      if(a.reason==='NO_CATEGORY_CREDIT'||(!r.initialOccupancy&&a.reason!=='AVAILABLE'))return 'NO_CATEGORY_CREDIT';
      if((!r.queuedOccupancy||c.queueObserved===false)&&(!sampleUsableV2(a.policyWait,r.now,r.domain)||a.policyWait.value!==c.queueMs))return 'POLICY_WAIT_UNKNOWN';
    }
    if(!Number.isFinite(node.memoryBytes)||node.memoryBytes<0||!Number.isFinite(c.availableSlots)||!Number.isFinite(c.availableMemoryBytes)||c.availableSlots<1||c.availableMemoryBytes<requiredMemory)return 'CAPACITY_UNAVAILABLE';
    if(!c.targetId || !c.resourcePoolIds.length || new Set(c.resourcePoolIds).size!==c.resourcePoolIds.length)return 'RESOURCE_POOLS_INVALID';
    for(const poolId of c.resourcePoolIds){
      const pools=r.deviceResources.filter(p=>p.deviceId===c.deviceId&&p.resourcePoolId===poolId);
      if(pools.length!==1)return 'SHARED_CAPACITY_UNKNOWN';
      const pool=pools[0];
      if(!Number.isFinite(pool.observedAt)||pool.observedAt>r.now||!Number.isFinite(pool.ttlMs)||pool.ttlMs<=0||r.now-pool.observedAt>pool.ttlMs)return 'SHARED_CAPACITY_EXPIRED';
      if(c.resourceDemand){
        const amount=c.resourceDemand.find(r=>r.resourcePoolId===poolId)?.amount;
        if(amount===undefined||!Number.isSafeInteger(amount)||amount<0||pool.available===null||pool.available===undefined||!Number.isFinite(pool.available)||pool.available<amount)return 'SHARED_CAPACITY_UNAVAILABLE';
      }else if(pool.availableMemoryBytes===null||pool.availableSlots===null||!Number.isFinite(pool.availableMemoryBytes)||!Number.isFinite(pool.availableSlots)||pool.availableMemoryBytes<requiredMemory||pool.availableSlots<1)return 'SHARED_CAPACITY_UNAVAILABLE';
    }
    if(node.qualityRequirements?.length) {
      for(const required of node.qualityRequirements) {
        if(!required.metric||!required.evaluationId||!['higher','lower'].includes(required.direction)||!Number.isFinite(required.value))return 'QUALITY_REQUIREMENT_INVALID';
        const evidence=c.qualityEvidence?.find(e=>e.metric===required.metric&&e.evaluationId===required.evaluationId&&e.direction===required.direction);
        if(!evidence||!Number.isFinite(evidence.value))return 'QUALITY_EVIDENCE_MISSING';
        if(required.direction==='higher'?evidence.value<required.value:evidence.value>required.value)return 'QUALITY_REQUIREMENT_UNMET';
      }
    } else if(!Number.isFinite(node.minimumQuality)||c.quality===null||!Number.isFinite(c.quality)||c.quality<node.minimumQuality)return 'QUALITY_UNKNOWN_OR_LOW';
    if([c.computeMs,c.queueMs,c.coldMs,c.uncertaintyMs!,c.publishMs].some(n=>n===null||!Number.isFinite(n)||n<0))return 'COST_UNKNOWN';
    return null;
  }
  /** Price a fixed producer's publication; it never selects or dispatches another executor. */
  publication(artifact:PlacementArtifact,to:string,request:PlacementRequest){return this.transfer(artifact,to,request);}
  private transfer(artifact:PlacementArtifact,to:string,r:PlacementRequest,holderInstanceId?:string):number|null {
    return this.transferRoute(artifact,to,r,holderInstanceId)?.cost??null;
  }
  private transferRoute(artifact:PlacementArtifact,to:string,r:PlacementRequest,holderInstanceId?:string):{cost:number;sourceHolderId?:string;sourceEndpointId?:string;sourceEndpointEpoch?:string;relayId?:string;uploadMs?:number;downloadMs?:number;endpointId?:string;endpointEpoch?:string;endpointOperation?:'READ'|'WRITE'}|null {
    if(!Number.isSafeInteger(artifact.bytes)||artifact.bytes<0)return null;
    const choices:{cost:number;sourceHolderId?:string;sourceEndpointId?:string;sourceEndpointEpoch?:string;relayId?:string;uploadMs?:number;downloadMs?:number;endpointId?:string;endpointEpoch?:string;endpointOperation?:'READ'|'WRITE'}[]=[];
    const fresh=(l:PlacementLink)=>l.source===r.domain&&l.observedAt<=r.now&&r.now-l.observedAt<=l.ttlMs&&Number.isFinite(l.ttlMs)&&l.ttlMs>0&&
      Number.isFinite(l.bytesPerSecond)&&l.bytesPerSecond>0&&Number.isFinite(l.fixedMs)&&l.fixedMs>=0;
    for(const source of artifact.replicas){
      if(source.readMs===null||!Number.isFinite(source.readMs)||source.readMs<0)continue;
      const origin={sourceHolderId:source.holderInstanceId,sourceEndpointId:source.endpointId,sourceEndpointEpoch:source.endpointEpoch};
      if(source.deviceId===to&&(!source.holderInstanceId||source.holderInstanceId===holderInstanceId)){choices.push({cost:source.readMs,...origin});continue;}
      if(source.localOnly||!r.networkAllowed||r.privacy==='LOCAL_ONLY')continue;
      if(source.holderInstanceId&&r.inputRelayId){
        const upload=this.transfer({id:artifact.id,bytes:artifact.bytes,replicas:[{deviceId:source.deviceId,readMs:source.readMs}]},r.inputRelayId,{...r,inputRelayId:undefined});
        const download=this.transfer({id:artifact.id,bytes:artifact.bytes,replicas:[{deviceId:r.inputRelayId,readMs:0}]},to,{...r,inputRelayId:undefined});
        if(upload!==null&&download!==null&&(!r.relayCapacity||r.relayCapacity.deviceId===r.inputRelayId&&r.relayCapacity.availableSlots>=1&&(r.relayCapacity.availableBytes===undefined||Number.isFinite(r.relayCapacity.availableBytes)&&r.relayCapacity.availableBytes>=artifact.bytes)&&r.relayCapacity.observedAt<=r.now&&r.relayCapacity.observedAt+r.relayCapacity.ttlMs>=r.now))choices.push({cost:upload+download,...origin,relayId:r.inputRelayId,uploadMs:upload,downloadMs:download});
        for(const link of r.links.filter(l=>l.endpointId&&!r.excludedInputEndpoints?.includes(l.endpointId)&&l.endpointEpoch&&l.endpointOperation===(source.transferOperation??'WRITE')&&l.from===source.deviceId&&l.to===to&&l.fromHolderInstanceId===source.holderInstanceId&&l.toHolderInstanceId===holderInstanceId&&fresh(l)))
          choices.push({...origin,cost:source.readMs+artifact.bytes/link.bytesPerSecond*1000+(link.effective?0:link.fixedMs),endpointId:link.endpointId,endpointEpoch:link.endpointEpoch,endpointOperation:link.endpointOperation});
      }else{
        for(const link of r.links.filter(l=>!l.endpointId&&l.from===source.deviceId&&l.to===to&&fresh(l)))
          choices.push({...origin,cost:source.readMs+artifact.bytes/link.bytesPerSecond*1000+(link.effective?0:link.fixedMs)});
      }
    }
    choices.sort((a,b)=>a.cost-b.cost);return choices[0]??null;
  }
  private demands(c:PlacementCandidate,node:PlacementNode,r:PlacementRequest):PoolDemand[] {
    const result:PoolDemand[]=[{key:'target:'+c.targetId,amount:1,capacity:c.availableSlots}];
    for(const poolId of c.resourcePoolIds){
      const pool=r.deviceResources.find(p=>p.deviceId===c.deviceId&&p.resourcePoolId===poolId)!;
      const key=poolOccupancyKey(c.deviceId,poolId);
      if(c.resourceDemand)result.push({key,amount:c.resourceDemand.find(d=>d.resourcePoolId===poolId)!.amount,capacity:pool.available!});
      else result.push({key:key+':slots',amount:1,capacity:pool.availableSlots!},{key:key+':memory',amount:c.requiredMemoryBytes??node.memoryBytes,capacity:pool.availableMemoryBytes!});
    }
    if(c.holderCapacity)for(const d of c.resourceDemand??[])result.push({key:poolOccupancyKey(c.deviceId,d.resourcePoolId,c.holderInstanceId),amount:d.amount,capacity:c.holderCapacity.find(p=>p.resourcePoolId===d.resourcePoolId)!.amount});
    return result;
  }
  private extend(state:Beam,node:PlacementNode,c:PlacementCandidate,r:PlacementRequest,rejection?:PlannerRejection):Beam|null {
    let inputSourceHolderId:string|undefined,inputSourceEndpointId:string|undefined,inputSourceEndpointEpoch:string|undefined;
    let inputRelayId:string|undefined,inputUploadMs:number|undefined,inputDownloadMs:number|undefined;
    let inputEndpointId:string|undefined,inputEndpointEpoch:string|undefined,inputEndpointOperation:'READ'|'WRITE'|undefined;
    let transfer=0,ready=Math.max(0,...node.dependencies.map(id=>state.completed.get(id)??0));
    const artifacts=new Map(state.artifacts);
    for(const id of new Set(node.inputs)){
      const artifact=state.artifacts.get(id);if(!artifact)return null;
      const route=this.transferRoute(artifact,c.deviceId,r,c.holderInstanceId);if(route===null)return null;
      if(node.inputs.length===1){inputSourceHolderId=route.sourceHolderId;inputSourceEndpointId=route.sourceEndpointId;inputSourceEndpointEpoch=route.sourceEndpointEpoch;inputRelayId=route.relayId;inputUploadMs=route.uploadMs;inputDownloadMs=route.downloadMs;inputEndpointId=route.endpointId;inputEndpointEpoch=route.endpointEpoch;inputEndpointOperation=route.endpointOperation;}
      transfer+=route.cost;ready=Math.max(ready,state.ready.get(id)??0);
    }
    const output:PlacementArtifact={id:node.output.id,bytes:node.output.bytes,replicas:[{deviceId:c.deviceId,readMs:0}]};
    const localResult=r.localResultHolderId!==undefined&&c.holderInstanceId===r.localResultHolderId&&c.appInstanceId!==undefined&&c.appInstanceId===r.appInstanceId;
    const retained=!!(node.output.retainAtExecutor&&c.dataEndpoint&&c.holderInstanceId);
    if(retained)output.replicas[0]={deviceId:c.deviceId,holderInstanceId:c.holderInstanceId,readMs:0,transferOperation:'WRITE',endpointId:c.dataEndpoint!.id,endpointEpoch:c.dataEndpoint!.epoch};
    if(localResult)output.replicas[0].holderInstanceId=c.holderInstanceId;
    const publication=r.materializeOutputsAt&&!localResult&&!retained?this.transfer(output,r.materializeOutputsAt,r):0;
    if(publication===null)return null;
    const execution=c.computeMs!+c.queueMs!+c.coldMs!+c.publishMs!+publication,duration=execution+c.uncertaintyMs!;
    const relayDemands:PoolDemand[]=inputRelayId&&r.relayCapacity?[{key:'relay:'+inputRelayId,amount:1,capacity:r.relayCapacity.availableSlots}]:[];
    const transferStart=earliestFeasibleV2(state.occupancy,relayDemands,ready,transfer);
    const demands=this.demands(c,node,r),arrival=transferStart+transfer;
    // Policy queueing precedes admission and holds no pool. DAG reservations only cover execution.
    const queued=c.availability?c.queueMs!:0;
    const resourceStart=earliestFeasibleV2(state.occupancy,demands,arrival+queued,duration-queued);
    const start=r.queuedOccupancy?earliestFeasibleV2([...state.occupancy,...r.queuedOccupancy],demands,arrival+queued,duration-queued):resourceStart;
    if(!Number.isFinite(start)){
      if(rejection)rejection.code=Number.isFinite(resourceStart)?'POLICY_WAIT_UNKNOWN':'RESOURCE_WAIT_UNKNOWN';
      return null;
    }
    const end=start+duration-queued,policyWait=start-resourceStart+queued;
    const cost=Math.max(state.cost,end);
    if(cost>r.remainingBudgetMs){
      const sample=c.availability?.resourceWait,release=sample?.value?sample.sampledAt+sample.value-r.now:0;
      if(rejection&&release>0&&start>arrival&&Math.max(state.cost,end-(start-arrival))<=r.remainingBudgetMs)rejection.retryAfterMs=release;
      return null;
    }
    artifacts.set(node.output.id,r.materializeOutputsAt&&!localResult&&!retained?{...output,replicas:[{deviceId:r.materializeOutputsAt,readMs:0}]}:output);
    const completed=new Map(state.completed);completed.set(node.id,end);
    const availability=new Map(state.ready);availability.set(node.output.id,end);
    return {cost,artifacts,ready:availability,completed,occupancy:[...state.occupancy,...relayDemands.map(d=>({key:d.key,start:transferStart,end:transferStart+transfer,amount:d.amount})),...demands.map(d=>({key:d.key,start,end,amount:d.amount}))],
      assignments:[...state.assignments,{...(inputSourceHolderId?{inputSourceHolderId,inputSourceEndpointId,inputSourceEndpointEpoch}:{}),...(inputRelayId?{inputRelayId,inputUploadMs,inputDownloadMs}:{}),...(retained?{outputEndpointId:c.dataEndpoint!.id,outputEndpointEpoch:c.dataEndpoint!.epoch}:{}),...(inputEndpointId?{inputEndpointId,inputEndpointEpoch,inputEndpointOperation}:{}),...(c.availability?{policyQueueMs:policyWait,dagResourceWaitMs:resourceStart-arrival-queued}:{}),targetId:c.targetId,nodeId:node.id,deviceId:c.deviceId,executorId:c.executorId,...(c.costSource?{costSource:c.costSource,costConfidence:c.costConfidence}:{}),phaseCosts:{EXECUTE:c.computeMs!+c.coldMs!,QUEUE:r.initialOccupancy?start-arrival:c.queueMs!,PUBLISH:c.publishMs!+publication},inputTransferMs:transfer,executionMs:execution+policyWait-queued,uncertaintyMs:c.uncertaintyMs!,startMs:start,finishMs:end}]};
  }
  private finish(state:Beam|null,nodes:PlacementNode[],r:PlacementRequest):Beam|null {
    if(!state||!r.finalDestination||!nodes.length)return state;
    let cost=state.cost;
    for(const node of nodes.filter(n=>!nodes.some(other=>other.dependencies.includes(n.id)))){
      const output=state.artifacts.get(node.output.id)!;
      if(r.localResultHolderId&&output.replicas.some(replica=>replica.holderInstanceId===r.localResultHolderId))continue;
      const transfer=this.transfer(output,r.finalDestination,r);if(transfer===null)return null;
      cost=Math.max(cost,(state.completed.get(node.id)??0)+transfer);
    }
    return cost>r.remainingBudgetMs?null:{...state,cost};
  }
}

export interface PlacementRollout { canaryRate?:number;canaryMinimumSamples?:number;canaryMaximumFailureRate?:number; maximumRecoveryAttempts?:number; mode:'OBSERVE'|'SHADOW'|'CANARY'|'ACTIVE';policyVersion:string;expiresAt:number;killSwitch:boolean;
  allowedDevices:string[];allowedCapabilities:string[];sampleCount:number;minimumSamples:number;qualityPassed:boolean;nonInferiorityPassed:boolean;failureRate:number;maximumFailureRate:number;cohortAllowed:boolean; }
export function authorizePlacement(decision:WorkflowPlacementDecision,config:PlacementRollout,capability:string,now:number):PlannerAssignment[]|null {
  const baseline=decision.baseline;
  if(!Number.isFinite(config.expiresAt)||!Number.isSafeInteger(config.sampleCount)||!Number.isSafeInteger(config.minimumSamples)||config.minimumSamples<1||config.sampleCount<0||!Number.isFinite(config.maximumFailureRate)||config.maximumFailureRate<0||config.maximumFailureRate>1||config.failureRate<0||!Array.isArray(config.allowedDevices)||!Array.isArray(config.allowedCapabilities)||config.killSwitch!==false||config.expiresAt<=now||!config.policyVersion||!['CANARY','ACTIVE'].includes(config.mode)||config.cohortAllowed!==true||
    config.sampleCount<config.minimumSamples||config.qualityPassed!==true||config.nonInferiorityPassed!==true||!Number.isFinite(config.failureRate)||config.failureRate>config.maximumFailureRate||
    !config.allowedCapabilities.includes(capability)||decision.suggestion?.some(a=>!config.allowedDevices.includes(a.deviceId)))return baseline;
  return decision.suggestion;
}

import {dispatchDiagnostics} from './dispatch-diagnostics';
import { Prisma, PrismaClient } from '../generated/client';
import { PlanningSnapshot, PlanningPolicy, PlacementRequest, PlanningClock, SnapshotDecision, plan,WorkflowPlacementPlanner,PlacementArtifact } from '@harmony/scheduler-core';
import type { ContributionPolicy } from './directory';

/** Internal projections only. B3 adapters must validate protocol input before calling replace. */
export class SnapshotBuilder {
  constructor(private readonly db:PrismaClient,private readonly domain:'REAL'|'SIMULATED'){}
  async replace(input:Omit<PlanningSnapshot,'version'|'domain'>,policy:PlanningPolicy,transaction?:Prisma.TransactionClient,contributionPolicy?:ContributionPolicy):Promise<void>{
    if(!input.groupId||input.policyVersion!==policy.version||!Number.isFinite(input.capturedAt)||
      !Array.isArray(input.devices)||!Array.isArray(input.resources)||!Array.isArray(input.candidates)||!Array.isArray(input.links))throw new Error('SNAPSHOT_INVALID');
    // Publish the directory and its revision atomically; there is no business payload here.
    const write=async(tx:Prisma.TransactionClient)=>{
      const previous=await tx.group.findUnique({where:{id:input.groupId}});
      const snapshot:PlanningSnapshot={...input,version:(previous?.revision??0)+1,domain:this.domain};
      const data={groupId:input.groupId,revision:snapshot.version,metadataJson:JSON.stringify({snapshot:{...snapshot,candidates:[],devices:[]},policy,contributionPolicy})};
      await tx.group.upsert({where:{id:input.groupId},create:{id:input.groupId,...data},update:data});
      // Publish directory rows in bounded SQL batches in the same transaction.
      // No per-target IPC round-trip and no deletion of historical projections.
      for(const candidate of input.candidates){
        if(candidate.availability&&candidate.availability.snapshotVersion!==snapshot.version)throw Error('AVAILABILITY_SCOPE_MISMATCH');
      }
      const targets=input.candidates.map(c=>Prisma.sql`(${JSON.stringify([input.groupId,c.targetId])},${input.groupId},${snapshot.version},${JSON.stringify(c)})`);
      const devices=input.devices.map(d=>Prisma.sql`(${JSON.stringify(['snapshot-device',input.groupId,d.deviceId,d.holderInstanceId??null])},${input.groupId},${snapshot.version},${JSON.stringify(d)})`);
      for(let i=0;i<targets.length;i+=100){
        await tx.$executeRaw(Prisma.sql`INSERT INTO "Target" ("id","groupId","revision","metadataJson") VALUES ${Prisma.join(targets.slice(i,i+100))} ON CONFLICT("id") DO UPDATE SET "revision"=excluded."revision","metadataJson"=excluded."metadataJson"`);
      }
      for(let i=0;i<devices.length;i+=100){
        await tx.$executeRaw(Prisma.sql`INSERT INTO "DeviceInstance" ("id","groupId","revision","metadataJson") VALUES ${Prisma.join(devices.slice(i,i+100))} ON CONFLICT("id") DO UPDATE SET "revision"=excluded."revision","metadataJson"=excluded."metadataJson"`);
      }
    };
    if(transaction)await write(transaction);else await this.db.$transaction(write);
  }
  async build(groupId:string):Promise<{snapshot:PlanningSnapshot;policy:PlanningPolicy}>{
    return this.db.$transaction(async tx=>{
      const row=await tx.group.findUnique({where:{id:groupId}});
      if(!row)throw new Error('GROUP_UNKNOWN');
      const result=JSON.parse(row.metadataJson) as {snapshot:PlanningSnapshot;policy:PlanningPolicy};
      if(result.snapshot.domain!==this.domain||result.snapshot.groupId!==groupId||result.snapshot.version!==row.revision)throw new Error('SNAPSHOT_CORRUPT');
      const targets=await tx.target.findMany({where:{groupId,revision:row.revision},orderBy:{id:'asc'}});
      const devices=await tx.deviceInstance.findMany({where:{groupId,revision:row.revision},orderBy:{id:'asc'}});
      result.snapshot.candidates=targets.map(t=>JSON.parse(t.metadataJson));
      // Legacy A snapshots used [groupId,deviceId]; raw B profiles share this table but never belong in this projection.
      result.snapshot.devices=devices.filter(d=>d.id.startsWith('["snapshot-device",')||JSON.parse(d.id)[0]===groupId&&JSON.parse(d.id).length===2).map(d=>JSON.parse(d.metadataJson));
      return result;
    });
  }
}

export class PlanningService {
  constructor(private readonly snapshots:SnapshotBuilder){}
  /** Read-only qualified-target counts per capability for an App's routing report. Counting candidates is not selecting them (R21). */
  async availability(groupId:string,capabilities:string[]):Promise<{capability:string;targets:number;services:number;devices:number}[]>{
    let candidates:PlanningSnapshot['candidates']=[];try{candidates=(await this.snapshots.build(groupId)).snapshot.candidates;}catch{candidates=[];}
    const now=Date.now();
    return capabilities.map(capability=>{const mine=candidates.filter(c=>c.capability===capability&&c.observedAt<=now&&c.observedAt+c.ttlMs>now);return {capability,targets:new Set(mine.map(c=>c.targetId)).size,services:new Set(mine.filter(c=>c.serviceId!==undefined).map(c=>c.targetId)).size,devices:new Set(mine.map(c=>c.deviceId)).size};});
  }
  plan(snapshot:PlanningSnapshot,request:PlacementRequest,policy:PlanningPolicy,clock:PlanningClock):SnapshotDecision {
    return plan(snapshot,request,policy,clock);
  }
  /** Equivalent paths compete in the same planner; callers never rank directory candidates. */
  alternatives(snapshot:PlanningSnapshot,requests:PlacementRequest[],policy:PlanningPolicy,clock:PlanningClock){
    if(requests.length<1||requests.length>8)throw Error('SDK_ALTERNATIVES_INVALID');
    const decisions=requests.map(request=>this.plan(snapshot,request,policy,clock));
    let selected=-1;
    for(let i=0;i<decisions.length;i++)if(decisions[i].decision.suggestion&&(selected<0||decisions[i].decision.suggestionMs!<decisions[selected].decision.suggestionMs!))selected=i;
    return {selected,decision:decisions[selected<0?0:selected]};
  }
  publication(snapshot:PlanningSnapshot,request:PlacementRequest,artifact:PlacementArtifact,to:string,policy:PlanningPolicy,clock:PlanningClock){
    if(policy.revoked||snapshot.policyVersion!==policy.version||snapshot.domain!==request.domain)throw Error('PLAN_STALE');
    const capacity=request.relayCapacity;if(capacity?.deviceId===to&&capacity.availableBytes!==undefined&&(!Number.isFinite(capacity.availableBytes)||capacity.availableBytes<artifact.bytes))throw Error('ARTIFACT_CACHE_FULL');
    const cost=new WorkflowPlacementPlanner(policy.limits,clock.monotonic).publication(artifact,to,{...request,now:clock.now,links:snapshot.links,inputRelayId:undefined});
    if(cost===null)throw Error('PUBLICATION_PATH_UNAVAILABLE');if(cost>request.remainingBudgetMs)throw Error('BUDGET_EXHAUSTED');return cost;
  }
  /** Last check before an offer; the executing holder must still perform atomic admission. */
  async preflight(groupId:string,expected:SnapshotDecision,request:PlacementRequest,clock:PlanningClock|(()=>PlanningClock),jobId?:string,validated?:(current:SnapshotDecision)=>void):Promise<boolean>{
    const {snapshot,policy}=await this.snapshots.build(groupId);
    dispatchDiagnostics.record({at:Date.now(),kind:"PREFLIGHT",groupId,jobId,version:expected.snapshotVersion,snapshotVersion:snapshot.version});
    // Concurrent ready nodes and heartbeats publish newer observations. A new
    // revision alone does not invalidate a placement: replan against it instead.
    // Policy changes still require a new offer; physical credit is checked again
    // atomically by persistOffer and by the device's admission ledger.
    if(expected.groupId!==groupId||expected.domain!==snapshot.domain||policy.version!==expected.policyVersion||policy.revoked||!expected.decision.suggestion)return false;
    // Snapshot reads await the database and may observe a heartbeat published
    // after the call began. Sample production time after I/O, once for this plan.
    const current=this.plan(snapshot,request,policy,typeof clock==='function'?clock():clock);
    const placement=(a:NonNullable<typeof current.decision.suggestion>[number])=>[a.nodeId,a.targetId,a.deviceId,a.executorId,a.inputSourceHolderId,a.inputSourceEndpointId,a.inputSourceEndpointEpoch,a.inputRelayId,a.inputEndpointId,a.inputEndpointEpoch,a.inputEndpointOperation,a.outputEndpointId,a.outputEndpointEpoch];
    const valid=!!current.decision.suggestion&&JSON.stringify(current.decision.suggestion.map(placement))===JSON.stringify(expected.decision.suggestion.map(placement));
    if(valid)validated?.(current);
    return valid;
  }
}

import { Prisma, PrismaClient } from '../generated/client';
import { PlanningSnapshot, PlanningPolicy, PlacementRequest, PlanningClock, SnapshotDecision, plan } from '@harmony/scheduler-core';
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
      // These rows are independently addressable control-plane directory projections.
      for(const candidate of input.candidates)await tx.target.upsert({where:{id:JSON.stringify([input.groupId,candidate.targetId])},
        create:{id:JSON.stringify([input.groupId,candidate.targetId]),groupId:input.groupId,revision:snapshot.version,metadataJson:JSON.stringify(candidate)},update:{revision:snapshot.version,metadataJson:JSON.stringify(candidate)}});
      for(const device of input.devices){
        const id=JSON.stringify(['snapshot-device',input.groupId,device.deviceId,device.holderInstanceId??null]);
        await tx.deviceInstance.upsert({where:{id},create:{id,groupId:input.groupId,revision:snapshot.version,metadataJson:JSON.stringify(device)},update:{revision:snapshot.version,metadataJson:JSON.stringify(device)}});
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
  plan(snapshot:PlanningSnapshot,request:PlacementRequest,policy:PlanningPolicy,clock:PlanningClock):SnapshotDecision {
    return plan(snapshot,request,policy,clock);
  }
  /** Last check before an offer; the executing holder must still perform atomic admission. */
  async preflight(groupId:string,expected:SnapshotDecision,request:PlacementRequest,clock:PlanningClock):Promise<boolean>{
    const {snapshot,policy}=await this.snapshots.build(groupId);
    if(expected.groupId!==groupId||expected.domain!==snapshot.domain||snapshot.version!==expected.snapshotVersion||policy.version!==expected.policyVersion||policy.revoked||!expected.decision.suggestion)return false;
    const current=this.plan(snapshot,request,policy,clock);
    return !!current.decision.suggestion&&JSON.stringify(current.decision.suggestion)===JSON.stringify(expected.decision.suggestion);
  }
}

import {dispatchDiagnostics} from './dispatch-diagnostics';
import { Prisma, PrismaClient } from '../generated/client';
import { costEstimatePolicy,DeviceProfileV2, PlanningPolicy, protocolId, WorkflowPlacementPlanner } from '@harmony/scheduler-core';
import { ContributionPolicy, DeviceDirectory } from './directory';
import { SnapshotBuilder } from './planning';
import type { Peer } from './channel';

function validPolicy(p:ContributionPolicy):boolean {
  return !!p&&Object.keys(p).sort().join('|')==='allowMetered|maximumTemperature|minimumBattery|priority|requireForeground'&&
    (p.minimumBattery===null||Number.isFinite(p.minimumBattery)&&p.minimumBattery>=0&&p.minimumBattery<=100)&&
    (p.maximumTemperature===null||Number.isFinite(p.maximumTemperature)&&p.maximumTemperature>=0)&&
    typeof p.allowMetered==='boolean'&&typeof p.requireForeground==='boolean'&&
    ['ORIGIN_INTERACTIVE','REMOTE_INTERACTIVE','REMOTE_BATCH'].includes(p.priority);
}

/** Authenticated profile and planning projection commit together, before the channel ACK. */
export class ProfileProjection {
  private readonly refreshing=new Map<string,Promise<void>>();
  private readonly listeners=new Map<string,Set<()=>void>>();
  watch(group:string,holder:string,wake:()=>void){
    const key=JSON.stringify([group,holder]),listeners=this.listeners.get(key)??new Set<()=>void>();listeners.add(wake);this.listeners.set(key,listeners);
    return ()=>{listeners.delete(wake);if(!listeners.size)this.listeners.delete(key);};
  }
  changed(group:string,holder:string){for(const wake of this.listeners.get(JSON.stringify([group,holder]))??[])wake();}
  constructor(private readonly db:PrismaClient,private readonly directory:DeviceDirectory,private readonly snapshots:SnapshotBuilder){}
  /** Trusted local administration only. Pairing alone does not authorize targets or pick a contribution policy. */
  async configure(groupId:string,policy:PlanningPolicy,contribution:ContributionPolicy,onlyReplacePolicyVersion?:string):Promise<void>{
    if(!protocolId(groupId)||!policy||!protocolId(policy.version)||typeof policy.revoked!=='boolean'||
      !Array.isArray(policy.allowedTargetIds)||policy.allowedTargetIds.length>4096||!policy.allowedTargetIds.every(protocolId)||
      new Set(policy.allowedTargetIds).size!==policy.allowedTargetIds.length||!validPolicy(contribution))throw Error('PROFILE_POLICY_INVALID');
    new WorkflowPlacementPlanner(policy.limits,()=>0);
    await this.db.$transaction(async tx=>{
      // Bootstrap must not overwrite an explicit policy installed after its initial read.
      const row=await tx.group.findUnique({where:{id:groupId}});
      if(onlyReplacePolicyVersion){
        if(row){const saved=JSON.parse(row.metadataJson);if(saved.policy.version!==onlyReplacePolicyVersion){
          if(saved.contributionPolicy)await this.publish(tx,groupId,saved.policy,saved.contributionPolicy,row.revision+1);return;
        }}
      }
      await this.publish(tx,groupId,policy,contribution,(row?.revision??0)+1);
    });
  }
  async ingest(peer:Peer,profile:DeviceProfileV2):Promise<void>{
    const version=await this.db.$transaction(async tx=>{
      const changed=await this.directory.ingest(peer,profile,tx);
      if(!changed)return;
      const row=await tx.group.findUnique({where:{id:peer.groupId}});
      if(!row)return; // Visible in the directory, but no authorized planning policy yet.
      const saved=JSON.parse(row.metadataJson);
      if(!saved.contributionPolicy)return; // A-stage snapshots are not silently opted in.
      return this.publish(tx,peer.groupId,saved.policy,saved.contributionPolicy,row.revision+1);
    });
    if(version!==undefined)this.changed(peer.groupId,peer.holderInstanceId);
    if(version!==undefined)dispatchDiagnostics.record({at:Date.now(),kind:"SNAPSHOT_REFRESH",groupId:peer.groupId,holderId:peer.holderInstanceId,source:"PROFILE",snapshotVersion:version});
  }
  /** Called by a future trusted evidence service after a qualification change; never accepts device self-approval. */
  refresh(groupId:string,source="EVIDENCE",jobId?:string):Promise<void>{
    const active=this.refreshing.get(groupId);if(active)return active;
    const pending=this.refreshOnce(groupId,source,jobId).finally(()=>{if(this.refreshing.get(groupId)===pending)this.refreshing.delete(groupId);});
    this.refreshing.set(groupId,pending);return pending;
  }
  private async refreshOnce(groupId:string,source:string,jobId?:string):Promise<void>{
    const version=await this.db.$transaction(async tx=>{
      const row=await tx.group.findUnique({where:{id:groupId}});
      if(!row)throw Error('GROUP_UNKNOWN');
      const saved=JSON.parse(row.metadataJson);
      if(!saved.contributionPolicy)throw Error('PROFILE_POLICY_REQUIRED');
      return this.publish(tx,groupId,saved.policy,saved.contributionPolicy,row.revision+1);
    });
    dispatchDiagnostics.record({at:Date.now(),kind:"SNAPSHOT_REFRESH",groupId,source,jobId,snapshotVersion:version});
  }
  private async publish(tx:Prisma.TransactionClient,groupId:string,policy:PlanningPolicy,contribution:ContributionPolicy,version:number){
    const snapshot=await this.directory.snapshot(groupId,policy.version,version,contribution,tx,costEstimatePolicy(policy.costEstimate));
    await this.snapshots.replace(snapshot,policy,tx,contribution);
    return version;
  }
}

import {randomUUID} from 'node:crypto';
import {canonical,validArtifactRefV2} from '@harmony/scheduler-core';
import {ArtifactChannel,ArtifactDescriptor,transferDigest} from '@harmony/resource-transport';
import {PrismaClient,Prisma} from '../generated/client';
import {Peer} from './channel';
import {DirectTransfers} from './direct-transfers';
/** Rebuild cache ownership from durable graph/attempt records, including after restart. */
export class ArtifactRetention {
 private timer:NodeJS.Timeout|undefined;private cleaning:Promise<void>|undefined;
 start(){if(!this.timer){this.timer=setInterval(()=>{void this.sweepRelay().catch(()=>{});},15000);this.timer.unref();}}
 async close(){if(this.timer)clearInterval(this.timer);await this.cleaning;}
 constructor(private db:PrismaClient,private direct:DirectTransfers,private channel:ArtifactChannel,private now=Date.now){}
 private async needed(tx:Prisma.TransactionClient,groupId:string,ref:ArtifactDescriptor['ref']){
  const jobs=(await tx.cpuJob.findMany({where:{groupId}})).map(row=>({row,d:JSON.parse(row.metadataJson)}));
  const graphs=(await tx.sdkWorkflowJob.findMany({where:{groupId}})).map(row=>({row,g:JSON.parse(row.metadataJson)}));
  let known=false;
  for(const {row,d} of jobs){
   const input=canonical(d.input?.ref)===canonical(ref),output=canonical(d.output?.ref)===canonical(ref);if(!input&&!output)continue;known=true;
   const attempt=await tx.attempt.findUnique({where:{id:row.id}}),record=attempt?.recordJson?JSON.parse(attempt.recordJson):null;
   if(attempt&&!record?.resourcesSettled&&!['REJECTED','HOLDER_RECORD_MISSING'].includes(attempt.state))return true;
   const graph=graphs.find(x=>x.row.id===d.offer.task.workflowId);
   if(graph&&!Array.isArray(graph.g.nodes))return true;
   const active=graph?['ACTIVE','WAITING_INPUT'].includes(graph.row.state):['WAITING_INPUT','DISPATCHING','DISPATCHED'].includes(row.state)&&!record?.resourcesSettled;
   if(input&&active&&!attempt)return true;
   if(output){
    if(graph){
     if(active&&graph.g.workflow.nodes.some((n:any)=>n.inputFrom===d.offer.task.nodeId&&graph.g.nodes.find((s:any)=>s.id===n.id)?.state!=='COMMITTED'))return true;
     const sink=!graph.g.workflow.nodes.some((n:any)=>n.inputFrom===d.offer.task.nodeId);if(sink&&active)return true;
     if(sink&&graph.row.state==='SUCCEEDED'&&!graph.g.resultReceivedAt&&this.now()<Math.min(d.output.expiresAt,graph.g.deadlineAt+300000))return true;
    }else if(record?.state==='SUCCEEDED'&&!d.resultReceivedAt&&this.now()<Math.min(d.output.expiresAt,d.deadlineAt+300000))return true;
   }
  }
  for(const {row,g} of graphs)for(const [nodeId,d] of Object.entries(g.inputs??{}) as [string,ArtifactDescriptor][]){
   if(canonical(d.ref)!==canonical(ref))continue;known=true;
   if(['ACTIVE','WAITING_INPUT'].includes(row.state)&&g.nodes.find((n:any)=>n.id===nodeId)?.state!=='COMMITTED')return true;
  }
  // Unknown objects may be registering concurrently; their hard expiry is the safe fallback.
  return !known;
 }
 async inventory(peer:Peer,body:any){
  if(!body||Object.keys(body).sort().join('|')!=='epoch|objects'||!Array.isArray(body.objects)||body.objects.length>64||body.objects.some((d:any)=>!d||Object.keys(d).sort().join('|')!=='bytes|expiresAt|ref'||!validArtifactRefV2(d.ref)||!Number.isSafeInteger(d.bytes)||d.bytes<1||d.bytes>8388608||(!Number.isSafeInteger(d.expiresAt)||d.expiresAt<1)))throw Error('CACHE_INVENTORY_INVALID');
  const endpoint=await this.direct.ownedEndpoint(peer);if(endpoint.epoch!==body.epoch)throw Error('RELEASE_SCOPE');
  // Inventory is never a proof of a readable/servable copy. It only permits later owner cleanup.
  await this.db.$transaction(async tx=>{for(const d of body.objects){
   const id=transferDigest(canonical([peer.groupId,d.ref,endpoint.id,endpoint.epoch]));
   await tx.dataReplica.upsert({where:{id},create:{id,groupId:peer.groupId,endpointId:endpoint.id,metadataJson:JSON.stringify({...d,endpoint,kind:'ORPHAN',servable:false,appInstanceId:null})},update:{}});
  }});return {recorded:true};
 }
 async plan(peer:Peer){
  const endpoint=await this.direct.ownedEndpoint(peer);
  return this.db.$transaction(async tx=>{
   const rows=await tx.dataReplica.findMany({where:{groupId:peer.groupId,endpointId:endpoint.id}}),release=[];
   for(const row of rows){
    const r=JSON.parse(row.metadataJson);if(r.endpoint.epoch!==endpoint.epoch)continue;
    if(r.expiresAt>this.now()&&await this.needed(tx,peer.groupId,r.ref))continue;
    const grants=await tx.transferAuthorization.findMany({where:{groupId:peer.groupId,state:{in:['ISSUED','CONSUMED']},expiresAt:{gt:this.now()}}});
    if(grants.some(g=>{const a=JSON.parse(g.metadataJson).authorization;return canonical(a.ref)===canonical(r.ref)&&(a.endpoint.id===endpoint.id||a.senderHolderId===peer.holderInstanceId);}))continue;
    r.releaseIntent??={id:randomUUID(),at:this.now(),epoch:endpoint.epoch};
    await tx.dataReplica.update({where:{id:row.id},data:{metadataJson:JSON.stringify(r)}});
    release.push({id:r.releaseIntent.id,ref:r.ref,epoch:endpoint.epoch});
   }
   return {endpointId:endpoint.id,epoch:endpoint.epoch,release};
  });
 }
 async confirm(peer:Peer,body:any){
  if(!body||Object.keys(body).sort().join('|')!=='epoch|id|ref')throw Error('RELEASE_SCOPE');
  const endpoint=await this.direct.ownedEndpoint(peer);if(endpoint.epoch!==body.epoch)throw Error('RELEASE_SCOPE');
  const rows=await this.db.dataReplica.findMany({where:{groupId:peer.groupId,endpointId:endpoint.id}});
  for(const row of rows){const r=JSON.parse(row.metadataJson);if(r.releaseIntent?.id===body.id&&r.endpoint.epoch===body.epoch&&canonical(r.ref)===canonical(body.ref)){await this.db.dataReplica.deleteMany({where:{id:row.id,metadataJson:row.metadataJson}});return {released:true};}}
  return {released:true}; // Lost acknowledgment is idempotent.
 }
 sweepRelay(){if(!this.cleaning)this.cleaning=this.collectRelay().finally(()=>{this.cleaning=undefined;});return this.cleaning;}
 private async collectRelay(){
  this.channel.sweep();
  const snapshot=this.channel.snapshot();let generation=snapshot.generation;
  for(const d of snapshot.objects){
   if(await this.db.$transaction(tx=>this.needed(tx,d.groupId,d.ref)))continue;
   const grants=await this.db.transferAuthorization.findMany({where:{groupId:d.groupId,state:{in:['ISSUED','CONSUMED']},expiresAt:{gt:this.now()}}});
   if(grants.some(g=>canonical(JSON.parse(g.metadataJson).authorization.ref)===canonical(d.ref)))continue;
   if(this.channel.forget(d,generation))generation++;
  }
 }
}

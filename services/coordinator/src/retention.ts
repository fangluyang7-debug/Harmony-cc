import {randomUUID} from 'node:crypto';
import {canonical,validArtifactRefV2} from '@harmony/scheduler-core';
import {ArtifactChannel,ArtifactDescriptor,transferDigest} from '@harmony/resource-transport';
import {PrismaClient,Prisma} from '../generated/client';
import {Peer} from './channel';
import {DirectTransfers} from './direct-transfers';
/** Rebuild cache ownership from durable graph/attempt records, including after restart. */
export class ArtifactRetention {
 private timer:NodeJS.Timeout|undefined;private cleaning:Promise<void>|undefined;private scheduled:NodeJS.Timeout|undefined;
 start(){if(!this.timer){this.timer=setInterval(()=>{void this.sweepRelay().catch(()=>{});},15000);this.timer.unref();}}
 // A durable receipt must not wait for a scan of unrelated cached artifacts.
 // Coalesce cleanup hints; periodic recovery and explicit sweeps remain available.
 scheduleSweep(){if(!this.scheduled){this.scheduled=setTimeout(()=>{this.scheduled=undefined;void this.sweepRelay().catch(()=>{});},100);this.scheduled.unref();}}
 async close(){if(this.timer)clearInterval(this.timer);if(this.scheduled){clearTimeout(this.scheduled);this.scheduled=undefined;await this.sweepRelay();}await this.cleaning;}
 constructor(private db:PrismaClient,private direct:DirectTransfers,private channel:ArtifactChannel,private now=Date.now){}
 private async neededByRef(tx:Prisma.TransactionClient,groupId:string){
  // One transaction-local ownership view per group, never one full history read per object.
  const jobs=await tx.cpuJob.findMany({where:{groupId},select:{id:true,state:true,metadataJson:true}});
  const graphs=new Map((await tx.sdkWorkflowJob.findMany({where:{groupId},select:{id:true,state:true,metadataJson:true}})).map(row=>[row.id,{row,g:JSON.parse(row.metadataJson)}]));
  const attempts=new Map((await tx.attempt.findMany({where:{groupId},select:{id:true,state:true,recordJson:true}})).map(a=>[a.id,{state:a.state,record:a.recordJson?JSON.parse(a.recordJson):null}]));
  const needed=new Map<string,boolean>(),now=this.now();
  const mark=(ref:ArtifactDescriptor['ref']|undefined,keep:boolean)=>{if(ref){const key=canonical(ref);needed.set(key,(needed.get(key)??false)||keep);}};
  for(const row of jobs){
   const d=JSON.parse(row.metadataJson),attempt=attempts.get(row.id),record=attempt?.record,graph=graphs.get(d.offer?.task.workflowId);
   const unsettled=Boolean(attempt&&!record?.resourcesSettled&&!['REJECTED','HOLDER_RECORD_MISSING'].includes(attempt.state));
   const malformed=Boolean(graph&&!Array.isArray(graph.g.nodes));
   const active=graph?['ACTIVE','WAITING_INPUT'].includes(graph.row.state):['WAITING_INPUT','DISPATCHING','DISPATCHED'].includes(row.state)&&!record?.resourcesSettled;
   mark(d.input?.ref,unsettled||malformed||Boolean(active&&!attempt));
   if(d.output){
    let keep=unsettled||malformed;
    if(graph&&!malformed){
     if(active&&graph.g.workflow.nodes.some((n:any)=>(n.inputFrom===d.offer.task.nodeId||n.inputFroms?.includes(d.offer.task.nodeId))&&graph.g.nodes.find((s:any)=>s.id===n.id)?.state!=='COMMITTED'))keep=true;
     const sink=!graph.g.workflow.nodes.some((n:any)=>(n.inputFrom===d.offer.task.nodeId||n.inputFroms?.includes(d.offer.task.nodeId)));
     if(sink&&(active||graph.row.state==='SUCCEEDED'&&!graph.g.resultReceivedAt&&now<Math.min(d.output.expiresAt,graph.g.deadlineAt+300000)))keep=true;
    }else if(!graph&&record?.state==='SUCCEEDED'&&!d.resultReceivedAt&&now<Math.min(d.output.expiresAt,d.deadlineAt+300000))keep=true;
    mark(d.output.ref,keep);
   }
  }
  for(const {row,g} of graphs.values())for(const [nodeId,d] of Object.entries(g.inputs??{}) as [string,ArtifactDescriptor][]){
   mark(d.ref,['ACTIVE','WAITING_INPUT'].includes(row.state)&&(!Array.isArray(g.nodes)||g.nodes.find((n:any)=>n.id===nodeId)?.state!=='COMMITTED'));
  }
  // Absence from this map is unknown and retains the object until hard expiry.
  return needed;
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
   const needed=rows.length?await this.neededByRef(tx,peer.groupId):new Map<string,boolean>();
   const grants=(await tx.transferAuthorization.findMany({where:{groupId:peer.groupId,state:{in:['ISSUED','CONSUMED']},expiresAt:{gt:this.now()}}})).map(g=>JSON.parse(g.metadataJson).authorization);
   for(const row of rows){
    const r=JSON.parse(row.metadataJson);if(r.endpoint.epoch!==endpoint.epoch)continue;
    if(r.expiresAt>this.now()&&needed.get(canonical(r.ref))!==false)continue;
    if(grants.some(a=>canonical(a.ref)===canonical(r.ref)&&(a.endpoint.id===endpoint.id||a.senderHolderId===peer.holderInstanceId)))continue;
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
  const groups=new Map<string,ArtifactDescriptor[]>();for(const d of snapshot.objects){const list=groups.get(d.groupId)??[];list.push(d);groups.set(d.groupId,list);}
  for(const [groupId,objects] of groups){
   const release=await this.db.$transaction(async tx=>{
    const needed=await this.neededByRef(tx,groupId);
    const grants=new Set((await tx.transferAuthorization.findMany({where:{groupId,state:{in:['ISSUED','CONSUMED']},expiresAt:{gt:this.now()}}})).map(g=>canonical(JSON.parse(g.metadataJson).authorization.ref)));
    return objects.filter(d=>needed.get(canonical(d.ref))===false&&!grants.has(canonical(d.ref)));
   });
   for(const d of release)if(this.channel.forget(d,generation))generation++;
  }
 }
}

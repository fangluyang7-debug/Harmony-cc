import { PrismaClient } from '../generated/client';
import { TraceSpanV2, validTraceSpanV2, analyzeTrace, canonical, protocolId,projectTraceCausality,TraceJobEvidence,TraceTransferEvidence } from '@harmony/scheduler-core';
import type { Peer } from './channel';
import { randomUUID } from 'node:crypto';
import { DispatchOfferV2 } from '@harmony/scheduler-core';
import {observeExecution} from './performance-feedback';
export class TraceService {
  readonly clockDomainId=randomUUID();
  constructor(private readonly db:PrismaClient){}
  /** Scoped transfer telemetry is independent of the dispatch/receipt transaction. */
  async transfer(peer:Peer,body:any){
    const interval=body?.interval;
    if(!body||Object.keys(body).sort().join('|')!=='authorizationId|interval|side'||!protocolId(body.authorizationId)||!['SENDER','RECEIVER'].includes(body.side)||
      !interval||Object.keys(interval).sort().join('|')!=='clockDomainId|endMono|startMono'||!protocolId(interval.clockDomainId)||!Number.isFinite(interval.startMono)||interval.startMono<0||!Number.isFinite(interval.endMono)||interval.endMono<interval.startMono||interval.endMono-interval.startMono>60000)throw Error('TRANSFER_TRACE_INVALID');
    const grant=await this.db.transferAuthorization.findUnique({where:{id:body.authorizationId}}),a=grant&&JSON.parse(grant.metadataJson).authorization;
    if(!grant||grant.groupId!==peer.groupId||grant.state!=='COMPLETED'||a?.operation!=='WRITE'||a.version!==2||
      (body.side==='SENDER'?(grant.requesterCredentialId!==peer.credentialId||a.senderHolderId!==peer.holderInstanceId):(a.receiverHolderId!==peer.holderInstanceId||a.endpoint.deviceId!==peer.deviceId)))throw Error('TRANSFER_TRACE_SCOPE');
    const job=await this.db.cpuJob.findUnique({where:{id:a.attemptId}}),d=job&&JSON.parse(job.metadataJson);
    if(!job||job.groupId!==peer.groupId||d.sourceAttemptId!==a.producerAttemptId||canonical(d.input.ref)!==canonical(a.ref)||d.input.bytes!==a.bytes)throw Error('TRANSFER_TRACE_SCOPE');
    const span:TraceSpanV2={traceId:d.traceId,spanId:'transfer-'+body.side.toLowerCase()+'-'+a.id,parentSpanId:null,dependsOn:[],transferId:a.id,
      workflowId:d.offer.task.workflowId,nodeId:d.offer.task.nodeId,attemptId:a.attemptId,targetId:d.offer.target.targetId,deviceInstanceId:interval.clockDomainId,
      phase:body.side==='SENDER'?'TRANSFER_SEND':'TRANSFER_RECV',durationMs:interval.endMono-interval.startMono,snapshotVersion:d.plan.snapshotVersion,predictedMs:null,
      reasonCode:body.side==='SENDER'?'SIGNED_HTTP_ROUND_TRIP':'VERIFIED_BYTES_BEFORE_RECEIPT',...interval,
      measurementScope:body.side==='SENDER'?'FULL_TRANSFER':'PARTIAL_TRANSFER',authoritativeSide:'SENDER'};
    if(!validTraceSpanV2(span))throw Error('TRANSFER_TRACE_INVALID');
    const id=JSON.stringify([peer.groupId,d.traceId,span.spanId]);await this.db.traceSpan.upsert({where:{id},create:{id,groupId:peer.groupId,revision:span.snapshotVersion,
      metadataJson:JSON.stringify({readers:[d.offer.task.app.principalId],transferActor:peer.holderInstanceId,span})},update:{}});return {recorded:true};
  }
  /** Trusted coordinator spans, separate from holder-authenticated telemetry. */
  async control(offer:DispatchOfferV2,traceId:string,snapshotVersion:number,phase:string,startMono:number,endMono:number,transferId:string|null=null,predictedMs:number|null=null,reasonCode:string|null=null){
    const span:TraceSpanV2={traceId,spanId:randomUUID(),parentSpanId:null,dependsOn:[],transferId,
      workflowId:offer.task.workflowId,nodeId:offer.task.nodeId,attemptId:offer.task.attemptId,targetId:offer.target.targetId,
      deviceInstanceId:this.clockDomainId,phase,durationMs:endMono-startMono,snapshotVersion,predictedMs,reasonCode,
      startMono,endMono,clockDomainId:this.clockDomainId,measurementScope:'LOCAL_INTERVAL',authoritativeSide:'SELF'};
    if(!validTraceSpanV2(span))throw Error('TRACE_INVALID');
    await this.db.traceSpan.create({data:{id:JSON.stringify([offer.task.groupId,traceId,span.spanId]),groupId:offer.task.groupId,revision:snapshotVersion,
      metadataJson:JSON.stringify({readers:[offer.task.app.principalId],span})}});
  }
  async sourceRoot(peer:Peer,offer:DispatchOfferV2,traceId:string,snapshotVersion:number,interval:any){
    if(!interval||Object.keys(interval).sort().join('|')!=='clockDomainId|endMono|startMono'||!protocolId(interval.clockDomainId)||
      !Number.isFinite(interval.startMono)||interval.startMono<0||!Number.isFinite(interval.endMono)||interval.endMono<interval.startMono||interval.endMono-interval.startMono>3600000||peer.app?.appInstanceId!==offer.task.app.appInstanceId)throw Error('SOURCE_INTERVAL_INVALID');
    const span:TraceSpanV2={traceId,spanId:'source-'+traceId,parentSpanId:null,dependsOn:[],transferId:null,workflowId:offer.task.workflowId,nodeId:offer.task.nodeId,attemptId:offer.task.attemptId,targetId:offer.target.targetId,
      deviceInstanceId:interval.clockDomainId,clockDomainId:interval.clockDomainId,phase:'DELIVER',durationMs:interval.endMono-interval.startMono,startMono:interval.startMono,endMono:interval.endMono,
      snapshotVersion,predictedMs:null,reasonCode:'SOURCE_SDK_SUBMIT_TO_VERIFIED_RESULT',measurementScope:'LOCAL_INTERVAL',authoritativeSide:'SELF'};
    if(!validTraceSpanV2(span))throw Error('SOURCE_INTERVAL_INVALID');
    const id=JSON.stringify([peer.groupId,traceId,'source-root']);await this.db.traceSpan.upsert({where:{id},create:{id,groupId:peer.groupId,revision:snapshotVersion,metadataJson:JSON.stringify({readers:[peer.principalId],sourceSdkRoot:true,span})},update:{}});
  }
  async ingest(peer:Peer,spans:TraceSpanV2[]){
    if(!Array.isArray(spans)||spans.length<1||spans.length>128||!spans.every(validTraceSpanV2))throw Error('TRACE_BATCH_INVALID');
    await this.db.$transaction(async tx=>{
      for(const span of spans){
        const attempt=await tx.attempt.findUnique({where:{id:span.attemptId}});
        if(!attempt||attempt.groupId!==peer.groupId||attempt.holderInstanceId!==peer.holderInstanceId||!attempt.offerJson)throw Error('TRACE_UNAUTHORIZED');
        const offer=JSON.parse(attempt.offerJson);
        if(offer.target.targetId!==span.targetId||offer.target.deviceId!==peer.deviceId||offer.task.workflowId!==span.workflowId||offer.task.nodeId!==span.nodeId)throw Error('TRACE_SCOPE');
        const dispatches=await tx.outbox.findMany({where:{attemptId:span.attemptId,groupId:peer.groupId,kind:'DispatchOffer'}});
        if(!dispatches.some(row=>JSON.parse(row.messageJson).traceId===span.traceId))throw Error('TRACE_SCOPE');
        const id=JSON.stringify([peer.groupId,span.traceId,span.spanId]),old=await tx.traceSpan.findUnique({where:{id}});
        const value={readers:[offer.task.app.principalId,peer.principalId],span};
        if(old){if(canonical(JSON.parse(old.metadataJson))!==canonical(value))throw Error('TRACE_CONFLICT');continue;}
        if(await tx.traceSpan.count({where:{groupId:peer.groupId}})>=16384)throw Error('TRACE_CAPACITY');
        await tx.traceSpan.create({data:{id,groupId:peer.groupId,revision:span.snapshotVersion,metadataJson:JSON.stringify(value)}});
        await observeExecution(tx,peer.groupId,peer.holderInstanceId,span);
      }
    });
  }
  async read(peer:Peer,traceId:string){
    if(!protocolId(traceId))throw Error('TRACE_INVALID');
    const rows=(await this.db.traceSpan.findMany({where:{groupId:peer.groupId}})).map(r=>JSON.parse(r.metadataJson)).filter(r=>r.span.traceId===traceId);
    if(!rows.length||rows.some(r=>!r.readers.includes(peer.principalId)))throw Error('TRACE_UNAUTHORIZED');
    const recorded:TraceSpanV2[]=rows.map(r=>r.span).sort((a,b)=>a.spanId.localeCompare(b.spanId)),root=rows.find(r=>r.sourceSdkRoot===true);
    const jobs=(await this.db.cpuJob.findMany({where:{groupId:peer.groupId}})).map(row=>({id:row.id,sourceHolderId:row.sourceHolderId,d:JSON.parse(row.metadataJson)})).filter(j=>j.d.traceId===traceId);
    const attempts=await this.db.attempt.findMany({where:{groupId:peer.groupId,id:{in:jobs.map(j=>j.id)}}});
    const nodes=await this.db.node.findMany({where:{workflowId:{in:[...new Set(jobs.map(j=>j.d.offer.task.workflowId))]}}});
    const receipts=await this.db.receipt.findMany({where:{committed:true,id:{in:nodes.map(n=>n.currentAttemptId).filter((id):id is string=>!!id)}}});
    const evidence:TraceJobEvidence[]=jobs.map(({id,sourceHolderId,d})=>{
      const parents:string[]=[];let missingParent=false;
      for(const dep of d.offer.dependencies??[]){const node=nodes.find(n=>n.id===JSON.stringify([d.offer.task.workflowId,dep.nodeId]));
        if(node?.state==='COMMITTED'&&node.currentAttemptId&&receipts.some(r=>r.id===node.currentAttemptId))parents.push(node.currentAttemptId);else missingParent=true;}
      const originFinal=d.holderId===sourceHolderId&&d.request?.localResultHolderId===sourceHolderId;
      return {attemptId:id,dispatched:attempts.some(a=>a.id===id),parents,missingParent,unsplitTransfer:!!d.delivery?.relay||!!d.outputFallback||!!d.offer.transferPlan?.length&&(!d.delivery||!d.retainOutput&&!originFinal)};
    });
    const transfers:TraceTransferEvidence[]=[];
    for(const row of await this.db.transferAuthorization.findMany({where:{groupId:peer.groupId,state:'COMPLETED'}})){
      const a=JSON.parse(row.metadataJson).authorization,job=jobs.find(j=>j.id===a?.attemptId),parent=jobs.find(j=>j.id===a?.producerAttemptId);
      if(a?.version===2&&a.operation==='WRITE'&&job&&parent&&job.d.sourceAttemptId===a.producerAttemptId&&canonical(job.d.input.ref)===canonical(a.ref))
        transfers.push({id:a.id,attemptId:a.attemptId,producerAttemptId:a.producerAttemptId,producerHolderId:parent.d.holderId,senderHolderId:a.senderHolderId,receiverHolderId:a.receiverHolderId,refKey:canonical([a.appInstanceId,a.ref])});
    }
    const {spans,causality}=projectTraceCausality(recorded,root?.span.spanId??null,evidence,transfers);
    for(const span of spans){const job=jobs.find(j=>j.id===span.attemptId),cost=job?.d.decisionEvidence;
      if(cost?.snapshotVersion===span.snapshotVersion&&job!.d.offer.target.targetId===span.targetId&&span.reasonCode!=='LOCAL_PHASE_UNCLASSIFIED'&&['EXECUTE','QUEUE','PUBLISH'].includes(span.phase)){
        const predicted=cost.phaseCosts?.[span.phase];if(typeof predicted==='number'&&Number.isFinite(predicted)&&predicted>=0)span.predictedMs=predicted;
      }
    }
    const analysis=analyzeTrace(spans);
    return {traceId,spans,analysis,causality,decisions:jobs.map(job=>({attemptId:job.id,nodeId:job.d.offer.task.nodeId,targetId:job.d.offer.target.targetId,candidateCount:job.d.decisionEvidence?.candidateCount??null,snapshotVersion:job.d.decisionEvidence?.snapshotVersion??null})),coverage:{sourceSdkRoot:!!root,sourceDurationMs:root?.span.durationMs??null,criticalPathPending:!root||!causality.complete||analysis.status!=='COMPLETE',
      reasonCode:!root?'SOURCE_SDK_ROOT_NOT_RECORDED':!causality.complete?'CRITICAL_PATH_DEPENDENCIES_INCOMPLETE':analysis.status!=='COMPLETE'?'CLOCK_OR_MEASUREMENT_INCOMPLETE':'MEASURED_CAUSAL_TRACE_COMPLETE'}};
  }
}

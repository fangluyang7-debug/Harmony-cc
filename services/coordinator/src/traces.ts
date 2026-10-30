import { PrismaClient } from '../generated/client';
import { TraceSpanV2, validTraceSpanV2, analyzeTrace, canonical, protocolId } from '@harmony/scheduler-core';
import type { Peer } from './channel';
export class TraceService {
  constructor(private readonly db:PrismaClient){}
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
      }
    });
  }
  async read(peer:Peer,traceId:string){
    if(!protocolId(traceId))throw Error('TRACE_INVALID');
    const rows=(await this.db.traceSpan.findMany({where:{groupId:peer.groupId}})).map(r=>JSON.parse(r.metadataJson)).filter(r=>r.span.traceId===traceId);
    if(!rows.length||rows.some(r=>!r.readers.includes(peer.principalId)))throw Error('TRACE_UNAUTHORIZED');
    const spans:TraceSpanV2[]=rows.map(r=>r.span).sort((a,b)=>a.spanId.localeCompare(b.spanId));return {traceId,spans,analysis:analyzeTrace(spans)};
  }
}

import {TraceSpanV2} from './protocol-v2';
import {protocolId} from './protocol-v1';

/** Evidence is supplied by the authenticated coordinator's durable records. */
export interface TraceJobEvidence {attemptId:string;dispatched:boolean;parents:string[];missingParent:boolean;unsplitTransfer:boolean;}
export interface TraceTransferEvidence {id:string;attemptId:string;producerAttemptId:string;producerHolderId:string;senderHolderId:string;receiverHolderId:string;refKey:string;}
export interface TraceCausality {complete:boolean;links:{beforeSpanId:string;afterSpanId:string;reason:string}[];missing:string[];}
export function projectTraceCausality(recorded:readonly TraceSpanV2[],rootId:string|null,jobs:TraceJobEvidence[],transfers:TraceTransferEvidence[]){
  const spans=recorded.map(s=>({...s,dependsOn:[...s.dependsOn]})),byId=new Map(spans.map(s=>[s.spanId,s])),root=rootId?byId.get(rootId):undefined;
  const missing=new Set<string>(),links:TraceCausality['links']=[];
  if(!root)missing.add('SOURCE_SDK_ROOT_NOT_RECORDED');
  else for(const s of spans)if(s!==root&&s.parentSpanId===null){
    if(s.workflowId===root.workflowId)s.parentSpanId=root.spanId;else missing.add('ROOT_WORKFLOW_SCOPE_CONFLICT');
  }
  const add=(before:TraceSpanV2|undefined,after:TraceSpanV2|undefined,reason:string)=>{
    if(!before||!after){missing.add(reason+'_SPAN_MISSING');return;}
    if(before.spanId===after.spanId)return;
    if(!after.dependsOn.includes(before.spanId)){
      if(after.dependsOn.length>=64){missing.add('CAUSAL_DEPENDENCY_LIMIT');return;}after.dependsOn.push(before.spanId);
    }
    if(!links.some(l=>l.beforeSpanId===before.spanId&&l.afterSpanId===after.spanId))links.push({beforeSpanId:before.spanId,afterSpanId:after.spanId,reason});
  };
  const phase=(attempt:string,name:string)=>{
    const found=spans.filter(s=>s.attemptId===attempt&&s.phase===name&&s.spanId!==rootId);
    if(found.length>1)missing.add('PHASE_AMBIGUOUS');return found.length===1?found[0]:undefined;
  };
  for(const job of jobs){
    if(job.unsplitTransfer)missing.add('LEGACY_DATA_TRANSFER_NOT_SPLIT');
    if(!job.dispatched)continue;
    const plan=phase(job.attemptId,'PLAN'),queue=phase(job.attemptId,'QUEUE'),offer=phase(job.attemptId,'OFFER');
    add(plan,queue,'PLAN_BEFORE_DISPATCH');if(offer)add(plan,offer,'PLAN_BEFORE_OFFER');
    const sequence=['QUEUE','ADMIT','LOAD','EXECUTE','PUBLISH'].map(p=>phase(job.attemptId,p));
    if(sequence.some(s=>!s))missing.add('EXECUTION_PHASE_NOT_RECORDED');
    for(let i=1;i<sequence.length;i++)if(sequence[i]&&sequence[i-1]&&!sequence[i]!.dependsOn.includes(sequence[i-1]!.spanId))missing.add('EXECUTION_SEQUENCE_MISSING');
    if(job.missingParent)missing.add('COMMITTED_PARENT_NOT_RECORDED');
    for(const parent of job.parents)add(phase(parent,'PUBLISH'),plan??queue,'COMMITTED_DEPENDENCY');
  }
  for(const t of transfers){
    const tx=spans.find(s=>s.transferId===t.id&&s.phase==='TRANSFER_SEND'),rx=spans.find(s=>s.transferId===t.id&&s.phase==='TRANSFER_RECV');
    if(!tx)missing.add('TRANSFER_SENDER_NOT_RECORDED');if(!rx)missing.add('TRANSFER_RECEIVER_NOT_RECORDED');
    const published=phase(t.producerAttemptId,'PUBLISH');
    if(tx)add(published,tx,'COMMITTED_OUTPUT_BEFORE_TRANSFER');if(rx)add(published,rx,'COMMITTED_OUTPUT_BEFORE_TRANSFER');
    // Verified bytes precede the receipt that permits dispatch. A sender's full
    // HTTP interval also includes the response, so it is NOT a predecessor.
    if(rx&&jobs.some(j=>j.attemptId===t.attemptId&&j.dispatched))add(rx,phase(t.attemptId,'QUEUE'),'VERIFIED_INPUT_BEFORE_DISPATCH');
    if(tx){
      // A forwarded copy has an earlier verified receive on this process clock.
      // No absolute clocks or arbitrary same-hash replicas are joined.
      const prior=transfers.filter(p=>p.id!==t.id&&p.receiverHolderId===t.senderHolderId&&p.producerAttemptId===t.producerAttemptId&&p.refKey===t.refKey)
        .map(p=>spans.find(s=>s.transferId===p.id&&s.phase==='TRANSFER_RECV')).filter((s):s is TraceSpanV2=>!!s&&s.clockDomainId===tx.clockDomainId&&s.endMono<=tx.startMono)
        .sort((a,b)=>b.endMono-a.endMono)[0];
      if(prior){add(prior,tx,'CONFIRMED_COPY_BEFORE_FORWARD');if(rx)add(prior,rx,'CONFIRMED_COPY_BEFORE_FORWARD');}
      else if(t.senderHolderId!==t.producerHolderId)missing.add('FORWARDED_COPY_LINK_NOT_RECORDED');
    }
  }
  const causality:TraceCausality={complete:missing.size===0,links:links.sort((a,b)=>a.afterSpanId.localeCompare(b.afterSpanId)||a.beforeSpanId.localeCompare(b.beforeSpanId)),missing:[...missing].sort()};
  return {spans,causality};
}
export function validTraceCausality(value:TraceCausality,spans:readonly TraceSpanV2[]){
  const exact=(v:any,keys:string[])=>v&&Object.keys(v).sort().join('|')===keys.sort().join('|');
  return exact(value,['complete','links','missing'])&&typeof value.complete==='boolean'&&Array.isArray(value.missing)&&value.missing.length<=128&&value.missing.every(protocolId)&&value.complete===(value.missing.length===0)&&
    Array.isArray(value.links)&&value.links.length<=16384&&value.links.every(l=>exact(l,['beforeSpanId','afterSpanId','reason'])&&[l.beforeSpanId,l.afterSpanId,l.reason].every(protocolId)&&
      l.beforeSpanId!==l.afterSpanId&&spans.some(s=>s.spanId===l.beforeSpanId)&&spans.some(s=>s.spanId===l.afterSpanId&&s.dependsOn.includes(l.beforeSpanId)));
}

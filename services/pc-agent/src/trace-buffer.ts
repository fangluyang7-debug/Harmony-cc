import { TraceSpanV2, validTraceSpanV2 } from '@harmony/scheduler-core';
/** Telemetry is bounded and independent from critical ledger/outbox transactions. */
export class TraceBuffer {
  private pending:TraceSpanV2[]=[];private sending=false;dropped=0;
  emit(span:TraceSpanV2){if(!validTraceSpanV2(span))throw Error('TRACE_INVALID');if(this.pending.length>=256){this.dropped++;return;}this.pending.push(structuredClone(span));}
  async flush(send:(batch:TraceSpanV2[])=>Promise<void>){
    if(this.sending)return;this.sending=true;
    const batch=this.pending.splice(0,128);try{if(batch.length)await send(batch);}catch{const all=[...batch,...this.pending];this.pending=all.slice(0,256);this.dropped+=Math.max(0,all.length-256);}finally{this.sending=false;}
  }
}

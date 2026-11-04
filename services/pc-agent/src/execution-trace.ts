import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { DispatchOfferV2, TraceSpanV2 } from '@harmony/scheduler-core';
import { TraceBuffer } from './trace-buffer';

export interface TraceContext { traceId:string;parentSpanId:string|null;snapshotVersion:number;deviceInstanceId:string; }
export const pcTraceClockDomainId=randomUUID();
/** Local intervals only. The SDK owns the end-to-end root and transports own authoritative transfer spans. */
export class ExecutionTrace {
  private previous:string|null=null;
  private activeSpan:string|null=null;
  constructor(private readonly buffer:TraceBuffer,private readonly context:TraceContext,private readonly offer:DispatchOfferV2){}
  begin(phase:string,spanId=randomUUID()){
    const startMono=performance.now();let finished=false;
    return (reasonCode:string|null=null)=>{
      if(finished)return;finished=true;
      const endMono=performance.now();
      const span:TraceSpanV2={...this.context,spanId,dependsOn:this.previous?[this.previous]:[],transferId:null,
        workflowId:this.offer.task.workflowId,nodeId:this.offer.task.nodeId,attemptId:this.offer.task.attemptId,targetId:this.offer.target.targetId,
        phase,durationMs:endMono-startMono,predictedMs:null,reasonCode,startMono,endMono,clockDomainId:pcTraceClockDomainId,measurementScope:'LOCAL_INTERVAL',authoritativeSide:'SELF'};
      // Telemetry must not prevent execution or alter settlement.
      try{this.buffer.emit(span);this.previous=spanId;}catch{this.buffer.dropped++;}
    };
  }
  async segment<T>(phase:string,work:()=>Promise<T>):Promise<T>{
    const id=randomUUID(),parent=this.activeSpan,end=this.begin(phase,id);this.activeSpan=id;
    try{const result=await work();end();return result;}catch(error){end('PHASE_FAILED');throw error;}finally{this.activeSpan=parent;}
  }
  /** One local HTTP request, including response and integrity validation. Never records tickets. */
  async transfer<T>(operation:'READ'|'WRITE',work:()=>Promise<T>):Promise<T>{
    const parentSpanId=this.activeSpan,startMono=performance.now(),spanId=randomUUID();let reasonCode:string|null=null;
    try{return await work();}catch(error){reasonCode='PHASE_FAILED';throw error;}
    finally{
      const endMono=performance.now(),side=operation==='READ'?'RECEIVER':'SENDER';
      const span:TraceSpanV2={...this.context,spanId,parentSpanId,dependsOn:[],transferId:spanId,
        workflowId:this.offer.task.workflowId,nodeId:this.offer.task.nodeId,attemptId:this.offer.task.attemptId,targetId:this.offer.target.targetId,
        phase:operation==='READ'?'TRANSFER_RECV':'TRANSFER_SEND',durationMs:endMono-startMono,predictedMs:null,
        reasonCode:reasonCode??'RELAY_HTTP_ROUND_TRIP',startMono,endMono,clockDomainId:pcTraceClockDomainId,
        measurementScope:'FULL_TRANSFER',authoritativeSide:side};
      try{this.buffer.emit(span);}catch{this.buffer.dropped++;}
    }
  }

}

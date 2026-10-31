import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { DispatchOfferV2, TraceSpanV2 } from '@harmony/scheduler-core';
import { TraceBuffer } from './trace-buffer';

export interface TraceContext { traceId:string;parentSpanId:string|null;snapshotVersion:number;deviceInstanceId:string; }
const clockDomainId=randomUUID();
/** Local intervals only. The SDK owns the end-to-end root and transports own authoritative transfer spans. */
export class ExecutionTrace {
  private previous:string|null=null;
  constructor(private readonly buffer:TraceBuffer,private readonly context:TraceContext,private readonly offer:DispatchOfferV2){}
  begin(phase:string){
    const startMono=performance.now();let finished=false;
    return (reasonCode:string|null=null)=>{
      if(finished)return;finished=true;
      const endMono=performance.now(),spanId=randomUUID();
      const span:TraceSpanV2={...this.context,spanId,dependsOn:this.previous?[this.previous]:[],transferId:null,
        workflowId:this.offer.task.workflowId,nodeId:this.offer.task.nodeId,attemptId:this.offer.task.attemptId,targetId:this.offer.target.targetId,
        phase,durationMs:endMono-startMono,predictedMs:null,reasonCode,startMono,endMono,clockDomainId,measurementScope:'LOCAL_INTERVAL',authoritativeSide:'SELF'};
      // Telemetry must not prevent execution or alter settlement.
      try{this.buffer.emit(span);this.previous=spanId;}catch{this.buffer.dropped++;}
    };
  }
  async segment<T>(phase:string,work:()=>Promise<T>):Promise<T>{
    const end=this.begin(phase);try{const result=await work();end();return result;}catch(error){end('PHASE_FAILED');throw error;}
  }
}

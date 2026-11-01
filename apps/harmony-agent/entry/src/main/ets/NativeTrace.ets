import { DispatchOfferV2, TraceSpanV2, validTraceSpanV2 } from 'scheduler';
import { monotonic, factory } from './NativePlatform';
const clockDomain=factory.id();
export class NativeTrace {
 readonly spans:TraceSpanV2[]=[];
 private offer:DispatchOfferV2;
 private traceId:string;
 private snapshotVersion:number;
 private instance:string;
 constructor(offer:DispatchOfferV2,traceId:string,snapshotVersion:number,instance:string){this.offer=offer;this.traceId=traceId;this.snapshotVersion=snapshotVersion;this.instance=instance;}
 add(phase:string,startMono:number,endMono:number,reasonCode:string|null=null):void{
  const span:TraceSpanV2={traceId:this.traceId,parentSpanId:null,snapshotVersion:this.snapshotVersion,deviceInstanceId:this.instance,spanId:factory.id(),dependsOn:this.spans.length?[this.spans[this.spans.length-1].spanId]:[],transferId:null,
   workflowId:this.offer.task.workflowId,nodeId:this.offer.task.nodeId,attemptId:this.offer.task.attemptId,targetId:this.offer.target.targetId,phase,durationMs:endMono-startMono,predictedMs:null,reasonCode,startMono,endMono,clockDomainId:clockDomain,measurementScope:'LOCAL_INTERVAL',authoritativeSide:'SELF'};
  if(validTraceSpanV2(span))this.spans.push(span);
 }
 async segment<T>(phase:string,work:()=>Promise<T>):Promise<T>{const start=monotonic();try{const result=await work();this.add(phase,start,monotonic());return result;}catch(e){this.add(phase,start,monotonic(),'PHASE_FAILED');throw e as Error;}}
}

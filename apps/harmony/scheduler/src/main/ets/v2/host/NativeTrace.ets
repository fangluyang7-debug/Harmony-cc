import { DispatchOfferV2 } from '../protocol/ResourcesV2';
import { TraceSpanV2, validTraceSpanV2 } from '../protocol/SchedulingProtocolV2';
import { monotonic, factory } from './NativePlatform';
const clockDomain=factory.id();
export class NativeTrace {
 readonly spans:TraceSpanV2[]=[];
 private transfers:TraceSpanV2[]=[];
 private previous:string|null=null;
 private offer:DispatchOfferV2;
 private traceId:string;
 private snapshotVersion:number;
 private instance:string;
 constructor(offer:DispatchOfferV2,traceId:string,snapshotVersion:number,instance:string){this.offer=offer;this.traceId=traceId;this.snapshotVersion=snapshotVersion;this.instance=instance;}
 add(phase:string,startMono:number,endMono:number,reasonCode:string|null=null):void{
  const span:TraceSpanV2={traceId:this.traceId,parentSpanId:null,snapshotVersion:this.snapshotVersion,deviceInstanceId:this.instance,spanId:factory.id(),dependsOn:this.previous===null?[]:[this.previous],transferId:null,
   workflowId:this.offer.task.workflowId,nodeId:this.offer.task.nodeId,attemptId:this.offer.task.attemptId,targetId:this.offer.target.targetId,phase,durationMs:endMono-startMono,predictedMs:null,reasonCode,startMono,endMono,clockDomainId:clockDomain,measurementScope:'LOCAL_INTERVAL',authoritativeSide:'SELF'};
  if(validTraceSpanV2(span)){
   for(const transfer of this.transfers){transfer.parentSpanId=span.spanId;if(validTraceSpanV2(transfer))this.spans.push(transfer);}
   this.transfers=[];this.spans.push(span);this.previous=span.spanId;
  }
 }
 async transfer<T>(operation:string,work:()=>Promise<T>):Promise<T>{
  const startMono=monotonic();let reasonCode='RELAY_HTTP_ROUND_TRIP';
  try{return await work();}catch(e){reasonCode='PHASE_FAILED';throw e as Error;}
  finally{
   const endMono=monotonic(),id=factory.id();
   const span:TraceSpanV2={traceId:this.traceId,spanId:id,parentSpanId:null,dependsOn:[],transferId:id,
    workflowId:this.offer.task.workflowId,nodeId:this.offer.task.nodeId,attemptId:this.offer.task.attemptId,targetId:this.offer.target.targetId,
    snapshotVersion:this.snapshotVersion,deviceInstanceId:this.instance,phase:operation==='READ'?'TRANSFER_RECV':'TRANSFER_SEND',
    durationMs:endMono-startMono,predictedMs:null,reasonCode,startMono,endMono,clockDomainId:clockDomain,
    measurementScope:'FULL_TRANSFER',authoritativeSide:operation==='READ'?'RECEIVER':'SENDER'};
   if(validTraceSpanV2(span)&&this.transfers.length<16)this.transfers.push(span);
  }
 }
 async segment<T>(phase:string,work:()=>Promise<T>):Promise<T>{const start=monotonic();try{const result=await work();this.add(phase,start,monotonic());return result;}catch(e){this.add(phase,start,monotonic(),'PHASE_FAILED');throw e as Error;}}
}

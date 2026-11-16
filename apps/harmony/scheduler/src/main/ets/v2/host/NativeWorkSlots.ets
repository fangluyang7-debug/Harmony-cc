import { DispatchOfferV2 } from '../protocol/ResourcesV2';

interface WorkSlot {
 id:string;workflowId:string;nodeId:string;capability:string;backend:string;
 sourceDeviceId:string;phase:string;state:string;step:number;startedAt:number;
 updatedAt:number;elapsedMs:number;inputBytes:number|null;outputBytes:number|null;error:string;
}

/** Local, bounded display evidence. Never changes admission or waits for rendering. */
export class NativeWorkSlots {
 private rows:WorkSlot[]=[];
 private clock:()=>number;
 constructor(clock:()=>number){this.clock=clock;}
 begin(offer:DispatchOfferV2):void {
  if(this.rows.some(r=>r.id===offer.task.attemptId))return;
  if(this.rows.length>=32){const old=this.rows.findIndex(r=>r.state!=='RUNNING');if(old<0)return;this.rows.splice(old,1);}
  const now=this.clock();
  this.rows.push({id:offer.task.attemptId,workflowId:offer.task.workflowId,nodeId:offer.task.nodeId,
   capability:offer.task.contract.capability,backend:offer.target.backend,sourceDeviceId:offer.task.originDeviceId,
   phase:'RECEIVED',state:'RUNNING',step:0,startedAt:now,updatedAt:now,elapsedMs:0,inputBytes:null,outputBytes:null,error:''});
 }
 stage(id:string,phase:string,byteCount:number|null=null):void {
  const row=this.rows.find(r=>r.id===id);if(!row||row.state!=='RUNNING')return;
  const phases=['RECEIVED','QUEUE','LOAD','EXECUTE','PUBLISH'];const step=phases.indexOf(phase);
  if(step<row.step||step<0)return;
  row.phase=phase;row.step=step;row.updatedAt=this.clock();
  if(byteCount!==null&&Number.isFinite(byteCount)&&byteCount>=0){if(phase==='EXECUTE')row.inputBytes=byteCount;if(phase==='PUBLISH')row.outputBytes=byteCount;}
 }
 finish(id:string,state:string,error:string=''):void {
  const row=this.rows.find(r=>r.id===id);if(!row||row.state!=='RUNNING')return;
  row.state=state;row.error=error;row.updatedAt=this.clock();row.elapsedMs=Math.max(0,row.updatedAt-row.startedAt);
  if(state==='SUCCEEDED'){row.phase='COMPLETED';row.step=5;}
 }
 snapshot():string {
  const now=this.clock();
  return JSON.stringify(this.rows.map((r:WorkSlot):WorkSlot=>({id:r.id,workflowId:r.workflowId,nodeId:r.nodeId,capability:r.capability,backend:r.backend,sourceDeviceId:r.sourceDeviceId,
   phase:r.phase,state:r.state,step:r.step,startedAt:r.startedAt,updatedAt:r.updatedAt,elapsedMs:r.state==='RUNNING'?Math.max(0,now-r.startedAt):r.elapsedMs,inputBytes:r.inputBytes,outputBytes:r.outputBytes,error:r.error})));
 }
}

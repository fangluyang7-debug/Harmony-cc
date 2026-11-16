import {DispatchOfferV2} from '@harmony/scheduler-core';

/** Bounded, process-local read model. Image bytes travel separately, only once. */
export class ExecutionObserver {
 private enabled=false;private revision=0;private rows=new Map<string,any>();private runtime:any={};
 enable(runtime:any={}){this.enabled=true;this.runtime={...runtime};this.revision++;}
 setRuntime(runtime:any){if(this.enabled){Object.assign(this.runtime,runtime);this.revision++;}}
 has(id:string){return this.enabled&&this.rows.has(id);}
 observe(offer:DispatchOfferV2){
  if(!this.enabled||offer.reasonCode==='TRUSTED_REFERENCE'||this.rows.has(offer.task.attemptId))return;
  let p:any={};try{p=JSON.parse(offer.task.parameters);}catch{}
  const region=['x','y','width','height'].every(k=>Number.isFinite(p[k]))?{x:p.x,y:p.y,width:p.width,height:p.height}:null;
  const t=offer.task;this.rows.set(t.attemptId,{id:t.attemptId,workflowId:t.workflowId,nodeId:t.nodeId,capability:t.contract.capability,deviceId:offer.target.deviceId,originDeviceId:t.originDeviceId,
   backend:offer.target.backend,executorId:offer.target.executorId,region,phase:'RECEIVED',state:'QUEUED',receivedAt:Date.now(),updatedAt:Date.now(),input:{hash:t.inputs[0]?.contentHash,schema:t.inputs[0]?.schemaId},output:null,
   routes:offer.transferPlan.map(r=>({from:r.from,to:r.to,via:r.via})),timings:{},events:[]});
  while(this.rows.size>96){const old=[...this.rows.values()].find(r=>['SUCCEEDED','FAILED','REJECTED','CANCELLED_SETTLED'].includes(r.state));this.rows.delete(old?.id??this.rows.keys().next().value!);}
  this.update(t.attemptId,{},'收到调度任务');
 }
 update(id:string,fields:any,event?:string){if(!this.enabled)return;const r=this.rows.get(id);if(!r)return;Object.assign(r,fields,{updatedAt:Date.now()});if(event){r.events.push({at:r.updatedAt,event});r.events=r.events.slice(-24);}this.revision++;}
 phase(id:string,phase:string,done=false,durationMs?:number,failed=false){const r=this.rows.get(id);if(!r)return;
  if(done){r.timings[phase]=(r.timings[phase]??0)+(durationMs??0);this.update(id,{},phase+(failed?' 失败':' 完成'));}
  else this.update(id,{phase,state:phase==='QUEUE'?'QUEUED':phase==='EXECUTE'?'RUNNING':'ACCEPTED'},phase+' 开始');
 }
 input(id:string,bytes:number){const r=this.rows.get(id);if(r)this.update(id,{input:{...r.input,bytes,verified:true}},'输入哈希校验通过');}
 output(id:string,hash:string,bytes:number,schema:string){this.update(id,{output:{hash,bytes,schema},phase:'PUBLISH'},'计算完成，准备发布结果');}
 delivery(id:string,mode:string){this.update(id,{delivery:mode},mode==='RETAINED'?'结果暂存本机，供下游按需读取':mode==='RELAY'?'结果已上传协调中心中继':'结果已保留在源设备');}
 sent(id:string,peer:string,bytes:number,hash:string){const r=this.rows.get(id);if(!r)return;const sends=r.sends??[];if(!sends.some((s:any)=>s.peer===peer&&s.hash===hash)){sends.push({peer,bytes,hash,at:Date.now()});this.update(id,{sends:sends.slice(-16)},'下游已确认接收输出');}}
 snapshot(){return {version:1,revision:this.revision,observedAt:Date.now(),runtime:this.runtime,attempts:[...this.rows.values()].reverse()};}
}
export const executionObserver=new ExecutionObserver();

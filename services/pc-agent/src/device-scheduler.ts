import { DispatchOfferV2, ExecutionConfigV2, ExecutionReceiptV2, ResourceAmountV2, YieldNoticeV2, MicroQueue, QueuePolicy, canonical, occupiedV2 } from '@harmony/scheduler-core';
import { DurableLedger } from './durable-ledger';
import { PcExecutionRuntime } from './execution-runtime';
type Hooks=NonNullable<Parameters<PcExecutionRuntime['run']>[2]>;

interface Waiting {
  offer:DispatchOfferV2;config:ExecutionConfigV2;started:boolean;launching:boolean;cancelRequested:boolean;enqueuedAt:number;
  resolve:(value:ExecutionReceiptV2)=>void;reject:(reason:Error)=>void;done:Promise<ExecutionReceiptV2>;
  hooks:Hooks;
}
/** Queueing never reserves resources. Each launch still goes through the atomic ledger and trusted local authorization. */
export class DeviceScheduler {
  private readonly queue:MicroQueue;
  private readonly pending=new Map<string,Waiting>();
  private pumping=false;private closed=false;
  private ownerIdle=false;private limits:ResourceAmountV2[]=[];
  private readonly timer:NodeJS.Timeout;
  lastError:unknown=null;
  constructor(private readonly ledger:DurableLedger,private readonly runtime:PcExecutionRuntime,policy:QueuePolicy,
    private readonly notice:(notice:YieldNoticeV2)=>void,private readonly now:()=>number=Date.now){
    this.queue=new MicroQueue(ledger.snapshot().deviceId,policy);
    this.timer=setInterval(()=>{void this.pump().catch(error=>{this.lastError=error;});},250);this.timer.unref();
  }
  submit(offer:DispatchOfferV2,config:ExecutionConfigV2,hooks:Hooks={}){
    if(this.closed)throw Error('SCHEDULER_CLOSED');
    const previous=this.pending.get(offer.task.attemptId);
    if(previous){if(canonical(previous.offer)!==canonical(offer)||canonical(previous.config)!==canonical(config))throw Error('QUEUE_CONFLICT');return previous.done;}
    if(!offer.allowedConfigs.some(c=>canonical(c)===canonical(config)))throw Error('CONFIG_NOT_ALLOWED');
    const existing=this.ledger.status(offer.task.attemptId);
    if(existing){hooks.selected?.();return this.runtime.run(offer,config,hooks);} // Runtime verifies immutable offer and never reruns recovered attempts.
    this.queue.enqueue(offer,this.now());
    let resolve!:(v:ExecutionReceiptV2)=>void,reject!:(e:Error)=>void;
    const done=new Promise<ExecutionReceiptV2>((yes,no)=>{resolve=yes;reject=no;});
    this.pending.set(offer.task.attemptId,{offer:structuredClone(offer),config:structuredClone(config),started:false,launching:false,cancelRequested:false,enqueuedAt:this.now(),resolve,reject,done,hooks});
    void this.pump().catch(error=>{this.lastError=error;});return done;
  }
  /** Caller publishes fresh platform owner signal and limits. UNKNOWN is treated as ACTIVE. */
  update(limits:ResourceAmountV2[],owner:'IDLE'|'ACTIVE'|'UNKNOWN'){
    this.limits=structuredClone(limits);this.ownerIdle=owner==='IDLE';
    if(!this.ownerIdle)for(const notice of this.queue.ownerYield(this.now())){
      try{this.notice(notice);}catch(error){this.lastError=error;}finally{if(notice.kind==='RESTART')this.runtime.cancel(notice.attemptId);}
    }
    return this.pump();
  }
  cancel(id:string){
    const item=this.pending.get(id);if(!item)return;
    if(item.started)this.runtime.cancel(id);
    else if(item.launching)item.cancelRequested=true;
    else{this.queue.removeWaiting(id);this.pending.delete(id);item.reject(Error('CANCELLED_BEFORE_ADMISSION'));}
  }
  private async pump(){
    if(this.pumping||this.closed)return;this.pumping=true;
    try{
      for(const id of this.queue.expired(this.now())){const item=this.pending.get(id)!;this.queue.removeWaiting(id);this.pending.delete(id);item.reject(Error('QUEUE_STARVED'));}
      while(!this.closed){
        const offer=this.queue.choose(this.limits,occupiedV2(this.ledger.snapshot()),this.now(),this.ownerIdle);if(!offer)break;
        const item=this.pending.get(offer.task.attemptId)!;
        item.launching=true;
        item.hooks.selected?.();
        let released!:()=>void;const admitted=new Promise<void>(resolve=>{released=resolve;});
        const work=this.runtime.run(offer,item.config,{...item.hooks,admitted:()=>{item.started=true;this.queue.start(offer.task.attemptId,this.now());item.hooks.admitted?.();
          if(item.cancelRequested||this.closed||!this.ownerIdle)queueMicrotask(()=>this.runtime.cancel(offer.task.attemptId));released();},
          maxDurationMs:Math.max(1,offer.task.budget.remainingMs-(this.now()-item.enqueuedAt))});
        void work.then(item.resolve,item.reject).finally(()=>{
          // A failed settlement retains the queue and ledger reservation for recovery.
          if(item.started){if(this.ledger.status(offer.task.attemptId)?.resourcesSettled)this.queue.settle(offer.task.attemptId,this.now());}
          else this.queue.removeWaiting(offer.task.attemptId);
          this.pending.delete(offer.task.attemptId);released();void this.pump().catch(error=>{this.lastError=error;});
        }).catch(error=>{this.lastError=error;released();});
        // Do not select another task against capacity that admission has not reserved yet.
        await admitted;
      }
    }finally{this.pumping=false;}
  }
  credits(demands:ReadonlyMap<string,ResourceAmountV2[]>){return this.queue.credits(demands,this.limits,occupiedV2(this.ledger.snapshot()),this.ownerIdle);}
  async close(){this.closed=true;clearInterval(this.timer);const work=[...this.pending.values()].map(p=>p.done);for(const id of this.pending.keys())this.cancel(id);await Promise.allSettled(work);await this.runtime.close();}
}

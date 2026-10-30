import { DispatchOfferV2, ResourceAmountV2, YieldNoticeV2, validDispatchOfferV2, validResourceVectorV2 } from './resources-v2';
import { vectorFitsV2, vectorSumV2 } from './ledger-v2';

const categories=['ORIGIN_INTERACTIVE','REMOTE_INTERACTIVE','REMOTE_BATCH'];
export interface QueuePolicy {shares:number[];agingMs:number;maxConsecutive:number;yieldDeadlineMs:number;}
interface QueueEntry {offer:DispatchOfferV2;enqueuedAt:number;startedAt:number|null;}
/** Queue selection is advisory. The host must atomically admit through its durable resource ledger before start(). */
export class MicroQueue {
  private readonly entries=new Map<string,QueueEntry>();
  private readonly service=new Map<string,number[]>();
  private readonly streaks=new Map<string,{last:number;count:number}>();
  constructor(private readonly deviceId:string,private readonly policy:QueuePolicy){
    if(policy.shares.length!==3||policy.shares.some(n=>!Number.isFinite(n)||n<=0)||policy.shares.reduce((a,b)=>a+b,0)>1.000001||
      !Number.isFinite(policy.agingMs)||policy.agingMs<=0||!Number.isSafeInteger(policy.maxConsecutive)||policy.maxConsecutive<1||!Number.isFinite(policy.yieldDeadlineMs)||policy.yieldDeadlineMs<=0)throw Error('QUEUE_POLICY_INVALID');
  }
  enqueue(offer:DispatchOfferV2,now:number){
    if(!validDispatchOfferV2(offer)||!Number.isFinite(now)||now<0||offer.target.deviceId!==this.deviceId||
      offer.task.priority==='ORIGIN_INTERACTIVE'&&offer.task.originDeviceId!==this.deviceId)throw Error('QUEUE_INPUT_INVALID');
    if(this.entries.has(offer.task.attemptId))throw Error('QUEUE_DUPLICATE');
    if(this.entries.size>=256)throw Error('QUEUE_FULL');this.entries.set(offer.task.attemptId,{offer:JSON.parse(JSON.stringify(offer)),enqueuedAt:now,startedAt:null});
  }
  choose(limits:ResourceAmountV2[],occupied:ResourceAmountV2[],now:number,ownerIdle:boolean):DispatchOfferV2|null{
    if(!validResourceVectorV2(limits)||!validResourceVectorV2(occupied)||!Number.isFinite(now))throw Error('QUEUE_RESOURCE_INVALID');
    const candidates=[...this.entries.values()].filter(e=>e.startedAt===null&&now>=e.enqueuedAt&&now-e.enqueuedAt<e.offer.task.budget.remainingMs&&now<e.offer.task.budget.deadlineAt&&
      (ownerIdle||e.offer.task.priority==='ORIGIN_INTERACTIVE')&&vectorFitsV2(vectorSumV2(occupied,e.offer.resources),limits));
    if(!candidates.length)return null;
    const score=(e:QueueEntry)=>{
      const c=categories.indexOf(e.offer.task.priority),aged=Math.floor((now-e.enqueuedAt)/this.policy.agingMs);
      let debt=0,bounded=0;
      for(const demand of e.offer.resources){
        if(demand.amount===0)continue;
        const service=[...(this.service.get(demand.resourcePoolId)??[0,0,0])];
        for(const running of this.entries.values())if(running.startedAt!==null){
          const amount=running.offer.resources.find(r=>r.resourcePoolId===demand.resourcePoolId)?.amount??0;
          service[categories.indexOf(running.offer.task.priority)]+=amount*Math.max(0,now-running.startedAt);
        }
        // Normalize resource-time debt by pool capacity; CPU and RAM units cannot be added directly.
        const capacity=limits.find(r=>r.resourcePoolId===demand.resourcePoolId)!.amount;
        debt+=(service.reduce((a,b)=>a+b,0)*this.policy.shares[c]-service[c])/capacity;
        const streak=this.streaks.get(demand.resourcePoolId);
        if(streak&&streak.last===c&&streak.count>=this.policy.maxConsecutive)bounded=1;
      }
      return {c,aged,debt,bounded};
    };
    candidates.sort((a,b)=>{
      const x=score(a),y=score(b);
      return x.bounded-y.bounded||y.aged-x.aged||y.debt-x.debt||x.c-y.c||a.offer.task.budget.deadlineAt-b.offer.task.budget.deadlineAt||a.enqueuedAt-b.enqueuedAt||a.offer.task.attemptId.localeCompare(b.offer.task.attemptId);
    });
    return JSON.parse(JSON.stringify(candidates[0].offer));
  }
  start(id:string,now:number){const e=this.entries.get(id);if(!e||e.startedAt!==null||now<e.enqueuedAt)throw Error('QUEUE_NOT_READY');e.startedAt=now;
    const c=categories.indexOf(e.offer.task.priority);for(const r of e.offer.resources)if(r.amount>0){const old=this.streaks.get(r.resourcePoolId);this.streaks.set(r.resourcePoolId,{last:c,count:old?.last===c?old.count+1:1});}}
  settle(id:string,now:number){const e=this.entries.get(id);if(!e||e.startedAt===null||now<e.startedAt)throw Error('QUEUE_NOT_RUNNING');
    for(const r of e.offer.resources){const service=this.service.get(r.resourcePoolId)??[0,0,0];service[categories.indexOf(e.offer.task.priority)]+=(now-e.startedAt)*r.amount;this.service.set(r.resourcePoolId,service);}this.entries.delete(id);}
  expired(now:number){return [...this.entries.values()].filter(e=>e.startedAt===null&&(now-e.enqueuedAt>=e.offer.task.budget.remainingMs||now>=e.offer.task.budget.deadlineAt)).map(e=>e.offer.task.attemptId);}
  removeWaiting(id:string){const e=this.entries.get(id);if(!e||e.startedAt!==null)throw Error('QUEUE_RUNNING');this.entries.delete(id);}
  ownerYield(now:number):YieldNoticeV2[]{
    return [...this.entries.values()].filter(e=>e.startedAt!==null&&e.offer.task.priority!=='ORIGIN_INTERACTIVE').map(e=>{
      const contract=e.offer.task.contract,remaining=contract.maxNonPreemptibleMs===null?null:Math.max(0,contract.maxNonPreemptibleMs-(now-e.startedAt!));
      // A checkpoint notice needs a real persisted checkpoint. Until the adapter produces it, report draining.
      return {attemptId:e.offer.task.attemptId,kind:contract.interruptibility==='CANCEL_RESTART'?'RESTART':'DRAINING',
        releaseMs:{value:remaining,source:remaining===null?'UNKNOWN':'PRIOR',sampledAt:now,ttlMs:this.policy.yieldDeadlineMs,unit:'ms'},checkpoint:null,
        reasonCode:remaining===0?'RELEASE_OVERDUE':'OWNER_ACTIVE'};
    });
  }
  credits(demands:ReadonlyMap<string,ResourceAmountV2[]>,limits:ResourceAmountV2[],occupied:ResourceAmountV2[],ownerIdle:boolean){
    if(!validResourceVectorV2(limits)||!validResourceVectorV2(occupied))throw Error('QUEUE_RESOURCE_INVALID');
    return categories.map(priority=>{
      const required=demands.get(priority);let slots=0;
      if((ownerIdle||priority==='ORIGIN_INTERACTIVE')&&required&&validResourceVectorV2(required)&&required.some(r=>r.amount>0)){
        slots=Math.min(1024,...required.filter(r=>r.amount>0).map(r=>Math.max(0,Math.floor(((limits.find(p=>p.resourcePoolId===r.resourcePoolId)?.amount??0)-(occupied.find(p=>p.resourcePoolId===r.resourcePoolId)?.amount??0))/r.amount))));
      }
      return {priority,slots};
    });
  }
}

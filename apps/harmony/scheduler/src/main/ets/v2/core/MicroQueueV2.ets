import { CreditV2, QueuedFactV2, DispatchOfferV2, ResourceAmountV2, YieldNoticeV2, validDispatchOfferV2, validResourceVectorV2 } from '../protocol/ResourcesV2';
import { QueueSampleV2 } from '../protocol/SchedulingProtocolV2';
import { LedgerEntryV2, vectorFitsV2, vectorSumV2 } from './LedgerV2';

const categories=['ORIGIN_INTERACTIVE','REMOTE_INTERACTIVE','REMOTE_BATCH'];
export interface QueuePolicyV2 {shares:number[];agingMs:number;maxConsecutive:number;yieldDeadlineMs:number;maxQueueWaitMs?:number;}
export interface QueueCreditV2 {priority:string;slots:number;}
interface QueueScoreV2 {c:number;aged:number;debt:number;bounded:number;}
interface QueueStreakV2 {last:number;count:number;}
export interface QueueWaitEvidence {attemptId:string;reasonCode:string;resourcePoolIds:string[];}
/** Bounded local observations. Occupants are named only within this workflow. */
export class QueueHistory {
  readonly samples:QueueSampleV2[]=[];
  readonly reasons=new Set<string>();
  private tracked=new Set<string>();
  observe(atMono:number,reason:string,pools:string[],entries:LedgerEntryV2[],workflowId:string):void{
    if(reason!=='SELECTED')this.reasons.add(reason);
    if(this.samples.length===0&&reason==='SELECTED')return;
    const previous=this.samples[this.samples.length-1];
    if(previous?.reasonCode==='OBSERVATION_LIMIT')return;
    const occupied=entries.filter(e=>!e.record.resourcesSettled&&e.offer.task.workflowId===workflowId&&
      e.resources.some(r=>r.amount>0&&pools.includes(r.resourcePoolId))).map(e=>e.record.attemptId).sort();
    const settled=entries.filter(e=>e.record.resourcesSettled&&this.tracked.has(e.record.attemptId)).map(e=>e.record.attemptId).sort();
    const sample:QueueSampleV2={atMono,reasonCode:reason,resourcePoolIds:pools.slice().sort(),occupyingAttempts:occupied,settledAttempts:settled};
    if(previous&&previous.reasonCode===reason&&JSON.stringify(previous.resourcePoolIds)===JSON.stringify(sample.resourcePoolIds)&&
      JSON.stringify(previous.occupyingAttempts)===JSON.stringify(occupied)&&settled.length===0)return;
    if(this.samples.length>=8||pools.length>4||occupied.length>4||settled.length>4){
      this.samples.push({atMono,reasonCode:'OBSERVATION_LIMIT',resourcePoolIds:[],occupyingAttempts:[],settledAttempts:[]});return;
    }
    this.samples.push(sample);
    for(const id of occupied)this.tracked.add(id);
    for(const id of settled)this.tracked.delete(id);
  }
}
interface TimingMean {count:number;mean:number;at:number;}
interface QueueEntry {key:string;partner?:string;overlapEnd?:number;mixed?:boolean;overlapStart?:number;offer:DispatchOfferV2;enqueuedAt:number;startedAt:number|null;reason?:string;enqueuedMono:number;}
/** Queue selection is advisory. The host must atomically admit through its durable resource ledger before start(). */
export class MicroQueueV2 {
  private readonly solo=new Map<string,TimingMean>();
  private readonly pair=new Map<string,TimingMean>();
  private choiceTime=0;
  private timing(table:Map<string,TimingMean>,key:string,value:number,now:number):void{
    const old=table.get(key);
    if(old&&now-old.at<300000){old.mean=0.75*old.mean+0.25*value;old.count++;old.at=now;return;}
    if(!old&&table.size>=128)table.delete(Array.from(table.keys())[0]);
    table.set(key,{count:1,mean:value,at:now});
  }
  private shared(a:QueueEntry,b:QueueEntry):string[]{
    return a.offer.resources.filter(r=>r.amount>0&&b.offer.resources.some(x=>x.amount>0&&x.resourcePoolId===r.resourcePoolId)).map(r=>r.resourcePoolId);
  }
  private interference(e:QueueEntry,now:number):string[]{
    for(const other of Array.from(this.entries.values())){
      if(other.startedAt===null)continue;
      const pools=this.shared(e,other);
      if(!pools.length)continue;
      const forward=this.pair.get(JSON.stringify([e.key,other.key]));
      const reverse=this.pair.get(JSON.stringify([other.key,e.key]));
      if([forward,reverse].some(v=>v!==undefined&&v.count>=3&&v.mean>2&&now-v.at<60000))return pools;
    }
    return [];
  }
  private markOverlap(e:QueueEntry,other:QueueEntry,now:number):void{
    if(e.partner!==undefined){e.mixed=true;return;}
    e.partner=other.key;e.overlapStart=now;
  }
  private readonly entries=new Map<string,QueueEntry>();
  private readonly service=new Map<string,number[]>();
  private readonly streaks=new Map<string,QueueStreakV2>();
  private readonly deviceId:string;
  private readonly policy:QueuePolicyV2;
  private rows():QueueEntry[]{const rows:QueueEntry[]=[];this.entries.forEach((e:QueueEntry)=>rows.push(e));return rows;}
  constructor(deviceId:string,policy:QueuePolicyV2){
    this.deviceId=deviceId;this.policy=policy;
    if(policy.maxQueueWaitMs!==undefined&&(!Number.isSafeInteger(policy.maxQueueWaitMs)||policy.maxQueueWaitMs<1))throw Error('QUEUE_POLICY_INVALID');
    if(policy.shares.length!==3||policy.shares.some(n=>!Number.isFinite(n)||n<=0)||policy.shares.reduce((a,b)=>a+b,0)>1.000001||
      !Number.isFinite(policy.agingMs)||policy.agingMs<=0||!Number.isSafeInteger(policy.maxConsecutive)||policy.maxConsecutive<1||!Number.isFinite(policy.yieldDeadlineMs)||policy.yieldDeadlineMs<=0)throw Error('QUEUE_POLICY_INVALID');
  }
  enqueue(offer:DispatchOfferV2,now:number,mono:number=now){
    if(!validDispatchOfferV2(offer)||!Number.isFinite(now)||now<0||offer.target.deviceId!==this.deviceId||
      offer.task.priority==='ORIGIN_INTERACTIVE'&&offer.task.originDeviceId!==this.deviceId)throw Error('QUEUE_INPUT_INVALID');
    if(this.entries.has(offer.task.attemptId))throw Error('QUEUE_DUPLICATE');
    if(this.entries.size>=256)throw Error('QUEUE_FULL');const key=JSON.stringify([offer.target.targetId,offer.target.executorVersion,offer.task.contract.version,
      offer.task.parameters,offer.task.inputs.map(i=>i.contentHash),offer.allowedConfigs.map(c=>c.id)]);
    this.entries.set(offer.task.attemptId,{key,offer:JSON.parse(JSON.stringify(offer)) as DispatchOfferV2,enqueuedAt:now,enqueuedMono:mono,startedAt:null});
  }
  choose(limits:ResourceAmountV2[],occupied:ResourceAmountV2[],now:number,ownerIdle:boolean):DispatchOfferV2|null{
    if(!validResourceVectorV2(limits)||!validResourceVectorV2(occupied)||!Number.isFinite(now))throw Error('QUEUE_RESOURCE_INVALID');
    this.choiceTime=now;
    const candidates=this.rows().filter(e=>e.startedAt===null&&now>=e.enqueuedAt&&now-e.enqueuedAt<e.offer.task.budget.remainingMs&&now<e.offer.task.budget.deadlineAt&&
      (ownerIdle||e.offer.task.priority==='ORIGIN_INTERACTIVE')&&vectorFitsV2(vectorSumV2(occupied,e.offer.resources),limits)&&this.interference(e,now).length===0);
    if(!candidates.length)return null;
    const score=(e:QueueEntry):QueueScoreV2=>{
      const c=categories.indexOf(e.offer.task.priority),aged=Math.floor((now-e.enqueuedAt)/this.policy.agingMs);
      let debt=0,bounded=0;
      for(const demand of e.offer.resources){
        if(demand.amount===0)continue;
        const service=[...(this.service.get(demand.resourcePoolId)??[0,0,0])];
        for(const running of this.rows())if(running.startedAt!==null){
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
    return JSON.parse(JSON.stringify(candidates[0].offer)) as DispatchOfferV2;
  }
  noteWait(attemptId:string,reason:string):void{const row=this.entries.get(attemptId);if(row)row.reason=reason;}
  queuedFacts(now:number,sampledAt:number,domain:string):QueuedFactV2[]|undefined{
    const facts:QueuedFactV2[]=[];
    this.entries.forEach((e:QueueEntry)=>{
      if(e.startedAt!==null)return;
      facts.push({attemptId:e.offer.task.attemptId,targetId:e.offer.target.targetId,resources:e.offer.resources,priority:e.offer.task.priority,
        reason:e.reason??'QUEUE_WAIT_UNKNOWN',elapsed:{value:Math.max(0,now-e.enqueuedMono),unit:'ms',source:domain==='REAL'?'MEASURED':'SIMULATED',sampledAt,ttlMs:15000}});
    });
    return facts.length<=32?facts:undefined;
  }
  /** Observations only: no reservation, selection, or predicted release. */
  waitingReasons(limits:ResourceAmountV2[],occupied:ResourceAmountV2[],ownerIdle:boolean,selectedId:string|null):QueueWaitEvidence[]{
    if(!validResourceVectorV2(limits)||!validResourceVectorV2(occupied))throw Error('QUEUE_RESOURCE_INVALID');
    return this.rows().filter(e=>e.startedAt===null&&e.offer.task.attemptId!==selectedId).map((e:QueueEntry):QueueWaitEvidence=>{
      const pools=vectorSumV2(occupied,e.offer.resources).filter(r=>r.amount>(limits.find(l=>l.resourcePoolId===r.resourcePoolId)?.amount??0)&&e.offer.resources.some(d=>d.resourcePoolId===r.resourcePoolId&&d.amount>0)).map(r=>r.resourcePoolId);
      const interference=pools.length?[] as string[]:this.interference(e,this.choiceTime);
      return {attemptId:e.offer.task.attemptId,reasonCode:!ownerIdle&&e.offer.task.priority!=='ORIGIN_INTERACTIVE'?'OWNER_ACTIVE':pools.length?'RESOURCE_CAPACITY':interference.length?'SHARED_POOL_INTERFERENCE':selectedId!==null?'LOCAL_QUEUE_POLICY':'QUEUE_WAIT_UNKNOWN',resourcePoolIds:pools.length?pools:interference};
    });
  }
  start(id:string,now:number){const e=this.entries.get(id);if(!e||e.startedAt!==null||now<e.enqueuedAt)throw Error('QUEUE_NOT_READY');
    for(const other of Array.from(this.entries.values())){
      if(other.startedAt===null||!this.shared(e,other).length)continue;
      this.markOverlap(e,other,now);this.markOverlap(other,e,now);
    }
    e.startedAt=now;
    const c=categories.indexOf(e.offer.task.priority);for(const r of e.offer.resources)if(r.amount>0){const old=this.streaks.get(r.resourcePoolId);this.streaks.set(r.resourcePoolId,{last:c,count:old?.last===c?old.count+1:1});}}
  settle(id:string,now:number,success:boolean=false){const e=this.entries.get(id);if(!e||e.startedAt===null||now<e.startedAt)throw Error('QUEUE_NOT_RUNNING');
    const duration=now-e.startedAt;
    if(success&&duration>0){
      if(e.partner===undefined)this.timing(this.solo,e.key,duration,now);
      else if(!e.mixed&&e.overlapStart!==undefined&&(e.overlapEnd??now)-e.overlapStart>=duration/2){
        const solo=this.solo.get(e.key);
        if(solo&&solo.count>=5&&now-solo.at<300000)this.timing(this.pair,JSON.stringify([e.key,e.partner]),Math.min(4,duration/solo.mean),now);
      }
    }
    for(const other of Array.from(this.entries.values())){
      if(other!==e&&other.startedAt!==null&&other.partner===e.key&&other.overlapEnd===undefined&&this.shared(e,other).length)other.overlapEnd=now;
    }
    for(const r of e.offer.resources){const service=this.service.get(r.resourcePoolId)??[0,0,0];service[categories.indexOf(e.offer.task.priority)]+=(now-e.startedAt)*r.amount;this.service.set(r.resourcePoolId,service);}this.entries.delete(id);}
  expired(now:number){return this.rows().filter(e=>e.startedAt===null&&(now-e.enqueuedAt>=Math.min(this.policy.maxQueueWaitMs??5000,e.offer.task.budget.remainingMs)||now>=e.offer.task.budget.deadlineAt)).map(e=>e.offer.task.attemptId);}
  removeWaiting(id:string){const e=this.entries.get(id);if(!e||e.startedAt!==null)throw Error('QUEUE_RUNNING');this.entries.delete(id);}
  ownerYield(now:number):YieldNoticeV2[]{
    return this.rows().filter(e=>e.startedAt!==null&&e.offer.task.priority!=='ORIGIN_INTERACTIVE').map((e:QueueEntry):YieldNoticeV2=>{
      const contract=e.offer.task.contract,remaining=contract.maxNonPreemptibleMs===null?null:Math.max(0,contract.maxNonPreemptibleMs-(now-e.startedAt!));
      // A checkpoint notice needs a real persisted checkpoint. Until the adapter produces it, report draining.
      return {attemptId:e.offer.task.attemptId,kind:contract.interruptibility==='CANCEL_RESTART'?'RESTART':'DRAINING',
        releaseMs:{value:remaining,source:remaining===null?'UNKNOWN':'PRIOR',sampledAt:now,ttlMs:this.policy.yieldDeadlineMs,unit:'ms'},checkpoint:null,
        reasonCode:remaining===0?'RELEASE_OVERDUE':'OWNER_ACTIVE'};
    });
  }
  /** A category may accept any compatible target. Never combine free slots from different targets. */
  capacityCredits(demands:ResourceAmountV2[][],limits:ResourceAmountV2[],occupied:ResourceAmountV2[],ownerIdle:boolean):CreditV2[]{
    const result=categories.map((priority:string):CreditV2=>({priority,slots:0}));
    for(const demand of demands){
      const byCategory=new Map<string,ResourceAmountV2[]>();
      for(const priority of categories)byCategory.set(priority,demand);
      const available=this.credits(byCategory,limits,occupied,ownerIdle);
      for(let i=0;i<result.length;i++)result[i].slots=Math.max(result[i].slots,available[i].slots);
    }
    return result;
  }
  credits(demands:Map<string,ResourceAmountV2[]>,limits:ResourceAmountV2[],occupied:ResourceAmountV2[],ownerIdle:boolean){
    if(!validResourceVectorV2(limits)||!validResourceVectorV2(occupied))throw Error('QUEUE_RESOURCE_INVALID');
    return categories.map((priority:string):QueueCreditV2=>{
      const required=demands.get(priority);let slots=0;
      if((ownerIdle||priority==='ORIGIN_INTERACTIVE')&&required&&validResourceVectorV2(required)&&required.some(r=>r.amount>0)){
        slots=Math.min(1024,...required.filter(r=>r.amount>0).map(r=>Math.max(0,Math.floor(((limits.find(p=>p.resourcePoolId===r.resourcePoolId)?.amount??0)-(occupied.find(p=>p.resourcePoolId===r.resourcePoolId)?.amount??0))/r.amount))));
      }
      return {priority,slots};
    });
  }
}

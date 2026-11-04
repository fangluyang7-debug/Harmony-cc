import {DeviceProfileV2, ExecutorV2, NumericSampleV2, sampleUsableV2} from './resources-v2';

export interface AvailabilityEstimate {
  targetId:string; snapshotVersion:number; poolIds:string[]; reason:string;
  blockingReason?:'NON_INTERRUPTIBLE_RUNNING'|'RELEASE_OVERDUE';
  resourceWait:NumericSampleV2; policyWait:NumericSampleV2;
}

/** Local holder forecast only. Physical shared capacity and atomic admission remain independent gates. */
export function availability(profile:DeviceProfileV2,e:ExecutorV2,priority:string,version:number,now:number):AvailabilityEstimate {
  let wait:number|null=0,expires=Infinity,blocked=false,priorCapacity=false;
  let blockingReason:AvailabilityEstimate['blockingReason'];
  for(const demand of e.resources.filter(r=>r.amount>0)){
    const pool=profile.pools.find(p=>p.resourcePoolId===demand.resourcePoolId);
    if(!pool||![pool.occupied,pool.admissionLimit].every(s=>sampleUsableV2(s,now,profile.domain))){
      blocked=true;wait=null;break;
    }
    priorCapacity=priorCapacity||pool.occupied.source==='PRIOR'||pool.admissionLimit.source==='PRIOR';
    expires=Math.min(expires,pool.occupied.sampledAt+pool.occupied.ttlMs,pool.admissionLimit.sampledAt+pool.admissionLimit.ttlMs);
    const deficit=demand.amount+pool.occupied.value!-pool.admissionLimit.value!;
    if(deficit<=0)continue;
    blocked=true;
    for(const fact of profile.inFlight??[]){
      if(!fact.resources.some(r=>r.resourcePoolId===demand.resourcePoolId&&r.amount>0))continue;
      const contract=profile.executors.find(x=>x.target.targetId===fact.targetId)?.contract;
      if(contract?.interruptibility!=='NON_INTERRUPTIBLE')continue;
      if(contract.maxNonPreemptibleMs!==null&&sampleUsableV2(fact.elapsed,now,profile.domain)&&fact.elapsed.value!>contract.maxNonPreemptibleMs){
        blockingReason='RELEASE_OVERDUE';break;
      }
      blockingReason='NON_INTERRUPTIBLE_RUNNING';
    }
    if(blockingReason==='RELEASE_OVERDUE'){wait=null;break;}
    const releases=(profile.inFlight??[]).map(f=>({amount:f.resources.find(r=>r.resourcePoolId===demand.resourcePoolId)?.amount??0,s:f.remaining})).filter(r=>r.amount>0);
    if(releases.reduce((sum,r)=>sum+r.amount,0)!==pool.occupied.value!){wait=null;break;}
    const known=releases.filter(r=>sampleUsableV2(r.s,now,profile.domain)&&r.s.value!>now-r.s.sampledAt)
      .sort((a,b)=>(a.s.sampledAt+a.s.value!)-(b.s.sampledAt+b.s.value!));
    let freed=0;
    for(const r of known){
      freed+=r.amount;expires=Math.min(expires,r.s.sampledAt+r.s.ttlMs,r.s.sampledAt+r.s.value!);
      if(freed>=deficit){wait=Math.max(wait,r.s.sampledAt+r.s.value!-now);break;}
    }
    if(freed<deficit){wait=null;break;}
  }
  // Existing queued work has no reservation or observed completion forecast.
  const queued=profile.queued?.some(q=>q.resources.some(r=>r.amount>0&&e.resources.some(d=>d.amount>0&&d.resourcePoolId===r.resourcePoolId)));
  const credit=profile.credits.some(c=>c.priority===priority&&c.slots>0);
  return {targetId:e.target.targetId,snapshotVersion:version,poolIds:[...e.target.resourcePoolIds],...(blockingReason?{blockingReason}:{}),
    reason:blocked?'RESOURCE_CAPACITY':queued?'LOCAL_QUEUE_PENDING':credit?'AVAILABLE':'NO_CATEGORY_CREDIT',
    resourceWait:{value:wait,source:wait===null?'UNKNOWN':blocked||priorCapacity?'PRIOR':profile.domain==='REAL'?'MEASURED':'SIMULATED',unit:'ms',
      sampledAt:now,ttlMs:Math.max(1,Math.min(15000,expires-now))},
    policyWait:credit&&!queued?e.queue:{value:null,source:'UNKNOWN',unit:'ms',sampledAt:now,ttlMs:1}};
}

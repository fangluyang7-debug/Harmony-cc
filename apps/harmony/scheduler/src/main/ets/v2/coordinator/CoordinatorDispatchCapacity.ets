import { DeviceProfileV2, ExecutorV2, sampleUsableV2 } from '../protocol/ResourcesV2';
/** A queue permit does not reserve running GPU resources; the holder admits atomically. */
export function nativeGpuQueueAllowed(profile:DeviceProfileV2,executor:ExecutorV2,activeIds:string[],finishMs:number,budgetMs:number,now:number):boolean{
 if(!['CUDA','VULKAN'].includes(executor.target.backend)||executor.contract.sideEffectPolicy!=='PURE'||executor.contract.interruptibility!=='CANCEL_RESTART'||profile.queued===undefined||profile.inFlight===undefined||!Number.isFinite(finishMs)||finishMs<0||finishMs>=budgetMs)return false;
 let slots=8,hasGpu=false;
 for(const demand of executor.resources){
  if(demand.amount<=0)continue;const pool=profile.pools.find(p=>p.resourcePoolId===demand.resourcePoolId);
  if(!pool||pool.draining||!sampleUsableV2(pool.admissionLimit,now,'REAL')||pool.admissionLimit.value===null||pool.admissionLimit.value<demand.amount)return false;
  if(pool.kind==='GPU_SLOTS')hasGpu=true;
  slots=Math.min(slots,Math.floor(pool.admissionLimit.value/demand.amount));
 }
 const pending=new Set<string>([...activeIds,...profile.inFlight.map(f=>f.attemptId),...profile.queued.map(q=>q.attemptId)]);
 return hasGpu&&slots>0&&pending.size<Math.min(7,slots+3);
}

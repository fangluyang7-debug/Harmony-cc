import {canonical,DeviceProfileV2,sampleUsableV2} from '@harmony/scheduler-core';

export interface SettledAttempt {id:string;holderInstanceId:string;offerJson:string|null;recordJson:string|null;}

/** Derive current occupancy from an exact profile entry plus its durable settlement.
 * Never rewrite the reported profile or release capacity merely from an estimate. */
export function settledProfile(profile:DeviceProfileV2,rows:SettledAttempt[],now:number,domain:string):DeviceProfileV2{
 const flights=profile.inFlight;
 if(!flights||flights.some(f=>f.resources.some(r=>!profile.pools.some(p=>p.resourcePoolId===r.resourcePoolId))))return profile;
 const coherent=profile.pools.every(pool=>sampleUsableV2(pool.occupied,now,domain)&&
  flights.reduce((sum,f)=>sum+(f.resources.find(r=>r.resourcePoolId===pool.resourcePoolId)?.amount??0),0)===pool.occupied.value);
 if(!coherent)return profile;
 const settled=new Set<string>();
 for(const fact of [...flights,...(profile.queued??[])]){
  const row=rows.find(r=>r.id===fact.attemptId&&r.holderInstanceId===profile.holderInstanceId);
  if(!row?.recordJson||!row.offerJson)continue;
  const record=JSON.parse(row.recordJson),offer=JSON.parse(row.offerJson),receipt=record.receipt,fence=record.fence;
  if(record.resourcesSettled!==true||receipt?.resourcesSettled!==true||!fence||
   fence.deviceId!==profile.deviceId||fence.holderInstanceId!==profile.holderInstanceId||fence.ledgerEpoch!==profile.ledgerEpoch||
   canonical(receipt.fence)!==canonical(fence)||receipt.attemptId!==fact.attemptId||
   receipt.actualTarget?.targetId!==fact.targetId||offer.target?.targetId!==fact.targetId||
   offer.target?.deviceId!==profile.deviceId||canonical(offer.resources)!==canonical(fact.resources))continue;
  settled.add(fact.attemptId);
 }
 if(!settled.size)return profile;
 return {...profile,inFlight:flights.filter(f=>!settled.has(f.attemptId)),
  ...(profile.queued?{queued:profile.queued.filter(q=>!settled.has(q.attemptId))}:{}),
  pools:profile.pools.map(pool=>({...pool,occupied:{...pool.occupied,source:'PRIOR',value:pool.occupied.value!-
   flights.filter(f=>settled.has(f.attemptId)).reduce((sum,f)=>sum+(f.resources.find(r=>r.resourcePoolId===pool.resourcePoolId)?.amount??0),0)}}))};
}

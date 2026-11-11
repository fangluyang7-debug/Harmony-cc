import { workKeyV2 } from '../src/capability-cost-model';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RunTimings, newLedgerV2, requestGrantV2, installGrantV2, admitV2, occupiedV2, vectorSumV2, recoverLedgerV2 } from '../src/ledger-v2';
import { DispatchOfferV2, AllotmentGrantV2 } from '../src/resources-v2';
const load=(name:string)=>JSON.parse(readFileSync(resolve(__dirname,'../../../contracts/scheduling/v2/fixtures/t2/valid/'+name+'.json'),'utf8'));
const setup=()=>{
 const offer=load('DispatchOffer') as DispatchOfferV2,grant=load('AllotmentGrant') as AllotmentGrantV2;
 let state=newLedgerV2({groupId:'g1',deviceId:'device1',holderInstanceId:'h1',appInstanceId:null});state=requestGrantV2(state,'request1',0);state=installGrantV2(state,grant,true,0);
 return {state,grant,offer,context:{now:1,coordinatorEpoch:1,online:true,ownerIdle:true,admissionLimit:grant.extra,executionDigest:'a'.repeat(64),leaseId:'lease1'}};
};
test('dependency, authorization, owner and resource guards leave no partial reservation',()=>{
 const {state,offer,context}=setup();
 const blocked=JSON.parse(JSON.stringify(offer));blocked.dependencies=[{nodeId:'before',planRevision:1,committed:false}];
 expect(()=>admitV2(state,blocked,context)).toThrow('DEPENDENCY_UNCOMMITTED');
 expect(()=>admitV2(state,offer,{...context,ownerIdle:false})).toThrow('OWNER_ACTIVE');
 expect(()=>admitV2(state,offer,{...context,admissionLimit:[]})).toThrow('RESOURCE_UNAVAILABLE');
 const foreign=JSON.parse(JSON.stringify(offer));foreign.task.groupId='foreign';foreign.task.app.groupId='foreign';
 expect(()=>admitV2(state,foreign,context)).toThrow('TASK_UNAUTHORIZED');expect(occupiedV2(state)).toEqual([]);
 expect(()=>vectorSumV2([{resourcePoolId:'pool',amount:Number.MAX_SAFE_INTEGER}],[{resourcePoolId:'pool',amount:1}])).toThrow('OVERFLOW');
});
test('draining shared RAM blocks its consumers but leaves an independent resource pool usable',()=>{
 let {state,offer,grant,context}=setup();state=admitV2(state,offer,context).state;
 state=requestGrantV2(state,'shrink',2);grant={...grant,version:2,leaseRequestId:'shrink',extra:[{resourcePoolId:'independent',amount:1}]};state=installGrantV2(state,grant,true,2);
 const next=JSON.parse(JSON.stringify(offer));next.task.attemptId='next';next.allotmentVersion=2;next.target.resourcePoolIds=['independent'];next.resources=[{resourcePoolId:'independent',amount:1}];
 expect(admitV2(state,next,{...context,now:3,admissionLimit:grant.extra}).entry.record.state).toBe('ACCEPTED');
 expect(occupiedV2(state).find(r=>r.resourcePoolId==='memory1')!.amount).toBe(100);
});
test('restarted monotonic origin cannot extend a prior online grant or accept a stale ledger epoch',()=>{
 const {state,grant}=setup();const restored=requestGrantV2(recoverLedgerV2(state),'request2',0);
 expect(restored.onlineUntil).toBe(0);
 expect(()=>installGrantV2(restored,{...grant,leaseRequestId:'request2',version:2},true,1)).toThrow('UNAUTHORIZED');
 expect(()=>installGrantV2(state,grant,true,NaN)).toThrow('CLOCK_INVALID');
});

test('a renewed grant rejects an older offer without reserving resources',()=>{
 let {state,grant,offer,context}=setup();
 state=requestGrantV2(state,'renew',2);state=installGrantV2(state,{...grant,version:grant.version+1,leaseRequestId:'renew'},true,2);
 expect(()=>admitV2(state,offer,{...context,now:3})).toThrow('ALLOTMENT_MISMATCH');
 expect(occupiedV2(state)).toEqual([]);
});

test('live timings compare like-for-like completed work, expire and never free occupancy',()=>{
 const {state,offer,context}=setup(),timing=new RunTimings(),entry=admitV2(state,offer,context).entry;
 entry.record.state='RUNNING';
 const sample=(t:number)=>timing.sample([entry],t,1000+t,'SIMULATED')![0];
 expect(sample(1).elapsed.value).toBeNull();
 timing.start(entry.record.attemptId,10);
 expect(sample(15).remaining.value).toBeNull();
 timing.finish({...entry,record:{...entry.record,state:'SUCCEEDED',resourcesSettled:true}},50);
 timing.start(entry.record.attemptId,100);
 expect(sample(115).elapsed.value).toBe(15);expect(sample(115).remaining.value).toBe(25);
 expect(sample(145).remaining.value).toBeNull();expect(entry.record.resourcesSettled).toBe(false);
 entry.cancelRequested=true;expect(sample(120).remaining.value).toBeNull();
 entry.cancelRequested=false;entry.offer.task.parameters='different';expect(sample(120).remaining.value).toBe(20);
 entry.offer.task.parameters=offer.task.parameters;timing.start(entry.record.attemptId,61000);
 expect(sample(61001).remaining.value).toBeNull();
});

test('remaining forecast conditions on runs that survived the current elapsed time',()=>{
 const {state,offer,context}=setup(),timing=new RunTimings(),entry=admitV2(state,offer,context).entry;
 entry.record.state='RUNNING';
 const id=entry.record.attemptId;
 for(const [start,duration] of [[0,10],[20,40],[70,100],[180,120]]){
  timing.start(id,start);timing.finish({...entry,record:{...entry.record,state:'SUCCEEDED',resourcesSettled:true}},start+duration);
 }
 timing.start(id,400);
 const running=timing.sample([entry],450,1000,'SIMULATED')![0];
 expect(running.remaining.value).toBe(50);expect(running.history).toEqual({samples:4,survivors:2,p90TotalMs:120,p90RemainingMs:70});
 const overrun=timing.sample([entry],530,1080,'SIMULATED')![0];
 expect(overrun.remaining.value).toBeNull();expect(overrun.history?.survivors).toBe(0);
});
test('known startup state and verified input size distinguish comparable execution samples',()=>{
 const {state,offer,context}=setup(),timing=new RunTimings(),entry=admitV2(state,offer,context).entry;
 const id=entry.record.attemptId;
 timing.start(id,0,1024,'COLD');timing.finish({...entry,record:{...entry.record,state:'SUCCEEDED',resourcesSettled:true}},50);
 entry.offer.task.inputs[0].contentHash='b'.repeat(64);
 const estimate=(size:number,startup:'COLD'|'WARM'|'UNKNOWN')=>{
  timing.start(id,100,size,startup);return timing.sample([entry],110,1000,'SIMULATED')![0].remaining.value;
 };
 expect(estimate(1500,'COLD')).toBe(40);expect(estimate(2048,'COLD')).toBeNull();
 expect(estimate(1500,'WARM')).toBeNull();expect(estimate(1500,'UNKNOWN')).toBeNull();
});

test('work buckets use contract dimensions, quality steps and byte ranges',()=>{
 const contract=setup().offer.task.contract;
 const model={version:'crop-v1',parameters:[{name:'targetSize'},{name:'jpegQuality',bucketWidth:10}]};
 const key=(x:number,size:number,q:number,bytes:number)=>workKeyV2({...contract,workModel:model},JSON.stringify({box:{x},targetSize:size,jpegQuality:q}),bytes);
 expect(key(0,32,80,10)).toBe(key(1,32,89,15));
 expect(key(0,32,80,10)).not.toBe(key(0,64,80,10));
 expect(key(0,32,80,10)).not.toBe(key(0,32,90,10));
 expect(workKeyV2(contract,'{}',0)).toBe(workKeyV2(contract,'{"box":5}',1));
 expect(key(0,32,80,10)).not.toBe(key(0,32,80,16));
 expect(()=>workKeyV2({...contract,workModel:{...model,parameters:[{name:'x',bucketWidth:0}]}},'{}',1)).toThrow('COST_MODEL_INVALID');
});

test('geometric work retains timing across content hashes and compressed sizes but separates pixels',()=>{
 const {state,offer,context}=setup(),timing=new RunTimings();
 offer.task.contract.workModel={version:'pixels-v1',inputBytes:'IGNORE',parameters:[{name:'pixels'}],scale:{parameter:'pixels',reference:12544}};
 offer.task.parameters=JSON.stringify({pixels:12544});const entry=admitV2(state,offer,context).entry,id=entry.record.attemptId;
 const key=workKeyV2(offer.task.contract,offer.task.parameters,100);
 expect(key).toBe(workKeyV2(offer.task.contract,offer.task.parameters,9000));
 expect(key).not.toBe(workKeyV2(offer.task.contract,'{"pixels":5000}',100));
 timing.start(id,0,100,'UNKNOWN');timing.finish({...entry,record:{...entry.record,state:'SUCCEEDED',resourcesSettled:true}},50);
 entry.offer.task.inputs[0].contentHash='b'.repeat(64);timing.start(id,100,9000,'UNKNOWN');
 expect(timing.sample([entry],110,1000,'SIMULATED')![0].remaining.value).toBe(40);
 entry.offer.task.parameters='{"pixels":5000}';expect(timing.sample([entry],110,1000,'SIMULATED')![0].remaining.value).toBeNull();
});

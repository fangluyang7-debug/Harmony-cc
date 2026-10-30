import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { newLedgerV2, requestGrantV2, installGrantV2, admitV2, occupiedV2, vectorSumV2, recoverLedgerV2 } from '../src/ledger-v2';
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

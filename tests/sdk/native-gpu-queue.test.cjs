const {test}=require('node:test'),assert=require('node:assert/strict'),{fixture}=require('./native-coordinator-fixture.cjs');
test('winning GPU can queue behind four running tasks without inventing free resources',()=>{
 const {nativeGpuQueueAllowed:allowed}=fixture().load('apps/harmony/scheduler/src/main/ets/v2/coordinator/CoordinatorDispatchCapacity.ets'),now=Date.now(),sample=value=>({value,source:'MEASURED',sampledAt:now,ttlMs:1000,unit:'slots'});
 const p={pools:[{kind:'GPU_SLOTS',resourcePoolId:'gpu',admissionLimit:sample(4),occupied:sample(4),draining:false},{kind:'RAM_BYTES',resourcePoolId:'ram',admissionLimit:sample(8),occupied:sample(8),draining:false}],queued:[],inFlight:[0,1,2,3].map(i=>({attemptId:'a'+i}))};
 const e={target:{backend:'VULKAN'},contract:{sideEffectPolicy:'PURE',interruptibility:'CANCEL_RESTART'},resources:[{resourcePoolId:'gpu',amount:1},{resourcePoolId:'ram',amount:1}]};
 assert.equal(allowed(p,e,[],1000,30000,now),true);assert.equal(allowed(p,e,['a0','a1','a2','a3','q1','q2'],1000,30000,now),true);assert.equal(allowed(p,e,['q1','q2','q3'],1000,30000,now),false);assert.equal(p.pools[0].occupied.value,4);
 assert.equal(allowed(p,{...e,target:{backend:'CPU'}},[],1000,30000,now),false);assert.equal(allowed(p,e,[],30000,30000,now),false);assert.equal(allowed(p,e,[],1000,30000,now+2000),false);
 p.pools[1].admissionLimit.value=0;assert.equal(allowed(p,e,[],1000,30000,now),false);
});

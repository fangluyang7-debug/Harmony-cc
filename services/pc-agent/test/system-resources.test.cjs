const {test}=require('node:test'),assert=require('node:assert/strict');
const {ResourceMonitor,collectSystemResources}=require('../dist/system-resources');
test('OS sample is real; admission counts own occupancy plus free memory and preserves owner status',async()=>{
 const actual=collectSystemResources();assert.ok(actual.cpuThreads>0);assert.ok(actual.totalMemoryBytes>=actual.freeMemoryBytes);
 const updates=[],errors=[];let fail=false;
 const monitor=new ResourceMonitor({cpuPoolId:'cpu',memoryPoolId:'ram',maxCpuThreads:4,maxMemoryBytes:1000,reserveMemoryBytes:100},{
  sample:async()=>{if(fail)throw Error('COLLECTION_FAILED');return {cpuThreads:2,totalMemoryBytes:2000,freeMemoryBytes:400,sampledAt:Date.now()};},
  owner:async()=>'ACTIVE',occupied:()=>[{resourcePoolId:'ram',amount:200}],update:async(limits,owner)=>updates.push({limits,owner}),onError:e=>errors.push(e.message)});
 await monitor.sample();assert.deepEqual(updates[0],{limits:[{resourcePoolId:'cpu',amount:2},{resourcePoolId:'ram',amount:500}],owner:'ACTIVE'});
 fail=true;await monitor.sample();assert.deepEqual(updates[1],{limits:[],owner:'UNKNOWN'});assert.deepEqual(errors,['COLLECTION_FAILED']);
 await monitor.close();await monitor.sample();assert.equal(updates.length,2);
});

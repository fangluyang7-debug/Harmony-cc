const {test}=require('node:test'),assert=require('node:assert/strict');
const load=()=>import('../../apps/team-space-web/shopping-runtime.mjs');
test('real candidate partitions preserve unique identity and integer budget boundaries',async()=>{
 const {budgetMinor,candidatesFrom,partitionCandidates,mergePartitions}=await load();
 assert.equal(budgetMinor('500.01'),50001);assert.throws(()=>budgetMinor('1.001'));
 const items=Array.from({length:30},(_,i)=>({candidateItemId:'c'+i,title:'shoe '+i,price:{amount:String(300+i*10),currency:'CNY'}}));
 const candidates=candidatesFrom({runtimeRunId:'run_fixture',candidates:{items}}),parts=partitionCandidates(candidates,3,50000);
 assert.deepEqual(parts.map(p=>p.items.length),[10,10,10]);assert.equal(new Set(parts.flatMap(p=>p.items.map(i=>i.id))).size,30);
 const {filterCatalog}=require('../../services/pc-agent/dist/executors/catalog-kernel');
 const outputs=parts.map(filterCatalog),result=mergePartitions(candidates,outputs,50000);
 assert.equal(result.scanned,30);assert.equal(result.excluded,9);assert.equal(result.items.length,21);assert.equal(result.items.at(-1).priceMinor,50000);
 assert.throws(()=>mergePartitions(candidates,[outputs[0],outputs[0],outputs[2]],50000));
 assert.throws(()=>candidatesFrom({runtimeRunId:'run_fixture',candidates:{items:[items[0],items[0]]}}));
});
test('space transport forwards task submission to SDK endpoint and surfaces actual status',async()=>{
 const {spacePort}=await load(),calls=[],states=[];
 const port=spacePort('group',async(url,opts)=>{calls.push({url,opts});return {ok:true,text:async()=>JSON.stringify({jobId:'job',state:'RUNNING',deviceId:'device'})};},async()=>'',s=>states.push(s));
 await port.request('/v2/sdk/jobs','{"workflow":{}}');await port.request('/v2/sdk/jobs/job',null);
 assert.equal(calls[0].url,'/v2/spaces/group/sdk/jobs');assert.equal(calls[0].opts.method,'POST');assert.equal(calls[1].opts.method,'GET');assert.equal(states[0].deviceId,'device');
});

test('automatic catalog batching avoids tiny partitions while preserving contract size and coverage',async()=>{
 const {catalogPartitionCount,partitionCandidates}=await load();
 assert.equal(catalogPartitionCount(30,2,'auto'),1);assert.equal(catalogPartitionCount(30,2,'coverage'),2);
 assert.equal(catalogPartitionCount(10000,2,'auto'),1);assert.equal(catalogPartitionCount(10001,1,'auto'),2);
 const items=Array.from({length:10001},(_,rank)=>({candidateItemId:String(rank),rank,price:{amount:'1',currency:'CNY'}}));
 const parts=partitionCandidates(items,catalogPartitionCount(items.length,1,'auto'),50000);assert.deepEqual(parts.map(p=>p.items.length),[5001,5000]);
 assert.throws(()=>catalogPartitionCount(40001,2,'auto'));assert.throws(()=>catalogPartitionCount(30000,2,'coverage'));
});

const {test}=require('node:test'),assert=require('node:assert/strict');
const {compareShopping,reference,median}=require('./benchmark-shopping.cjs');
const source={sourceRunId:'run_fixture',query:'500元以内的运动鞋',maxPriceMinor:50000,candidates:Array.from({length:30},(_,rank)=>({candidateItemId:'item-'+rank,rank,title:'fixture',price:{amount:String(300+rank*10),currency:'CNY'}}))};
const targets=[{deviceId:'windows',targetId:'w'},{deviceId:'phone',targetId:'p'}];
test('shopping comparison preserves inputs, includes both team devices and excludes warmup from medians',async()=>{
 const calls=[];const report=await compareShopping({source,targets,rounds:1,sdkFactory:()=>({registerInput:async bytes=>({bytes}),releaseInput(){},submit:async(workflow,options)=>{calls.push({workflow,options});const n=workflow.nodes[0],output=Buffer.from(JSON.stringify(reference(JSON.parse(n.input.bytes))));return {result:async()=>({output,status:{state:'SUCCEEDED',deviceId:n.targetId==='w'?'windows':'phone',targetId:n.targetId,traceId:'trace'}})};}})});
 assert.equal(report.batches.length,6);assert.equal(calls.length,12);assert.ok(calls.every(c=>c.options.budgetMs===30000));assert.equal(report.teamAllBatchesUseTwo,true);
 const hashes=report.batches[0].samples.map(s=>s.inputHash);for(const b of report.batches)assert.deepEqual(b.samples.map(s=>s.inputHash),hashes);
 for(const name of ['WINDOWS','PHONE','TEAM'])assert.equal(report.medians[name],report.batches.find(b=>b.round===0&&b.mode===name).durationMs);
 assert.equal(new Set(report.batches.map(b=>b.resultHash)).size,1);assert.equal(median([3,1,9,7]),5);
});
test('incorrect result stops later benchmark batches while preserving failed IDs',async()=>{
 const report=await compareShopping({source,targets,rounds:1,sdkFactory:()=>({registerInput:async()=>({}),releaseInput(){},submit:async()=>({result:async()=>({output:Buffer.from('{}'),status:{state:'SUCCEEDED'}})})})});
 assert.equal(report.state,'FAILED');assert.equal(report.batches.length,1);assert.equal(report.batches[0].samples.length,2);assert.ok(report.batches[0].samples.every(s=>s.jobId&&s.state==='FAILED'));
});

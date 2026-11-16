const {test}=require('node:test'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url'),path=require('node:path');
const view=()=>import(pathToFileURL(path.resolve(__dirname,'../../apps/team-space-web/photo-execution-view.mjs')));
test('photo plan distinguishes offered, compute, publication and committed evidence',async()=>{
 const {nodeStatus,gpu,workflowEdges}=await view();
 assert.equal(nodeStatus({state:'OFFERED'}).kind,'queued');assert.equal(nodeStatus({state:'SUCCEEDED'}).kind,'publishing');assert.equal(nodeStatus({state:'RUNNING',timing:[{phase:'EXECUTE'}]}).kind,'publishing');assert.equal(nodeStatus({state:'RUNNING',timing:[{phase:'LOAD'}]}).kind,'running');assert.equal(nodeStatus({state:'SUCCEEDED',committed:true}).kind,'done');
 assert.equal(gpu({target:{backend:'CPU'}}),false);assert.equal(gpu({target:{backend:'VULKAN'}}),true);
 const nodes=[{id:'a',target:{deviceId:'phone'}},{id:'b',dependsOn:['a'],target:{deviceId:'gpu'},timing:[{phase:'LOAD',reasonCode:'PHASE_FAILED'}]}];
 assert.deepEqual(workflowEdges({nodes}).map(e=>[e.crossDevice,e.readVerified]),[[true,false]]);nodes[1].timing=[{phase:'LOAD'}];assert.equal(workflowEdges({nodes})[0].readVerified,true);
});

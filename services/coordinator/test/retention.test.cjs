const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {runtime}=require('./helpers.cjs'),{transferDigest,ArtifactChannel}=require('@harmony/resource-transport');
const {ArtifactRetention}=require('../dist/retention');
test('durable DAG retention protects a remaining branch, unsettled work and unacknowledged final bytes; physical release frees capacity',async()=>{
 const r=await runtime({artifactSchemas:new Map([['blob:1',()=>true]])});
 try{
  const group=randomUUID(),id=randomUUID(),owner=randomUUID(),bytes=Buffer.from('retained branch');
  const descriptor={groupId:group,ownerPrincipalId:owner,domain:'SIMULATED',bytes:bytes.length,expiresAt:Date.now()+3600000,ref:{artifactId:'middle',contentVersion:1,contentHash:transferDigest(bytes),schemaId:'blob',schemaVersion:1}};
  const final={...descriptor,ref:{...descriptor.ref,artifactId:'final'}},input={...descriptor,ref:{...descriptor.ref,artifactId:'root'}};
  const graph={deadlineAt:Date.now()+30000,nodes:[{id:'b',jobId:'b',state:'COMMITTED'},{id:'c',jobId:'c',state:'COMMITTED'},{id:'d',jobId:'d',state:'SUBMITTED'}],workflow:{nodes:[{id:'b',dependsOn:[]},{id:'c',inputFrom:'b',dependsOn:['b']},{id:'d',inputFrom:'b',dependsOn:['b','c']}]},inputs:{}};
  await r.db.sdkWorkflowJob.create({data:{id,groupId:group,sourceHolderId:'source',state:'ACTIVE',metadataJson:JSON.stringify(graph)}});
  const job=(node,input,output)=>({input,output,deadlineAt:graph.deadlineAt,offer:{task:{workflowId:id,nodeId:node}}});
  for(const [node,info] of [['b',job('b',input,descriptor)],['d',job('d',descriptor,final)]]){
   await r.db.cpuJob.create({data:{id:node,groupId:group,principalId:owner,sourceHolderId:'source',state:'DISPATCHED',metadataJson:JSON.stringify(info)}});
   await r.db.attempt.create({data:{id:node,groupId:group,workflowId:id,nodeId:node,holderInstanceId:node,executionDigest:'fixture',taskJson:'{}',state:node==='b'?'SUCCEEDED':'RUNNING',recordJson:JSON.stringify({state:node==='b'?'SUCCEEDED':'RUNNING',resourcesSettled:node==='b'})}});
  }
  r.artifacts.register(descriptor);await r.artifacts.writeForControl(descriptor,bytes);await r.retention.sweepRelay();assert.equal(r.artifacts.available(descriptor),true);
  const reopened=new ArtifactChannel(require('node:path').join(r.config.dataDir,'artifact-cache'),'SIMULATED',async()=>({}),new Map([['blob:1',()=>true]]));
  const retention=new ArtifactRetention(r.db,r.directTransfers,reopened);await retention.sweepRelay();assert.equal(reopened.available(descriptor),true);
  graph.nodes[2].state='COMMITTED';await r.db.sdkWorkflowJob.update({where:{id},data:{state:'SUCCEEDED',metadataJson:JSON.stringify(graph)}});
  await retention.sweepRelay();assert.equal(reopened.available(descriptor),true,'a terminal graph cannot release an unsettled reader');
  await r.db.attempt.update({where:{id:'d'},data:{state:'SUCCEEDED',recordJson:JSON.stringify({state:'SUCCEEDED',resourcesSettled:true})}});
  reopened.register(final);await reopened.writeForControl(final,bytes);
  const release=reopened.acquireTransferSlot();await retention.sweepRelay();assert.equal(reopened.available(descriptor),true);release();
  await retention.sweepRelay();assert.equal(reopened.lookup(group,descriptor.ref),null);assert.equal(reopened.available(final),true);
  reopened.issue(final,{groupId:group,principalId:owner,holderInstanceId:'source'},'READ');await retention.sweepRelay();assert.equal(reopened.available(final),true,'issuing a download is not acknowledgment');
  graph.resultReceivedAt=Date.now();await r.db.sdkWorkflowJob.update({where:{id},data:{metadataJson:JSON.stringify(graph)}});await retention.sweepRelay();assert.equal(reopened.lookup(group,final.ref),null);
  reopened.limits.cacheBytes=bytes.length;reopened.register(descriptor);await reopened.writeForControl(descriptor,bytes);
  const extra={...descriptor,ref:{...descriptor.ref,artifactId:'extra'}};reopened.register(extra);await assert.rejects(reopened.writeForControl(extra,bytes),/ARTIFACT_CACHE_FULL/);
  assert.equal(reopened.forget(descriptor),true);await reopened.writeForControl(extra,bytes);assert.equal(reopened.available(extra),true);
 }finally{await r.close();}
});

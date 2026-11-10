const {test}=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const {runtime}=require('./helpers.cjs'),{transferDigest,ArtifactChannel}=require('@harmony/resource-transport');
const {ArtifactRetention}=require('../dist/retention');
test('a multi-artifact sweep reads group ownership once and preserves unknown bytes and live transfer grants',async()=>{
 const r=await runtime({artifactSchemas:new Map([['blob:1',()=>true]])});try{
  const group=randomUUID(),bytes=Buffer.from('tile'),objects=[];
  for(let i=0;i<8;i++){
   const d={groupId:group,ownerPrincipalId:'owner',domain:'SIMULATED',bytes:bytes.length,expiresAt:Date.now()+60000,ref:{artifactId:'tile-'+i,contentVersion:1,contentHash:transferDigest(bytes),schemaId:'blob',schemaVersion:1}};objects.push(d);r.artifacts.register(d);await r.artifacts.writeForControl(d,bytes);
   if(i===7)continue;
   await r.db.cpuJob.create({data:{id:'tile-'+i,groupId:group,principalId:'owner',sourceHolderId:'source',state:'SUCCEEDED',metadataJson:JSON.stringify({output:d,resultReceivedAt:Date.now(),offer:{task:{workflowId:'done',nodeId:'render'}}})}});
  }
  await r.db.transferAuthorization.create({data:{id:'active-transfer',groupId:group,attemptId:'tile-6',endpointId:'endpoint',requesterCredentialId:'credential',state:'ISSUED',expiresAt:Date.now()+60000,metadataJson:JSON.stringify({authorization:{ref:objects[6].ref}})}});
  let scans=0;const observed=r.db.$extends({query:{cpuJob:{findMany:({args,query})=>{scans++;return query(args);}}}});
  const retention=new ArtifactRetention(observed,r.directTransfers,r.artifacts);await retention.sweepRelay();assert.equal(scans,1);
  for(let i=0;i<6;i++)assert.equal(r.artifacts.lookup(group,objects[i].ref),null);
  assert.equal(r.artifacts.available(objects[6]),true);assert.equal(r.artifacts.available(objects[7]),true);
  await r.db.transferAuthorization.update({where:{id:'active-transfer'},data:{expiresAt:1}});await retention.sweepRelay();assert.equal(r.artifacts.lookup(group,objects[6].ref),null);assert.equal(r.artifacts.available(objects[7]),true);
 }finally{await r.close();}
});
test('receipt cleanup hints coalesce and shutdown flushes a pending sweep',async()=>{
 const retention=new ArtifactRetention(null,null,null);let calls=0;retention.sweepRelay=async()=>{calls++;};
 for(let i=0;i<20;i++)retention.scheduleSweep();assert.equal(calls,0);
 await new Promise(r=>setTimeout(r,160));assert.equal(calls,1);
 retention.scheduleSweep();await retention.close();assert.equal(calls,2);
 await new Promise(r=>setTimeout(r,120));assert.equal(calls,2);
});
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

test('failed fork drains running and half-recorded siblings across recovery before releasing shared bytes',async()=>{
 const {WorkflowJobs}=require('../dist/workflow-jobs'),r=await runtime({artifactSchemas:new Map([['blob:1',()=>true]])});
 let worker,restarted;
 try{
  const group=randomUUID(),owner=randomUUID(),id=randomUUID(),capacity=[{resourcePoolId:'cpu',amount:1}];
  const invite=await r.auth.invite(group,owner,'device',r.url),device=await r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:'holder'});
  await r.allotments.confirmDevice('device',capacity,[{groupId:group,holderInstanceId:'holder',appInstanceId:null}]);
  const invitation=await r.apps.register(device.peer,{label:'Fork source',allowedContracts:['text.count.v1'],maxConcurrent:4,resources:capacity,offlineBase:[],onlineExtra:capacity},r.url);
  const {peer}=await r.apps.exchange({registrationId:invitation.registrationId,code:invitation.code});
  const bytes=Buffer.from('shared'),d={groupId:group,ownerPrincipalId:owner,domain:'SIMULATED',bytes:bytes.length,expiresAt:Date.now()+60000,ref:{artifactId:'middle',contentVersion:1,contentHash:transferDigest(bytes),schemaId:'blob',schemaVersion:1}};
  const nodes=['producer','failed','running','partial','downstream'].map((name,i)=>({id:name,jobId:name,state:['COMMITTED','SUBMITTED','SUBMITTED','PENDING','PENDING'][i]}));
  const graph={peer,nodes,workflow:{nodes:nodes.map(n=>({id:n.id,dependsOn:n.id==='producer'?[]:['producer'],inputFrom:n.id==='producer'?undefined:'producer'}))},inputs:{},deadlineAt:Date.now()+30000};
  await r.db.sdkWorkflowJob.create({data:{id,groupId:group,sourceHolderId:peer.holderInstanceId,state:'ACTIVE',metadataJson:JSON.stringify(graph)}});
  const runningRecord={...require('./fixtures.cjs').attempt().record,groupId:group,attemptId:'running',principalId:owner,state:'RUNNING',resourcesSettled:false};
  for(const [name,state] of [['failed','REJECTED'],['running','RUNNING'],['partial',null]]){
   const metadata={input:d,output:null,offer:{target:{targetId:'target',deviceId:'device'},task:{workflowId:id,nodeId:name}}};
   await r.db.cpuJob.create({data:{id:name,groupId:group,sourceHolderId:peer.holderInstanceId,principalId:owner,state:state?'DISPATCHED':'WAITING_INPUT',metadataJson:JSON.stringify(metadata)}});
   if(state)await r.db.attempt.create({data:{id:name,groupId:group,workflowId:id,nodeId:name,holderInstanceId:'worker',executionDigest:'fixture',taskJson:'{}',state,recordJson:state==='RUNNING'?JSON.stringify(runningRecord):null}});
  }
  r.artifacts.register(d);await r.artifacts.writeForControl(d,bytes);
  const open=()=>new WorkflowJobs(r.db,r.jobs,r.apps,r.artifacts,[],r.retention);
  worker=open();await worker.advance(group);
  const graphState=async()=>(await r.db.sdkWorkflowJob.findUniqueOrThrow({where:{id}})).state;
  assert.equal(await graphState(),'CANCEL_REQUESTED');
  assert.equal((await r.db.cpuJob.findUnique({where:{id:'partial'}})).state,'CANCELLED');
  assert.equal((await r.db.cpuJob.findUnique({where:{id:'running'}})).state,'CANCEL_REQUESTED');
  await worker.close();worker=open();await worker.advance(group);assert.equal(await graphState(),'CANCEL_REQUESTED');
  assert.equal(r.artifacts.available(d),true);
  await r.db.attempt.update({where:{id:'running'},data:{state:'CANCELLED_SETTLED',recordJson:JSON.stringify({...runningRecord,state:'CANCELLED_SETTLED',resourcesSettled:true})}});
  const release=r.artifacts.acquireTransferSlot();
  try{await worker.advance(group);assert.equal(await graphState(),'REJECTED');assert.equal(r.artifacts.available(d),true);}
  finally{release();}
  await r.retention.sweepRelay();assert.equal(r.artifacts.available(d),false);
  assert.equal(await r.db.attempt.count({where:{workflowId:id}}),2);assert.equal(await r.db.cpuJob.count({where:{id:'downstream'}}),0);
  // Restart the coordinator itself at the submission/cursor crash boundary. No
  // client poll or new connection should be necessary to finish cancellation.
  const interrupted=randomUUID(),orphan=randomUUID();
  const stoppedGraph={...graph,nodes:[{id:'orphan',jobId:orphan,state:'PENDING'}]};
  await r.db.sdkWorkflowJob.create({data:{id:interrupted,groupId:group,sourceHolderId:peer.holderInstanceId,state:'CANCEL_REQUESTED',metadataJson:JSON.stringify(stoppedGraph)}});
  await r.db.cpuJob.create({data:{id:orphan,groupId:group,sourceHolderId:peer.holderInstanceId,principalId:owner,state:'WAITING_INPUT',metadataJson:JSON.stringify({offer:{task:{workflowId:interrupted,nodeId:'orphan'}}})}});
  await worker.close();await r.close();
  restarted=await require('../dist/app').createCoordinator(r.config);
  await restarted.restore();
  const until=Date.now()+5000;
  while((await restarted.db.sdkWorkflowJob.findUniqueOrThrow({where:{id:interrupted}})).state!=='CANCELLED_SETTLED'){
   if(Date.now()>until)assert.fail('startup failed to drain persisted cancellation');
   await new Promise(resolve=>setTimeout(resolve,30));
  }
  assert.equal((await restarted.db.cpuJob.findUniqueOrThrow({where:{id:orphan}})).state,'CANCELLED');
 }finally{await restarted?.close();await worker?.close();await r.close();}
});

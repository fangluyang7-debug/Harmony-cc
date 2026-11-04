const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {fork}=require('node:child_process'),{randomUUID}=require('node:crypto');
const {runtime}=require('./helpers.cjs'),{transferDigest,signTransfer}=require('@harmony/resource-transport');

function processEndpoint(){
 const child=fork(path.join(__dirname,'direct-endpoint-child.cjs'),[],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true}),pending=new Map();
 child.on('message',message=>{const p=pending.get(message.id);if(!p)return;pending.delete(message.id);clearTimeout(p.timer);message.error?p.reject(Error(message.error)):p.resolve(message.value);});
 child.on('exit',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('ENDPOINT_PROCESS_EXITED'));}pending.clear();});
 return {child,request:body=>new Promise((resolve,reject)=>{const id=randomUUID(),timer=setTimeout(()=>{pending.delete(id);reject(Error('ENDPOINT_FIXTURE_TIMEOUT'));},20000);pending.set(id,{resolve,reject,timer});child.send({id,...body});}),close:()=>{child.disconnect();child.kill();}};
}

test('independent endpoint processes consume single-use scoped grants online and invalidate network epochs',async()=>{
 const r=await runtime({cpuHost:true}),source=processEndpoint();let target=processEndpoint();
 try{
  const group=randomUUID(),principal=randomUUID();
  async function pair(device){const invite=await r.auth.invite(group,principal,device,r.url),paired=await r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:randomUUID()});return {paired,invite};}
  const owner=await pair('source-device'),worker=await pair('target-device');
  const registration=await r.apps.register(owner.paired.peer,{label:'Direct source',allowedContracts:['text.count.v1'],maxConcurrent:1,resources:[{resourcePoolId:'cpu',amount:1},{resourcePoolId:'ram',amount:268435456}],offlineBase:[],onlineExtra:[]},r.url);
  const app=await r.apps.exchange({registrationId:registration.registrationId,code:registration.code});
  const connection=(paired,invite)=>({address:r.url,certificate:invite.certificate,fingerprint:invite.fingerprint,credential:paired.credential,domain:'SIMULATED'});
  const left=await source.request({action:'open',directory:path.join(r.config.dataDir,'source'),connection:connection(app,owner.invite)});
  const right=await target.request({action:'open',directory:path.join(r.config.dataDir,'target'),connection:connection(worker.paired,worker.invite)});
  assert.notEqual(left.pid,right.pid);assert.notEqual(left.pid,process.pid);assert.notEqual(right.pid,process.pid);
  assert.notEqual(left.endpoint.fingerprint,right.endpoint.fingerprint);assert.notEqual(right.endpoint.certificate,r.identity.cert);
  const network=await r.directTransfers.resetNetwork(app.peer);
  await r.directTransfers.reportLink(app.peer,{epoch:network.epoch,endpointId:right.endpoint.id,endpointEpoch:right.endpoint.epoch,direction:'WRITE',reason:'REACHABLE',samples:[1024,8192,32768].map(bytes=>({bytes,durationMs:5+bytes/1000}))});
  const bytes=Buffer.from('{"text":"independent endpoints"}'),id=randomUUID(),ref={artifactId:'in-'+id,contentVersion:1,contentHash:transferDigest(bytes),schemaId:'text.input',schemaVersion:1};
  // Fixture isolates the transfer contract; full workflow dispatch has its own integration acceptance.
  const data={holderId:worker.paired.peer.holderInstanceId,deadlineAt:Date.now()+30000,input:{ref,groupId:group,ownerPrincipalId:principal,domain:'SIMULATED',bytes:bytes.length,expiresAt:Date.now()+3600000},
   plan:{decision:{suggestion:[{inputEndpointId:right.endpoint.id,inputEndpointEpoch:right.endpoint.epoch}]}},
   offer:{target:{deviceId:worker.paired.peer.deviceId},task:{workflowId:id,app:{appInstanceId:app.peer.app.appInstanceId},coordinatorEpoch:r.epoch}}};
  await r.db.cpuJob.create({data:{id,groupId:group,principalId:principal,sourceHolderId:app.peer.holderInstanceId,state:'WAITING_INPUT',metadataJson:JSON.stringify(data)}});
  const issue=()=>r.directTransfers.issue(app.peer,{attemptId:id,endpointId:right.endpoint.id,operation:'WRITE'});
  const grant=await issue(),send=g=>source.request({action:'send',grant:g,bytes:bytes.toString('base64')});
  assert.equal(await source.request({action:'long-term-header',grant,bytes:bytes.toString('base64')}),403);
  const expired={...grant,signed:signTransfer({...grant.signed.authorization,issuedAt:Date.now()-3000,expiresAt:Date.now()-1},r.identity.key)};await assert.rejects(send(expired));
  const wrongTls=structuredClone(grant.signed.authorization);wrongTls.endpoint.certificate=left.endpoint.certificate;wrongTls.endpoint.fingerprint=left.endpoint.fingerprint;
  await assert.rejects(send({...grant,signed:signTransfer(wrongTls,r.identity.key)}));
  const wrongDestination=structuredClone(grant.signed.authorization);wrongDestination.endpoint.address=left.endpoint.address;wrongDestination.endpoint.certificate=left.endpoint.certificate;wrongDestination.endpoint.fingerprint=left.endpoint.fingerprint;
  await assert.rejects(send({...grant,signed:signTransfer(wrongDestination,r.identity.key)}));
  const changed=structuredClone(grant);changed.signed.authorization.appInstanceId='foreign';await assert.rejects(send(changed));
  assert.equal((await r.db.transferAuthorization.findUnique({where:{id:grant.signed.authorization.id}})).state,'ISSUED');
  const results=await Promise.allSettled([send(grant),send(grant)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(await target.request({action:'read-cache',groupId:group,ref}),bytes.toString('base64'));
  assert.equal(await r.directTransfers.hasInput(group,worker.paired.peer.holderInstanceId,app.peer.app.appInstanceId,ref),true);
  assert.equal(await r.directTransfers.hasInput(group,worker.paired.peer.holderInstanceId,'foreign',ref),false);
  assert.equal(r.artifacts.lookup(group,ref),null,'business bytes were not uploaded to the coordinator');
  const measurement={authorizationId:grant.signed.authorization.id,durationMs:results.find(r=>r.status==='fulfilled').value.durationMs};
  assert.equal((await r.directTransfers.observe(app.peer,measurement)).recorded,true);
  assert.equal((await r.directTransfers.observe(app.peer,measurement)).recorded,false);
  // Delegated reads are limited to a selected holder and a current committed DAG edge.
  const consumer=await pair('consumer-device');await r.directTransfers.resetNetwork(consumer.paired.peer);
  data.offer.task.nodeId='parent';data.output=data.input;data.retainOutput={id:right.endpoint.id,epoch:right.endpoint.epoch};
  await r.db.cpuJob.update({where:{id},data:{metadataJson:JSON.stringify(data)}});
  const parentNode=JSON.stringify([id,'parent']);
  await r.db.node.create({data:{id:parentNode,workflowId:id,currentAttemptId:id,state:'RUNNING'}});
  await r.db.attempt.create({data:{id,groupId:group,workflowId:id,nodeId:'parent',executionDigest:'fixture-parent',state:'RUNNING',holderInstanceId:worker.paired.peer.holderInstanceId,taskJson:JSON.stringify(data.offer.task)}});
  await assert.rejects(r.directTransfers.publishOutput(app.peer,id,data.output),/OUTPUT_REPLICA_SCOPE/);
  await assert.rejects(r.directTransfers.publishOutput(worker.paired.peer,id,{...data.output,bytes:data.output.bytes+1}),/OUTPUT_REPLICA_SCOPE/);
  await r.directTransfers.publishOutput(worker.paired.peer,id,data.output);
  assert.equal(await r.directTransfers.hasInput(group,worker.paired.peer.holderInstanceId,app.peer.app.appInstanceId,ref),false,'stored output is not consumable before commit');
  await r.db.node.update({where:{id:parentNode},data:{state:'COMMITTED'}});
  await r.db.attempt.update({where:{id},data:{state:'SUCCEEDED'}});
  await r.db.receipt.create({data:{id,attemptId:id,committed:true,recordJson:JSON.stringify({state:'SUCCEEDED',outputs:[ref]})}});
  assert.equal(await r.directTransfers.hasInput(group,worker.paired.peer.holderInstanceId,app.peer.app.appInstanceId,ref),true);
  const childId=randomUUID(),childData={...data,sourceAttemptId:id,holderId:consumer.paired.peer.holderInstanceId,
   plan:{decision:{suggestion:[{inputEndpointId:right.endpoint.id,inputEndpointEpoch:right.endpoint.epoch,inputEndpointOperation:'READ'}]}},
   offer:{target:{deviceId:consumer.paired.peer.deviceId},dependencies:[{nodeId:'parent',committed:true}],task:{workflowId:id,nodeId:'child',coordinatorEpoch:r.epoch,app:{appId:app.peer.app.appId,appInstanceId:app.peer.app.appInstanceId},contract:{contractId:'text.count.v1'}}}};
  await r.db.cpuJob.create({data:{id:childId,groupId:group,principalId:principal,sourceHolderId:app.peer.holderInstanceId,state:'DISPATCHED',metadataJson:JSON.stringify(childData)}});
  await r.db.attempt.create({data:{id:childId,groupId:group,workflowId:id,nodeId:'child',executionDigest:'fixture',state:'RUNNING',holderInstanceId:consumer.paired.peer.holderInstanceId,taskJson:JSON.stringify(childData.offer.task)}});
  const pull=()=>r.directTransfers.issue(consumer.paired.peer,{attemptId:childId,endpointId:right.endpoint.id,operation:'READ'});
  const delegated=await pull();assert.equal(delegated.signed.authorization.ownerPrincipalId,principal);
  assert.equal(delegated.signed.authorization.appInstanceId,app.peer.app.appInstanceId);
  await r.db.node.update({where:{id:parentNode},data:{currentAttemptId:'replacement'}});
  await assert.rejects(pull(),/TRANSFER_DEPENDENCY_SCOPE/);
  await assert.rejects(r.directTransfers.consume(worker.paired.peer,delegated),/TRANSFER_DEPENDENCY_SCOPE/);
  await r.db.node.update({where:{id:parentNode},data:{currentAttemptId:id}});
  await r.db.cpuJob.update({where:{id:childId},data:{state:'CANCEL_REQUESTED'}});await assert.rejects(pull(),/TRANSFER_DEPENDENCY_SCOPE/);
  // A settled producer can push a committed output before the consumer has an attempt.
  const pushId=randomUUID(),deliveryId=randomUUID();
  const pushData={...childData,holderId:app.peer.holderInstanceId,sourceNodeId:'parent',
    delivery:{id:deliveryId,senderHolderId:worker.paired.peer.holderInstanceId,senderEndpointId:right.endpoint.id,senderEpoch:right.endpoint.epoch},
    offer:{...childData.offer,target:{deviceId:app.peer.deviceId},task:{...childData.offer.task,nodeId:'push-child'}},
    plan:{decision:{suggestion:[{inputEndpointId:left.endpoint.id,inputEndpointEpoch:left.endpoint.epoch,inputEndpointOperation:'WRITE'}]}}};
  await r.db.sdkWorkflowJob.create({data:{id,groupId:group,sourceHolderId:app.peer.holderInstanceId,state:'ACTIVE',metadataJson:JSON.stringify({workflow:{nodes:[{id:'push-child',inputFrom:'parent',dependsOn:['parent']}]}})}});
  await r.db.cpuJob.create({data:{id:pushId,groupId:group,principalId:principal,sourceHolderId:app.peer.holderInstanceId,state:'WAITING_INPUT',metadataJson:JSON.stringify(pushData)}});
  await r.directTransfers.resetNetwork(worker.paired.peer);
  const issuePush=()=>r.directTransfers.issue(worker.paired.peer,{attemptId:pushId,endpointId:left.endpoint.id,deliveryId,operation:'WRITE'});
  await assert.rejects(r.directTransfers.issue(worker.paired.peer,{attemptId:pushId,endpointId:right.endpoint.id,deliveryId,operation:'WRITE'}),/TRANSFER_PLAN_CHANGED/);
  const mismatch={...pushData,input:{...pushData.input,ref:{...ref,artifactId:'same-hash-wrong-id'}}};
  await r.db.cpuJob.update({where:{id:pushId},data:{metadataJson:JSON.stringify(mismatch)}});await assert.rejects(issuePush(),/DELIVERY_SCOPE/);
  const foreign={...pushData,offer:{...pushData.offer,task:{...pushData.offer.task,app:{...pushData.offer.task.app,appInstanceId:'foreign-installation'}}}};
  await r.db.cpuJob.update({where:{id:pushId},data:{metadataJson:JSON.stringify(foreign)}});await assert.rejects(issuePush(),/DELIVERY_SCOPE/);
  await r.db.cpuJob.update({where:{id:pushId},data:{metadataJson:JSON.stringify(pushData)}});
  const definition={workflow:{nodes:[{id:'push-child',inputFrom:'parent',dependsOn:['parent','sort-only']}]}};
  await r.db.sdkWorkflowJob.update({where:{id},data:{metadataJson:JSON.stringify(definition)}});await assert.rejects(issuePush(),/DELIVERY_DEPENDENCY/);
  await r.db.node.create({data:{id:JSON.stringify([id,'sort-only']),workflowId:id,currentAttemptId:'sort-attempt',state:'COMMITTED'}});
  await r.db.receipt.create({data:{id:'sort-attempt',attemptId:'sort-attempt',committed:true,recordJson:JSON.stringify({state:'SUCCEEDED',outputs:[]})}});
  const push=await issuePush();assert.equal(push.signed.authorization.producerAttemptId,id);
  await target.request({action:'send',grant:push,bytes:bytes.toString('base64')});
  assert.equal(await source.request({action:'read-cache',groupId:group,ref}),bytes.toString('base64'));
  assert.equal(await r.db.attempt.count({where:{id:pushId}}),0);
  const copies=await r.directTransfers.inputCopies(group,app.peer.app.appInstanceId,ref,id);
  assert.equal(copies.find(c=>c.holderInstanceId===app.peer.holderInstanceId).localOnly,false);
  const oldDelivery=await issuePush();
  const reboundId=randomUUID(),rebound={...pushData,holderId:worker.paired.peer.holderInstanceId,
    delivery:{id:reboundId,senderHolderId:app.peer.holderInstanceId,senderEndpointId:left.endpoint.id,senderEpoch:left.endpoint.epoch},
    offer:{...pushData.offer,target:{deviceId:worker.paired.peer.deviceId}},
    plan:{decision:{suggestion:[{inputEndpointId:right.endpoint.id,inputEndpointEpoch:right.endpoint.epoch,inputEndpointOperation:'WRITE'}]}}};
  await r.db.cpuJob.update({where:{id:pushId},data:{metadataJson:JSON.stringify(rebound)}});
  await assert.rejects(r.directTransfers.consume(app.peer,oldDelivery),/DELIVERY_SCOPE/);
  const forwarded=await r.directTransfers.issue(app.peer,{attemptId:pushId,endpointId:right.endpoint.id,deliveryId:reboundId,operation:'WRITE'});
  assert.equal(forwarded.signed.authorization.producerAttemptId,id);
  await source.request({action:'send',grant:forwarded,bytes:bytes.toString('base64')});
  assert.equal(await r.db.attempt.count({where:{id:pushId}}),0);
  // A local-only receipt cannot be upgraded by supplying the same hash/endpoint.
  const {canonical}=require('@harmony/scheduler-core');
  const copyKey=transferDigest(canonical([group,ref,left.endpoint.id,left.endpoint.epoch]));
  const copy=await r.db.dataReplica.findUniqueOrThrow({where:{id:copyKey}}),copyData=JSON.parse(copy.metadataJson);
  await r.db.dataReplica.update({where:{id:copyKey},data:{metadataJson:JSON.stringify({...copyData,servable:false})}});
  await assert.rejects(r.directTransfers.issue(app.peer,{attemptId:pushId,endpointId:right.endpoint.id,deliveryId:reboundId,operation:'WRITE'}),/DELIVERY_SOURCE_CHANGED/);
  await r.db.dataReplica.update({where:{id:copyKey},data:{metadataJson:copy.metadataJson}});
  await r.db.cpuJob.update({where:{id:pushId},data:{metadataJson:JSON.stringify(pushData)}});
  const savedCopies=await r.db.dataReplica.findMany({where:{groupId:group}});
  await assert.rejects(r.directTransfers.deliveryMissing(app.peer,{attemptId:pushId,deliveryId,ref}),/DELIVERY_SCOPE/);
  await assert.rejects(r.directTransfers.deliveryMissing(worker.paired.peer,{attemptId:pushId,deliveryId,ref:{...ref,artifactId:'wrong-ref'}}),/DELIVERY_SCOPE/);
  await r.db.cpuJob.update({where:{id:pushId},data:{metadataJson:JSON.stringify(rebound)}});
  await r.directTransfers.deliveryMissing(app.peer,{attemptId:pushId,deliveryId:reboundId,ref});
  assert.equal(await r.directTransfers.hasInput(group,app.peer.holderInstanceId,app.peer.app.appInstanceId,ref),false);
  assert.equal(await r.directTransfers.sourceProblem(group,app.peer.app.appInstanceId,ref,id),null,'another complete copy survives');
  await r.db.cpuJob.update({where:{id:pushId},data:{metadataJson:JSON.stringify(pushData)}});
  await r.directTransfers.deliveryMissing(worker.paired.peer,{attemptId:pushId,deliveryId,ref});
  assert.equal(await r.directTransfers.sourceProblem(group,app.peer.app.appInstanceId,ref,id),'CONFIRMED_MISSING');await assert.rejects(issuePush(),/DELIVERY_SOURCE_CHANGED/);
  assert.equal(await r.db.dataReplica.count({where:{groupId:group}}),savedCopies.length,'missing reports preserve exact evidence tombstones');
  for(const copy of savedCopies)await r.db.dataReplica.update({where:{id:copy.id},data:{metadataJson:copy.metadataJson}});
  await r.db.cpuJob.update({where:{id:pushId},data:{metadataJson:JSON.stringify(pushData)}});
  const invalidated=await issuePush();await r.db.sdkWorkflowJob.update({where:{id},data:{state:'CANCEL_REQUESTED'}});
  await assert.rejects(r.directTransfers.consume(app.peer,invalidated),/DELIVERY_SCOPE/);
  // The settled producer may instead deliver the same committed edge to the
  // signed coordinator relay; authorization is still one-use and graph-bound.
  await r.db.sdkWorkflowJob.update({where:{id},data:{state:'ACTIVE'}});
  const relayDeliveryId=randomUUID(),relayData={...pushData,delivery:{...pushData.delivery,id:relayDeliveryId,relay:true},
    plan:{decision:{suggestion:[{inputRelayId:r.store.senderInstanceId}]}}};
  await r.db.cpuJob.update({where:{id:pushId},data:{metadataJson:JSON.stringify(relayData)}});
  const relayIssue=()=>r.directTransfers.issue(worker.paired.peer,{attemptId:pushId,endpointId:r.store.senderInstanceId,deliveryId:relayDeliveryId,operation:'WRITE'});
  const fullGrant=await relayIssue(),cacheLimit=r.artifacts.limits.cacheBytes;r.artifacts.limits.cacheBytes=0;
  try{
    await assert.rejects(target.request({action:'send',grant:fullGrant,bytes:bytes.toString('base64')}));
    assert.equal((await r.db.transferAuthorization.findUniqueOrThrow({where:{id:fullGrant.signed.authorization.id}})).state,'REJECTED');
    assert.equal(JSON.parse((await r.db.cpuJob.findUniqueOrThrow({where:{id:pushId}})).metadataJson).delivery.failure.reason,'ARTIFACT_CACHE_FULL');
    await assert.rejects(r.directTransfers.transferRejected(worker.paired.peer,{authorizationId:fullGrant.signed.authorization.id,code:'ARTIFACT_CACHE_FULL'}),/TRANSFER_RECEIPT_SCOPE/);
    await r.directTransfers.deliveryFailed(worker.paired.peer,{authorizationId:fullGrant.signed.authorization.id});
    assert.equal(JSON.parse((await r.db.cpuJob.findUniqueOrThrow({where:{id:pushId}})).metadataJson).delivery.failure.reason,'ARTIFACT_CACHE_FULL');
    assert.equal(r.artifacts.available(data.input),false);assert.equal(await r.db.attempt.count({where:{id:pushId}}),0);
  }finally{r.artifacts.limits.cacheBytes=cacheLimit;}
  const relayGrant=await relayIssue();
  assert.ok(relayGrant.signed.authorization.expiresAt<=relayData.deadlineAt);
  const occupied=Array.from({length:4},()=>r.artifacts.acquireTransferSlot());
  try{
    await assert.rejects(target.request({action:'send',grant:relayGrant,bytes:bytes.toString('base64')}));
    assert.equal((await r.db.transferAuthorization.findUniqueOrThrow({where:{id:relayGrant.signed.authorization.id}})).state,'ISSUED','HTTP capacity rejection happens before consuming the grant');
  }finally{for(const release of occupied)release();}
  await target.request({action:'send',grant:relayGrant,bytes:bytes.toString('base64')});
  assert.equal(await r.directTransfers.relayConfirmed(pushId,relayDeliveryId),true);
  assert.deepEqual(await r.artifacts.readForControl(data.input),bytes);
  await assert.rejects(target.request({action:'send',grant:relayGrant,bytes:bytes.toString('base64')}));
  const received=JSON.parse((await r.db.cpuJob.findUniqueOrThrow({where:{id:pushId}})).metadataJson).delivery.received;
  await r.directTransfers.relayReceipt(relayGrant.signed.authorization.id,ref.contentHash,bytes.length);
  assert.deepEqual(JSON.parse((await r.db.cpuJob.findUniqueOrThrow({where:{id:pushId}})).metadataJson).delivery.received,received,'duplicate confirmation cannot extend retention or budget');
  assert.equal(await r.db.attempt.count({where:{id:pushId}}),0);
  await assert.rejects(r.directTransfers.issue(app.peer,{attemptId:pushId,endpointId:r.store.senderInstanceId,deliveryId:relayDeliveryId,operation:'WRITE'}),/DELIVERY_SCOPE/);
  const capacity=[];for(let i=0;i<4;i++)capacity.push(await relayIssue());
  await assert.rejects(relayIssue(),/RELAY_BUSY/);
  await r.db.transferAuthorization.updateMany({where:{id:{in:capacity.map(g=>g.signed.authorization.id)}},data:{state:'REVOKED'}});
  const cancelledRelay=await relayIssue();
  await r.db.sdkWorkflowJob.update({where:{id},data:{state:'CANCEL_REQUESTED'}});
  await assert.rejects(target.request({action:'send',grant:cancelledRelay,bytes:bytes.toString('base64')}));
  await r.db.sdkWorkflowJob.update({where:{id},data:{state:'ACTIVE'}});
  relayData.deadlineAt=Date.now()-1;await r.db.cpuJob.update({where:{id:pushId},data:{metadataJson:JSON.stringify(relayData)}});
  await assert.rejects(relayIssue(),/DELIVERY_SCOPE/);
  const partialId=randomUUID(),partialRef={...ref,artifactId:'partial-'+partialId},partialData={...data,input:{...data.input,ref:partialRef}};
  await r.db.cpuJob.create({data:{id:partialId,groupId:group,principalId:principal,sourceHolderId:app.peer.holderInstanceId,state:'WAITING_INPUT',metadataJson:JSON.stringify(partialData)}});
  const partialGrant=await r.directTransfers.issue(app.peer,{attemptId:partialId,endpointId:right.endpoint.id,operation:'WRITE'});
  await source.request({action:'partial',grant:partialGrant,bytes:bytes.toString('base64')});
  assert.equal((await r.db.transferAuthorization.findUniqueOrThrow({where:{id:partialGrant.signed.authorization.id}})).state,'CONSUMED');
  assert.equal(await r.directTransfers.hasInput(group,worker.paired.peer.holderInstanceId,app.peer.app.appInstanceId,partialRef),false);
  await assert.rejects(source.request({action:'send',grant:partialGrant,bytes:bytes.toString('base64')}));
  const resumed=await r.directTransfers.issue(app.peer,{attemptId:partialId,endpointId:right.endpoint.id,operation:'WRITE'});assert.notEqual(resumed.signed.authorization.id,partialGrant.signed.authorization.id);
  await source.request({action:'send',grant:resumed,bytes:bytes.toString('base64')});assert.equal(await r.db.attempt.count({where:{id:partialId}}),0);
  const oldNetwork=await issue();await r.directTransfers.resetNetwork(app.peer);await assert.rejects(send(oldNetwork));
  const oldEndpoint=await issue();target.close();target=processEndpoint();
  const restartedEndpoint=await target.request({action:'open',directory:path.join(r.config.dataDir,'target'),connection:connection(worker.paired,worker.invite)}),replacement=restartedEndpoint.endpoint;
  assert.notEqual(restartedEndpoint.pid,right.pid);assert.notEqual(replacement.epoch,right.endpoint.epoch);assert.equal(replacement.fingerprint,right.endpoint.fingerprint);
  await assert.rejects(send(oldEndpoint));await assert.rejects(r.directTransfers.consume(worker.paired.peer,oldEndpoint));
  await assert.rejects(issue(),/TRANSFER_PLAN_CHANGED/);
  data.plan.decision.suggestion[0].inputEndpointEpoch=replacement.epoch;
  await r.db.cpuJob.update({where:{id},data:{metadataJson:JSON.stringify(data)}});
  const revocable=await issue(),{DirectTransfers}=require('../dist/direct-transfers');
  const nextCoordinatorEpoch=new DirectTransfers(r.db,r.identity.key,r.identity.cert,'SIMULATED',()=>r.epoch+1);
  await assert.rejects(nextCoordinatorEpoch.consume(worker.paired.peer,revocable),/TRANSFER_PROOF_INVALID/);
  await r.auth.revoke(app.peer.credentialId);
  await assert.rejects(send(revocable));await assert.rejects(issue(),/TRANSFER_CREDENTIAL_REVOKED/);
 }finally{source.close();target.close();await r.close();}
});

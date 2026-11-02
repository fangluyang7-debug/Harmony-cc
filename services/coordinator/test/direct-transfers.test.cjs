const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {fork}=require('node:child_process'),{randomUUID}=require('node:crypto');
const {runtime}=require('./helpers.cjs'),{transferDigest}=require('@harmony/resource-transport');

function processEndpoint(){
 const child=fork(path.join(__dirname,'direct-endpoint-child.cjs'),[],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true}),pending=new Map();
 child.on('message',message=>{const p=pending.get(message.id);if(!p)return;pending.delete(message.id);clearTimeout(p.timer);message.error?p.reject(Error(message.error)):p.resolve(message.value);});
 child.on('exit',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('ENDPOINT_PROCESS_EXITED'));}pending.clear();});
 return {child,request:body=>new Promise((resolve,reject)=>{const id=randomUUID(),timer=setTimeout(()=>{pending.delete(id);reject(Error('ENDPOINT_FIXTURE_TIMEOUT'));},20000);pending.set(id,{resolve,reject,timer});child.send({id,...body});}),close:()=>{child.disconnect();child.kill();}};
}

test('independent endpoint processes consume single-use scoped grants online and invalidate network epochs',async()=>{
 const r=await runtime({cpuHost:true}),source=processEndpoint(),target=processEndpoint();
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
  data.offer.task.nodeId='parent';data.output=data.input;
  await r.db.cpuJob.update({where:{id},data:{metadataJson:JSON.stringify(data)}});
  const parentNode=JSON.stringify([id,'parent']);
  await r.db.node.create({data:{id:parentNode,workflowId:id,currentAttemptId:id,state:'COMMITTED'}});
  await r.db.receipt.create({data:{id,attemptId:id,committed:true,recordJson:JSON.stringify({state:'SUCCEEDED',outputs:[ref]})}});
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
  const oldNetwork=await issue();await r.directTransfers.resetNetwork(app.peer);await assert.rejects(send(oldNetwork));
  const oldEndpoint=await issue();await target.request({action:'register'});await assert.rejects(send(oldEndpoint));
  await assert.rejects(issue(),/TRANSFER_PLAN_CHANGED/);
  await r.auth.revoke(app.peer.credentialId);await assert.rejects(issue(),/TRANSFER_CREDENTIAL_REVOKED/);
 }finally{source.close();target.close();await r.close();}
});

const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {runtime}=require('./helpers.cjs');
const {CpuHost}=require('../../pc-agent/dist/host'),{DurableLedger}=require('../../pc-agent/dist/durable-ledger');
const {SchedulerSdk}=require('@harmony/scheduler-client'),{nodeSdkPort}=require('@harmony/scheduler-client/dist/node');
test('registered App host qualifies and executes SDK work through the shared planner and durable ledger',async()=>{
 const r=await runtime({cpuHost:true});let host,remoteHost;const errors=[];
 try{
  const holder=randomUUID(),device=randomUUID(),group=randomUUID(),capacity=[{resourcePoolId:'cpu',amount:1},{resourcePoolId:'ram',amount:268435456}];
  const invite=await r.auth.invite(group,randomUUID(),device,r.url),owner=await r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:holder});
  await r.allotments.confirmDevice(device,capacity,[{groupId:group,holderInstanceId:holder,appInstanceId:null}]);
  const invitation=await r.apps.register(owner.peer,{label:'Local host fixture',allowedContracts:['text.count.v1'],maxConcurrent:1,resources:capacity,offlineBase:capacity,onlineExtra:[]},r.url);
  const registered=await r.apps.exchange({registrationId:invitation.registrationId,code:invitation.code}),peer=registered.peer;
  const identity={groupId:group,deviceId:device,holderInstanceId:peer.holderInstanceId,appInstanceId:peer.app.appInstanceId};
  const connection={address:r.url,certificate:invite.certificate,fingerprint:invite.fingerprint,credential:registered.credential,domain:'SIMULATED'};
  const directory=path.join(r.config.dataDir,'app-ledger'),ledger=await DurableLedger.open(directory,identity,invite.certificate);await ledger.close();
  const config={directory,identity,connection,controlIntervalMs:500,contribution:{ownerMode:'dedicated',maxCpuThreads:1,maxMemoryBytes:268435456,reserveMemoryBytes:0}};
  await assert.rejects(CpuHost.open({...config,connection:{...connection,credential:owner.credential}}),/APP_REGISTRATION_REQUIRED/);
  host=await CpuHost.open(config,e=>errors.push(String(e)));host.start();
  const deadline=Date.now()+45000;let ready=false;
  while(Date.now()<deadline){try{const profiles=await r.directory.profiles(group);if(profiles.length){const built=await r.snapshots.build(group);if(built.snapshot.candidates.length===1){ready=true;break;}}}catch{}await new Promise(resolve=>setTimeout(resolve,200));}
  assert.ok(ready,JSON.stringify(errors));
  const otherInvitation=await r.apps.register(owner.peer,{label:'Other App fixture',allowedContracts:['text.count.v1'],maxConcurrent:1,resources:capacity,offlineBase:[],onlineExtra:[]},r.url);
  const other=await r.apps.exchange({registrationId:otherInvitation.registrationId,code:otherInvitation.code});
  const otherSdk=new SchedulerSdk(nodeSdkPort({...connection,credential:other.credential}),{capacityWaitMs:0});
  const foreignInput=await otherSdk.registerInput(Buffer.from('{"text":"private"}'),'text.input');
  await assert.rejects(otherSdk.plan({version:3,id:randomUUID(),outputContract:'text.counts',qualityTarget:'reference',nodes:[{id:'compute',capability:'text.count.v1',input:foreignInput,parameters:'{}',dependsOn:[]}]},{requestId:randomUUID(),budgetMs:30000,resultDestination:'ORIGIN'}),/NO_LEGAL_PLAN/);
  const sdk=host.sdk(),input=await sdk.registerInput(Buffer.from('{"text":"App host"}'),'text.input'),id=randomUUID();
  const task=await sdk.submit({version:3,id,outputContract:'text.counts',qualityTarget:'reference',nodes:[{id:'compute',capability:'text.count.v1',input,parameters:'{}',dependsOn:[]}]},{requestId:id,budgetMs:30000,resultDestination:'ORIGIN',inputLocation:'ORIGIN'});
  const result=await task.result();assert.deepEqual(JSON.parse(Buffer.from(result.output)),{characters:8,words:2,lines:1});
  const job=await r.db.cpuJob.findUnique({where:{id}}),data=JSON.parse(job.metadataJson);
  assert.equal(data.holderId,peer.holderInstanceId);assert.equal(data.offer.task.app.appInstanceId,identity.appInstanceId);
  assert.deepEqual(data.offer.transferPlan,[]);assert.equal(r.artifacts.available(data.input),false);assert.equal(r.artifacts.available(data.output),false);
  assert.equal((await r.db.receipt.findUnique({where:{id}})).committed,true);
  assert.equal(host.ledger.snapshot().grant.appInstanceId,identity.appInstanceId);
  // A crash before atomic attempt/outbox creation has positive non-delivery evidence.
  const recoveryId=randomUUID(),recoveryWorkflow={version:3,id:recoveryId,outputContract:'text.counts',qualityTarget:'reference',nodes:[{id:'compute',capability:'text.count.v1',input,parameters:'{}',dependsOn:[]}]};
  await sdk.plan(recoveryWorkflow,{requestId:recoveryId,budgetMs:30000,resultDestination:'ORIGIN',inputLocation:'ORIGIN'});
  const pending=await r.db.cpuJob.findUnique({where:{id:recoveryId}}),pendingData=JSON.parse(pending.metadataJson);
  pendingData.offer.task.coordinatorEpoch=r.epoch-1;
  await r.db.cpuJob.update({where:{id:recoveryId},data:{state:'DISPATCHING',metadataJson:JSON.stringify(pendingData)}});
  assert.equal(await r.db.attempt.count({where:{id:recoveryId}}),0);
  assert.equal(await r.db.outbox.count({where:{attemptId:recoveryId}}),0);
  await r.sdk.start(peer,recoveryId);
  const recovered=await sdk.resume(recoveryId).result();assert.equal(JSON.parse(Buffer.from(recovered.output)).characters,8);
  assert.equal(await r.db.attempt.count({where:{id:recoveryId}}),1);
  // Hold an admitted transfer so cancellation cannot race a tiny CPU job to completion.
  const runtime=host.agent.runtime,read=runtime.ports.read;
  let release,entered;const gate=new Promise(resolve=>{release=resolve;}),loading=new Promise(resolve=>{entered=resolve;});
  runtime.ports.read=async(...args)=>{entered();await gate;return read(...args);};
  try{
    const cancelId=randomUUID(),cancelTask=await sdk.submit({version:3,id:cancelId,outputContract:'text.counts',qualityTarget:'reference',nodes:[{id:'compute',capability:'text.count.v1',input,parameters:'{}',dependsOn:[]}]},{requestId:cancelId,budgetMs:30000,resultDestination:'ORIGIN',inputLocation:'ORIGIN'});
    await loading;
    assert.equal(JSON.parse(await cancelTask.cancel()).state,'CANCEL_REQUESTED');
    await assert.rejects(r.jobs.execution(other.peer,cancelId,'control',{}),/EXECUTION_SCOPE/);
    const until=Date.now()+5000;while(!host.ledger.snapshot().entries.find(e=>e.record.attemptId===cancelId)?.cancelRequested&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,50));
    const entry=host.ledger.snapshot().entries.find(e=>e.record.attemptId===cancelId);
    assert.equal(entry.cancelRequested,true,JSON.stringify({errors,control:await r.jobs.execution(peer,cancelId,'control',{}),pending:host.agent.pending.size}));assert.equal(entry.record.resourcesSettled,false);
    assert.equal((await r.db.cpuJob.findUnique({where:{id:cancelId}})).state,'CANCEL_REQUESTED');
    release();await assert.rejects(cancelTask.result(),/JOB_CANCELLED_SETTLED/);
    assert.equal(host.ledger.status(cancelId).resourcesSettled,true);
    assert.equal(JSON.parse(await cancelTask.cancel()).state,'CANCELLED_SETTLED');
  }finally{release();runtime.ports.read=read;}


  const remoteDevice=randomUUID(),remoteHolder=randomUUID(),remoteInvite=await r.auth.invite(group,randomUUID(),remoteDevice,r.url);
  const remotePeer=await r.auth.exchange({inviteId:remoteInvite.inviteId,code:remoteInvite.code,holderInstanceId:remoteHolder});
  await r.allotments.confirmDevice(remoteDevice,capacity,[{groupId:group,holderInstanceId:remoteHolder,appInstanceId:null}]);
  const remoteIdentity={groupId:group,deviceId:remoteDevice,holderInstanceId:remoteHolder,appInstanceId:null},remoteDirectory=path.join(r.config.dataDir,'remote-ledger');
  const remoteLedger=await DurableLedger.open(remoteDirectory,remoteIdentity,invite.certificate);await remoteLedger.close();
  remoteHost=await CpuHost.open({...config,directory:remoteDirectory,identity:remoteIdentity,connection:{...connection,credential:remotePeer.credential}},e=>errors.push(String(e)));remoteHost.start();
  // Deterministic cost estimates; both selected hosts still execute real CPU work through TLS.
  const localExecutor=host.executor.bind(host),remoteExecutor=remoteHost.executor.bind(remoteHost);let localCost=1,remoteCost=10000;
  host.executor=(...args)=>{const e=localExecutor(...args);e.compute={...e.compute,value:localCost,source:'PRIOR',sampledAt:Date.now()+host.clockOffset};return e;};
  remoteHost.executor=(...args)=>{const e=remoteExecutor(...args);e.compute={...e.compute,value:remoteCost,source:'PRIOR',sampledAt:Date.now()+remoteHost.clockOffset};return e;};
  for(const local of [true,false]){
    localCost=local?1:10000;remoteCost=local?10000:1;
    const limit=Date.now()+45000;let seen=false;
    while(Date.now()<limit){
      await host.tick(false);await remoteHost.tick(false);
      const candidates=(await r.snapshots.build(group)).snapshot.candidates;
      if(candidates.some(c=>c.holderInstanceId===peer.holderInstanceId&&c.computeMs===localCost)&&candidates.some(c=>c.holderInstanceId===remoteHolder&&c.capability==='text.count.v1'&&c.computeMs===remoteCost)){seen=true;break;}
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    assert.ok(seen,JSON.stringify({message:'both real hosts must qualify with the controlled cost estimates',errors,candidates:(await r.snapshots.build(group)).snapshot.candidates.map(c=>({holder:c.holderInstanceId,compute:c.computeMs,capability:c.capability}))}));
    const choiceId=randomUUID(),chosen=await sdk.submit({version:3,id:choiceId,outputContract:'text.counts',qualityTarget:'reference',nodes:[{id:'compute',capability:'text.count.v1',input,parameters:'{}',dependsOn:[]}]},{requestId:choiceId,budgetMs:30000,resultDestination:'ORIGIN',inputLocation:'ORIGIN'});
    const chosenResult=await chosen.result();assert.equal(chosenResult.status.deviceId,local?device:remoteDevice);
    const metadata=JSON.parse((await r.db.cpuJob.findUnique({where:{id:choiceId}})).metadataJson);
    assert.equal(r.artifacts.available(metadata.input),!local);assert.equal(r.artifacts.available(metadata.output),!local);
  }
 }finally{await remoteHost?.close();await host?.close();await r.close();}
});

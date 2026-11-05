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
  const sdk=host.sdk(),request=sdk.port.request.bind(sdk.port);
  sdk.port.request=async(route,body)=>{try{return await request(route,body);}catch(error){error.requestRoute=route;error.hostErrors=[...errors];throw error;}};
  const input=await sdk.registerInput(Buffer.from('{"text":"App host"}'),'text.input'),id=randomUUID();
  const task=await sdk.submit({version:3,id,outputContract:'text.counts',qualityTarget:'reference',nodes:[{id:'compute',capability:'text.count.v1',input,parameters:'{}',dependsOn:[]}]},{requestId:id,budgetMs:30000,resultDestination:'ORIGIN',inputLocation:'ORIGIN'});
  const result=await task.result();assert.deepEqual(JSON.parse(Buffer.from(result.output)),{characters:8,words:2,lines:1});
  const job=await r.db.cpuJob.findUnique({where:{id}}),data=JSON.parse(job.metadataJson);
  assert.equal(data.holderId,peer.holderInstanceId);assert.equal(data.offer.task.app.appInstanceId,identity.appInstanceId);
  assert.deepEqual(data.offer.transferPlan,[]);assert.equal(r.artifacts.available(data.input),false);assert.equal(r.artifacts.available(data.output),false);
  assert.equal((await r.db.receipt.findUnique({where:{id}})).committed,true);
  assert.equal(host.ledger.snapshot().grant.appInstanceId,identity.appInstanceId);
  for(const state of ['DISPATCHING','WAITING_INPUT']){
    await r.db.cpuJob.update({where:{id},data:{state}});
    await r.sdk.start(peer,id);
    assert.equal(await r.db.attempt.count({where:{id}}),1);
    assert.equal((await r.db.cpuJob.findUnique({where:{id}})).metadataJson,job.metadataJson);
  }

  // A crash before atomic attempt/outbox creation has positive non-delivery evidence.
  const recoveryId=randomUUID(),recoveryWorkflow={version:3,id:recoveryId,outputContract:'text.counts',qualityTarget:'reference',nodes:[{id:'compute',capability:'text.count.v1',input,parameters:'{}',dependsOn:[]}]};
  await sdk.plan(recoveryWorkflow,{requestId:recoveryId,budgetMs:30000,resultDestination:'ORIGIN',inputLocation:'ORIGIN'});
  const pending=await r.db.cpuJob.findUnique({where:{id:recoveryId}}),pendingData=JSON.parse(pending.metadataJson);
  pendingData.offer.task.coordinatorEpoch=r.epoch-1;
  await r.db.cpuJob.update({where:{id:recoveryId},data:{state:'DISPATCHING',metadataJson:JSON.stringify(pendingData)}});
  assert.equal(await r.db.attempt.count({where:{id:recoveryId}}),0);
  assert.equal(await r.db.outbox.count({where:{attemptId:recoveryId}}),0);
  await Promise.all([r.sdk.start(peer,recoveryId),r.sdk.start(peer,recoveryId)]);
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
      if(candidates.some(c=>c.holderInstanceId===peer.holderInstanceId&&c.costEvidence?.compute.value===localCost)&&candidates.some(c=>c.holderInstanceId===remoteHolder&&c.capability==='text.count.v1'&&c.costEvidence?.compute.value===remoteCost)){seen=true;break;}
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    assert.ok(seen,JSON.stringify({message:'both real hosts must qualify with the controlled cost estimates',errors,candidates:(await r.snapshots.build(group)).snapshot.candidates.map(c=>({holder:c.holderInstanceId,compute:c.costEvidence?.compute.value,capability:c.capability}))}));
    // Exercise the calibration fallback using an input size with no committed timing history.
    const choiceInput=await sdk.registerInput(Buffer.from(JSON.stringify({text:'App host'})+' '.repeat(local?128:512)),'text.input');
    const choiceId=randomUUID(),chosen=await sdk.submit({version:3,id:choiceId,outputContract:'text.counts',qualityTarget:'reference',nodes:[{id:'compute',capability:'text.count.v1',input:choiceInput,parameters:'{}',dependsOn:[]}]},{requestId:choiceId,budgetMs:30000,resultDestination:'ORIGIN',inputLocation:'ORIGIN'});
    const chosenResult=await chosen.result();assert.equal(chosenResult.status.deviceId,local?device:remoteDevice);
    const metadata=JSON.parse((await r.db.cpuJob.findUnique({where:{id:choiceId}})).metadataJson);
    const relayedInput=r.artifacts.available(metadata.input);
    if(local)assert.equal(relayedInput,false);
    else if(metadata.offer.transferPlan.length===0){
      assert.ok((await r.db.transferAuthorization.findMany({where:{attemptId:choiceId,state:'COMPLETED'}})).some(row=>JSON.parse(row.metadataJson).authorization.operation==='WRITE'));
      const copy=remoteHost.dataHost?.channel.lookup(group,metadata.input.ref);if(copy)assert.equal(copy.ref.contentHash,metadata.input.ref.contentHash);
      assert.deepEqual(metadata.offer.transferPlan,[],'a completed upload is executor-local at dispatch');
    }
    assert.equal(r.artifacts.available(metadata.output),false,'verified result acknowledgment releases relay bytes');assert.ok(metadata.resultReceivedAt);
    const observationId='execute:'+JSON.stringify([group,metadata.holderId,chosenResult.status.targetId]);
    let feedback;
    for(const end=Date.now()+8000;Date.now()<end;){
      const row=await r.db.costObservation.findUnique({where:{id:observationId}});
      feedback=row&&JSON.parse(row.metadataJson).samples.find(s=>s.id===choiceId);
      if(feedback)break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.ok(feedback?.ms>0,'authenticated EXECUTE trace reaches the target cost bucket');
  }
  localCost=10;remoteCost=10000;
  // Inject only the earlier occupancy. The profile, dispatch transaction and CPU job use the real host connection.
  let inject=true;const publish=host.agent.publishProfile.bind(host.agent);
  host.agent.publishProfile=async profile=>{
    if(inject){
      const target=profile.executors.find(e=>e.contract.capability==='text.count.v1');
      for(const pool of profile.pools){const resource=target.resources.find(r=>r.resourcePoolId===pool.resourcePoolId);if(resource)pool.occupied={...pool.occupied,value:resource.amount};}
      const remaining={value:1600,unit:'ms',source:'SIMULATED',sampledAt:profile.ownerActivity.sampledAt,ttlMs:4000};
      profile.inFlight=[{attemptId:'fixture-running',targetId:target.target.targetId,state:'RUNNING',resources:target.resources,elapsed:{...remaining,value:200},remaining}];
      profile.credits.forEach(c=>c.slots=0);
    }
    return publish(profile);
  };
  const busyId=randomUUID(),busyInput=await sdk.registerInput(Buffer.from(JSON.stringify({text:'busy'})+' '.repeat(1024)),'text.input');
  await host.tick(false);await remoteHost.tick(false);
  const {dispatchDiagnostics}=require('../dist/dispatch-diagnostics');
  const waitDeadline=Date.now()+15000;
  const work=sdk.submit({version:3,id:busyId,outputContract:'text.counts',qualityTarget:'reference',nodes:[{id:'compute',capability:'text.count.v1',input:busyInput,parameters:'{}',dependsOn:[]}]},{requestId:busyId,budgetMs:30000,resultDestination:'ORIGIN',inputLocation:'ORIGIN'});
  const releaseBusyHost=async()=>{
    while(Date.now()<waitDeadline&&!dispatchDiagnostics.recent(group).some(d=>d.jobId===busyId&&d.kind==='PLANNED_WAIT'))await new Promise(resolve=>setTimeout(resolve,30));
    const waited=dispatchDiagnostics.recent(group).some(d=>d.jobId===busyId&&d.kind==='PLANNED_WAIT');
    const dispatched=await r.db.attempt.findUnique({where:{id:busyId}});
    inject=false;await host.tick(false);
    assert.equal(waited,true,'planner selected the occupied host and waited on its reported capacity');
    assert.equal(dispatched,null,'predicted release alone never persists an offer');
  };
  const [busyTask]=await Promise.all([work,releaseBusyHost()]);
  assert.equal((await busyTask.result()).status.deviceId,device);
  const spans=(await r.db.traceSpan.findMany({where:{groupId:group}})).map(row=>JSON.parse(row.metadataJson).span);
  assert.ok(spans.some(s=>s?.attemptId===busyId&&s.phase==='QUEUE'&&s.reasonCode==='PLANNED_WAIT'&&s.predictedMs>0&&s.durationMs>=0));
 }finally{await remoteHost?.close();await host?.close();await r.close();}
});

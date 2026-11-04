const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {runtime}=require('./helpers.cjs'),{builtinCpuPacks,cpuConfiguration}=require('@harmony/reference-capabilities');
const {CpuHost}=require('../../pc-agent/dist/host'),{DurableLedger}=require('../../pc-agent/dist/durable-ledger');
const base=builtinCpuPacks()[0],raw=Buffer.from('{"text":"graph"}'),counts=Buffer.from('{"characters":5,"words":1,"lines":1}');
function identityPack(id,schema,bytes){return {...base,maxOutputBytes:4096,manifest:{...base.manifest,packId:id,contract:{...base.manifest.contract,contractId:id,capability:id,serviceId:id,inputSchemas:[schema],outputSchemas:[schema]}},cases:[{id:'identity',input:bytes,parameters:'{}',config:cpuConfiguration,maxOutputBytes:4096}],evaluate:async(_c,out)=>out.equals(bytes)?1:0};}
const isolateBC=process.env.HARMONY_TEST_BLOCK_BC==='1';
const collect=identityPack('source.collect.v1','text.input',raw),final=identityPack('source.finish.v1','text.counts',counts);
async function until(fn){const end=Date.now()+60000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,150));}throw Error('GRAPH_HOST_TIMEOUT');}
test(isolateBC?'S5 relay isolation: committed B output crosses relay to C without recomputation':'SDK three-node graph moves a private source result to a remote worker and returns to the fixed source service',async()=>{
 const r=await runtime({cpuHost:true,referencePacks:[...builtinCpuPacks(),collect,final]}),hosts=[],errors=[];
 try{
  const group=randomUUID(),capacity=[{resourcePoolId:'cpu',amount:1},{resourcePoolId:'ram',amount:268435456}];
  let source,producer;
  for(const isApp of [true,false]){
   const device=randomUUID(),holder=randomUUID(),invite=await r.auth.invite(group,randomUUID(),device,r.url),owner=await r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:holder});
   await r.allotments.confirmDevice(device,capacity,[{groupId:group,holderInstanceId:holder,appInstanceId:null}]);
   let paired=owner;
   if(isApp){const invitation=await r.apps.register(owner.peer,{label:'Graph source',allowedContracts:['text.count.v1',collect.manifest.contract.contractId,final.manifest.contract.contractId],maxConcurrent:2,resources:capacity.map(r=>({...r,amount:r.amount*2})),offlineBase:capacity,onlineExtra:[]},r.url);paired=await r.apps.exchange({registrationId:invitation.registrationId,code:invitation.code});source=paired;}else producer=paired;
   const identity={groupId:group,deviceId:device,holderInstanceId:paired.peer.holderInstanceId,appInstanceId:paired.peer.app?.appInstanceId??null},directory=path.join(r.config.dataDir,identity.holderInstanceId),ledger=await DurableLedger.open(directory,identity,invite.certificate);await ledger.close();
   const host=await CpuHost.open({directory,identity,connection:{address:r.url,certificate:invite.certificate,fingerprint:invite.fingerprint,credential:paired.credential,domain:'SIMULATED'},controlIntervalMs:1500,contribution:{ownerMode:'dedicated',maxCpuThreads:1,maxMemoryBytes:268435456,reserveMemoryBytes:0},...(isApp?{fixedServices:[collect,final].map(pack=>({pack,execute:async input=>({bytes:input,schemaId:pack.manifest.contract.outputSchemas[0]})}))}:{})},e=>errors.push(String(e)));hosts.push(host);host.start();
  }
  await until(async()=>{try{const c=(await r.snapshots.build(group)).snapshot.candidates;return c.some(c=>c.capability===collect.manifest.contract.capability)&&c.some(c=>c.capability===final.manifest.contract.capability)&&c.some(c=>c.capability==='text.count.v1'&&c.appInstanceId===undefined);}catch{return false;}});
  const remote=(await r.snapshots.build(group)).snapshot.candidates.find(c=>c.capability==='text.count.v1'&&c.appInstanceId===undefined);
  const sdk=hosts[0].sdk(),input=await sdk.registerInput(raw,'text.input'),id=randomUUID(),workflow={version:3,id,outputContract:'text.counts',qualityTarget:'reference',nodes:[
   {id:'collect',capability:collect.manifest.contract.capability,input,parameters:'{}',dependsOn:[]},
   {id:'count',capability:'text.count.v1',inputFrom:'collect',parameters:'{}',dependsOn:['collect'],targetId:remote.targetId},
   {id:'finish',capability:final.manifest.contract.capability,inputFrom:'count',parameters:'{}',dependsOn:['count']}
  ]};
  let endpoint;
  await until(async()=>{endpoint=(await r.directTransfers.list(source.peer)).find(e=>e.holderInstanceId===remote.holderInstanceId);return !!endpoint;});
  for(const host of hosts){host.peerLinks.close();await host.networkPending;}
  const network=await r.directTransfers.resetNetwork(source.peer);
  await r.directTransfers.reportLink(source.peer,{epoch:network.epoch,endpointId:endpoint.id,endpointEpoch:endpoint.epoch,direction:'WRITE',reason:'REACHABLE',samples:[1024,8192,32768].map(bytes=>({bytes,durationMs:0.01+bytes/1000000}))});
  const receiver=hosts[0].dataHost.identity(),back=await r.directTransfers.resetNetwork(producer.peer);
  await r.directTransfers.reportLink(producer.peer,{epoch:back.epoch,endpointId:receiver.id,endpointEpoch:receiver.epoch,direction:'WRITE',reason:'REACHABLE',samples:[1024,8192,32768].map(bytes=>({bytes,durationMs:0.01+bytes/1000000}))});
  await r.profiles.refresh(group);
  // Deterministic regression: remove direct-link evidence after the verified copy
  // arrives, before the downstream start re-plans. The received replica must win.
  let uploaded=false,directUploads=0;const originalWrite=sdk.port.write,originalStart=r.jobs.start.bind(r.jobs);
  r.jobs.start=async(peer,jobId,...rest)=>{const row=await r.db.cpuJob.findUnique({where:{id:jobId}}),task=row?JSON.parse(row.metadataJson).offer.task:null;if(task?.workflowId===id&&task.nodeId==='count'&&!uploaded)throw Error('INPUT_NOT_UPLOADED');return originalStart(peer,jobId,...rest);};
  const originalReceipt=r.directTransfers.receipt.bind(r.directTransfers);
  r.directTransfers.receipt=async(peer,receipt)=>{
   const reply=await originalReceipt(peer,receipt),grant=await r.db.transferAuthorization.findUniqueOrThrow({where:{id:receipt.authorizationId}}),authorization=JSON.parse(grant.metadataJson).authorization;
   const job=await r.db.cpuJob.findUnique({where:{id:authorization.attemptId}}),d=job&&JSON.parse(job.metadataJson);
   if(d?.offer.task.workflowId===id&&d.offer.task.nodeId==='count'&&!uploaded){
    directUploads++;assert.equal(await r.directTransfers.hasInput(group,remote.holderInstanceId,source.peer.app.appInstanceId,authorization.ref),true);
    await r.directTransfers.resetNetwork(source.peer);await r.profiles.refresh(group);uploaded=true;
   }return reply;
  };
  const invalid=structuredClone(workflow);invalid.nodes[1].inputFrom='missing';await assert.rejects(sdk.plan(invalid,{requestId:randomUUID(),budgetMs:30000,resultDestination:'ORIGIN'}),/SDK_GRAPH_EDGE_INVALID/);
  let blockedWrites=0,relayDownloads=0;
  if(isolateBC){
   const read=hosts[0].agent.runtime.ports.read;hosts[0].agent.runtime.ports.read=async(ref,offer)=>{
    if(offer.task.workflowId===id&&offer.task.nodeId==='finish'){
      const row=await r.db.cpuJob.findUniqueOrThrow({where:{id:offer.task.attemptId}}),d=JSON.parse(row.metadataJson);
      assert.equal(d.delivery.relay,true);assert.equal(await r.directTransfers.relayConfirmed(row.id,d.delivery.id),true);
      assert.ok(offer.transferPlan.some(p=>p.from===r.store.senderInstanceId));
      const bytes=await read(ref,offer);assert.deepEqual(bytes,counts);relayDownloads++;return bytes;
    }return read(ref,offer);
   };
  }
  if(isolateBC){
   // Break only incoming direct business transfers at C. Both hosts keep their
   // authenticated coordinator connections and relay transport untouched.
   const server=hosts[0].dataHost.server,handlers=server.listeners('request');
   server.removeAllListeners('request');server.on('request',(req,res)=>{
    if(req.method==='PUT'&&req.url.startsWith('/v2/direct/')&&!req.url.startsWith('/v2/direct/probe')){blockedWrites++;req.destroy();return;}
    for(const handler of handlers)handler.call(server,req,res);
   });
  }
  const task=await sdk.submit(workflow,{requestId:id,budgetMs:30000,resultDestination:'ORIGIN',inputLocation:'ORIGIN',priority:'REMOTE_BATCH'});
  let result;
  try{result=await task.result();}finally{
   if(isolateBC){
    const graph=await r.db.sdkWorkflowJob.findUniqueOrThrow({where:{id}}),g=JSON.parse(graph.metadataJson);
    const rows=await r.db.cpuJob.findMany({where:{groupId:group}}),jobs=rows.map(row=>({row,data:JSON.parse(row.metadataJson)})).filter(x=>x.data.offer.task.workflowId===id);
    const attempts=await r.db.attempt.findMany({where:{workflowId:id}});
    console.log('RELAY_ISOLATION_EVIDENCE '+JSON.stringify({state:graph.state,blockedWrites,deadlineAt:g.deadlineAt,remainingMs:g.deadlineAt-Date.now(),
     attempts:attempts.map(a=>({nodeId:JSON.parse(a.taskJson).nodeId,state:a.state})),jobs:jobs.map(({row,data:d})=>({nodeId:d.offer.task.nodeId,state:row.state,retained:!!d.retainOutput,delivery:!!d.delivery,preparation:d.delivery?.preparation,received:d.delivery?.received,relayAvailable:d.output?r.artifacts.available(d.output):null,inputRelayAvailable:r.artifacts.available(d.input),deadlineAt:d.deadlineAt,plan:d.plan.decision.suggestion})),
     relayLinks:(await r.snapshots.build(group)).snapshot.links.filter(l=>!l.endpointId).map(l=>({from:l.from,to:l.to,observedAt:l.observedAt,ttlMs:l.ttlMs})),errors:[...new Set(errors)]}));
    assert.equal(attempts.filter(a=>JSON.parse(a.taskJson).nodeId==='count').length,1,'transport failures must not recompute B');
    assert.ok(blockedWrites>0,'the fault must interrupt a real B-to-C business upload');
    assert.equal(relayDownloads,1,'C reads and verifies the relay bytes once');
    assert.ok(g.deadlineAt>Date.now(),'completion must fit the original budget');
    const child=jobs.find(x=>x.data.offer.task.nodeId==='finish').data;
    assert.ok(child.delivery.preparation.uploadMs>0&&child.delivery.preparation.downloadMs>0);
    assert.ok(child.delivery.preparation.estimatedMs<=child.delivery.preparation.remainingMs);
    assert.equal(child.delivery.received.bytes,counts.length);assert.ok(child.delivery.received.remainingMs>0);
    assert.ok(jobs.every(({data:d})=>d.deadlineAt===g.deadlineAt),'all nodes keep the original workflow deadline');
   }
  }

  assert.deepEqual(JSON.parse(Buffer.from(result.output)),JSON.parse(counts));assert.equal(result.status.state,'SUCCEEDED');
  assert.equal(directUploads,1);r.jobs.start=originalStart;sdk.port.write=originalWrite;r.directTransfers.receipt=originalReceipt;
  const attempts=await r.db.attempt.findMany({where:{workflowId:id}});assert.equal(attempts.length,3);assert.equal(new Set(attempts.map(a=>a.nodeId)).size,3);
  const trace=[];
  for(const a of attempts){assert.equal((await r.db.receipt.findUnique({where:{id:a.id}})).committed,true);const offer=JSON.parse(a.offerJson);trace.push([offer.task.nodeId,offer.target.backend,offer.task.workflowId]);}
  assert.equal(trace.find(x=>x[0]==='count')[1],'CPU');assert.equal(trace.find(x=>x[0]==='finish')[1],'SERVICE');
  for(const child of workflow.nodes.filter(n=>n.inputFrom)){
    const jobFor=async node=>JSON.parse((await r.db.cpuJob.findUniqueOrThrow({where:{id:attempts.find(a=>JSON.parse(a.taskJson).nodeId===node).id}})).metadataJson);
    const produced=await jobFor(child.inputFrom),consumed=await jobFor(child.id);
    if(child.id==='finish'){
      assert.ok(produced.retainOutput);assert.equal(r.artifacts.available(produced.output),false);
      assert.ok(consumed.delivery);if(!isolateBC)assert.ok((await r.db.transferAuthorization.findMany({where:{attemptId:consumed.offer.task.attemptId,state:'COMPLETED'}})).length,'direct receipt remains durable after cache release');
    }
    assert.deepEqual(consumed.input,produced.output);
    assert.equal(consumed.sourceAttemptId,produced.offer.task.attemptId);
  }
  const finalJob=await r.db.cpuJob.findUnique({where:{id:attempts.find(a=>JSON.parse(a.taskJson).nodeId==='finish').id}});assert.equal(r.artifacts.available(JSON.parse(finalJob.metadataJson).output),false);
  assert.ok(attempts.every(row=>JSON.parse(row.taskJson).priority==='REMOTE_BATCH'));
  const graphTrace=await r.traces.read(source.peer,id);assert.equal(graphTrace.traceId,id);assert.equal(graphTrace.coverage.sourceSdkRoot,true);assert.ok(graphTrace.coverage.sourceDurationMs>0);assert.equal(graphTrace.coverage.criticalPathPending,true);assert.equal(new Set(graphTrace.spans.map(s=>s.nodeId)).size,3);if(isolateBC){assert.ok(graphTrace.spans.some(s=>s.nodeId==='finish'&&s.phase==='TRANSFER_RECV'));assert.ok(graphTrace.spans.some(s=>s.nodeId==='finish'&&s.phase==='LOAD'));}
  await task.status();assert.equal(await r.db.attempt.count({where:{workflowId:id}}),3,'status must not replay committed nodes');
  const yieldedId=randomUUID(),yieldedWorkflow=structuredClone(workflow);yieldedWorkflow.id=yieldedId;
  const agent=hosts[0].agent,originalRead=agent.runtime.ports.read;
  let interrupted;
  agent.runtime.ports.read=async(ref,offer,...rest)=>{
   if(!interrupted&&offer.task.workflowId===yieldedId&&offer.task.nodeId==='finish'){
    interrupted=offer.task.attemptId;
    await agent.updateResources(capacity,'ACTIVE');
    await agent.updateResources(capacity,'IDLE');
   }
   return originalRead(ref,offer,...rest);
  };
  try{
   const yieldedTask=await sdk.submit(yieldedWorkflow,{requestId:yieldedId,budgetMs:30000,resultDestination:'ORIGIN',inputLocation:'ORIGIN'});
   const resumed=await yieldedTask.result();assert.deepEqual(Buffer.from(resumed.output),counts);
   assert.deepEqual(resumed.status.nodes.find(n=>n.id==='finish').yieldedAttempts,[interrupted]);
   const attempts=await r.db.attempt.findMany({where:{workflowId:yieldedId}});
   assert.equal(attempts.length,4);assert.equal(attempts.find(a=>a.id===interrupted).state,'CANCELLED_SETTLED');
   assert.equal(attempts.filter(a=>a.state==='SUCCEEDED').length,3);
  }finally{agent.runtime.ports.read=originalRead;}
  // Hold the primary publication while a fresh SIMULATED conditional sample
  // triggers normal planning, quota reservation, dispatch and SDK delivery.
  for(const mode of ['slow','dag','quota','offline']){
  const offline=mode==='offline',dag=mode==='dag',quota=mode==='quota';
  const raceId=randomUUID(),held=new Map();let raceEntered,raceRelease,restoreLink=()=>{};
  const enteredGate=new Promise(r=>raceEntered=r),releaseGate=new Promise(r=>raceRelease=r);
  for(const h of hosts){
   const ports=h.agent.runtime.ports,write=ports.publish;held.set(ports,write);
   ports.publish=async(bytes,schema,offer,...rest)=>{
    if(offer.task.workflowId===raceId&&offer.task.nodeId==='compute'&&!offer.task.attemptId.startsWith('backup-')){raceEntered({h,id:offer.task.attemptId});await releaseGate;}
    return write(bytes,schema,offer,...rest);
   };
  }
  try{
   const raceInput=await sdk.registerInput(raw,'text.input');
   const raceNodes=[{id:'compute',capability:'text.count.v1',input:raceInput,dependsOn:[],parameters:'{}'}];
   if(dag)raceNodes.push({id:'finish',capability:final.manifest.contract.capability,inputFrom:'compute',dependsOn:['compute'],parameters:'{}'});
   const raceTask=await sdk.submit({id:raceId,version:3,qualityTarget:'reference',outputContract:'text.counts',nodes:raceNodes},
    {requestId:raceId,budgetMs:30000,resultDestination:'ORIGIN'});
   const {h:primaryHost,id:primaryId}=await enteredGate;
   const primaryRow=await r.db.cpuJob.findUniqueOrThrow({where:{id:primaryId}}),d=JSON.parse(primaryRow.metadataJson);
   const profile=(await r.directory.profiles(group)).find(p=>p.holderInstanceId===d.holderId);
   const sample=value=>({value,unit:'ms',source:'SIMULATED',sampledAt:Date.now()-1000,ttlMs:15000});
   profile.inFlight=[{attemptId:primaryId,targetId:d.offer.target.targetId,state:'RUNNING',resources:d.offer.resources,elapsed:sample(150),remaining:sample(5000),
    history:{samples:24,survivors:2,p90TotalMs:100,p90RemainingMs:6000}}];
   if(quota)await r.db.registeredApp.update({where:{id:source.peer.app.appId},data:{maxConcurrent:1}});
   if(offline){
    const client=primaryHost.agent.client,connect=client.connect.bind(client);
    let reconnect;const gate=new Promise(resolve=>reconnect=resolve);
    client.connect=async()=>{await gate;return connect();};
    restoreLink=()=>{client.connect=connect;reconnect();};
    client.socket.terminate();
   }
   let lastReport=0;
   const reportSlow=async()=>{
    if(offline||Date.now()-lastReport<1500||primaryHost.ledger.pendingMessages().some(m=>m.type==='DeviceProfile'))return;
    lastReport=Date.now();
    const current=(await r.directory.profiles(group)).find(p=>p.holderInstanceId===d.holderId);
    current.inFlight=[{...profile.inFlight[0],elapsed:sample(150),remaining:sample(5000)}];
    try{await primaryHost.agent.publishProfile(current);}catch(e){if(e.message!=='PROFILE_PENDING')throw e;}
   };
   const pendingResult=raceTask.result();void pendingResult.catch(()=>{});
   if(quota){
    await until(async()=>{await reportSlow();return JSON.parse((await r.db.attempt.findUniqueOrThrow({where:{id:primaryId}})).recoveryEstimateJson??'{}').backupRefusal==='APP_QUOTA_EXCEEDED';});
    assert.equal(await r.db.attempt.count({where:{workflowId:raceId}}),1);
    raceRelease();assert.deepEqual(Buffer.from((await pendingResult).output),counts);continue;
   }
   await until(async()=>{await reportSlow();return !!(await r.db.node.findUnique({where:{id:JSON.stringify([raceId,'compute'])}}))?.winnerAttemptId;});
   const node=await r.db.node.findUniqueOrThrow({where:{id:JSON.stringify([raceId,'compute'])}});
   assert.equal(node.winnerAttemptId,node.backupAttemptId);assert.ok(node.winnerAttemptId);
   const both=await r.db.attempt.findMany({where:{workflowId:raceId}});
   assert.equal(both.filter(a=>JSON.parse(a.taskJson).nodeId==='compute').length,2);assert.equal(new Set(both.map(a=>a.holderInstanceId)).size,2);
   assert.equal(JSON.parse(both.find(a=>a.id===primaryId).recordJson).resourcesSettled,false);
   restoreLink();raceRelease();await until(async()=>JSON.parse((await r.db.attempt.findUniqueOrThrow({where:{id:primaryId}})).recordJson).resourcesSettled);
   const value=await pendingResult;assert.deepEqual(Buffer.from(value.output),counts);assert.equal(value.jobId,raceId);
   assert.equal(await r.db.receipt.count({where:{id:{in:[primaryId,node.backupAttemptId]},committed:true}}),1);
   if(dag){
    assert.equal(await r.db.attempt.count({where:{workflowId:raceId}}),3);
    assert.equal(value.status.nodes.find(n=>n.id==='compute').jobId,node.winnerAttemptId);
   }
  }finally{restoreLink();raceRelease();for(const [ports,write] of held)ports.publish=write;if(quota)await r.db.registeredApp.update({where:{id:source.peer.app.appId},data:{maxConcurrent:2}});}
  }
  for(const single of [false,true]){
  const starvedId=randomUUID(),originalChoosers=new Map();let refusedId=null;
  try{
   for(const host of hosts){
    const queue=host.agent.scheduler.queue,choose=queue.choose.bind(queue);originalChoosers.set(queue,choose);
    queue.choose=(...args)=>{
     const offer=choose(...args);
     if(offer?.task.workflowId===starvedId&&offer.task.nodeId===(single?'compute':'encode')){
      refusedId??=offer.task.attemptId;
      if(offer.task.attemptId===refusedId)return null;
     }
     return offer;
    };
   }
   const task=await sdk.submit({id:starvedId,version:3,qualityTarget:'reference',outputContract:'text.counts',nodes:[
    {id:'encode',capability:'text.count.v1',input:await sdk.registerInput(raw,'text.input'),dependsOn:[],parameters:'{}'},
    ...(single?[]:[{id:'finish',capability:final.manifest.contract.capability,inputFrom:'encode',dependsOn:['encode'],parameters:'{}'}])]},
    {requestId:starvedId,budgetMs:30000,resultDestination:'ORIGIN'});
   const result=await task.result();assert.deepEqual(Buffer.from(result.output),counts);assert.equal(result.jobId,starvedId);
   const attempts=await r.db.attempt.findMany({where:{workflowId:starvedId}});
   const refused=attempts.find(a=>a.id===refusedId),ran=attempts.find(a=>a.id!==refusedId&&JSON.parse(a.taskJson).nodeId===(single?'compute':'encode'));
   assert.equal(attempts.length,single?2:3);assert.equal(refused.recordJson,null);
   if(single)assert.equal(result.status.targetId,JSON.parse(ran.offerJson).target.targetId);
   assert.deepEqual(result.status.nodes.find(n=>n.id===(single?'compute':'encode')).reassignedAttempts,[refusedId]);
   assert.equal(JSON.parse(refused.rejectionJson).reply.reasonCode,'QUEUE_STARVED_NOT_STARTED');
   assert.notEqual(ran.holderInstanceId,refused.holderInstanceId);assert.equal(ran.state,'SUCCEEDED');
   assert.equal(await r.db.receipt.count({where:{id:refusedId}}),0);
  }finally{for(const [queue,choose] of originalChoosers)queue.choose=choose;}
  }
  const cancelId=randomUUID(),cancelWorkflow=structuredClone(workflow);cancelWorkflow.id=cancelId;
  const runtime=hosts[0].agent.runtime,read=runtime.ports.read;let release,entered;
  const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);
  runtime.ports.read=async(ref,offer)=>{if(offer.task.workflowId===cancelId){entered();await gate;}return read(ref,offer);};
  try{
   const cancelled=await sdk.submit(cancelWorkflow,{requestId:cancelId,budgetMs:30000,resultDestination:'ORIGIN',inputLocation:'ORIGIN'});await started;
   assert.equal(JSON.parse(await cancelled.cancel()).state,'CANCEL_REQUESTED');
   const active=await r.db.attempt.findMany({where:{workflowId:cancelId}});assert.equal(active.length,1);assert.equal(hosts[0].ledger.status(active[0].id).resourcesSettled,false);
   release();await assert.rejects(cancelled.result(),/JOB_CANCELLED_SETTLED/);
   assert.equal(await r.db.attempt.count({where:{workflowId:cancelId}}),1,'cancelled graph must not dispatch its downstream nodes');
  }finally{release();runtime.ports.read=read;}
 }catch(error){console.error(JSON.stringify({errors,graphs:await r.db.sdkWorkflowJob.findMany(),attempts:await r.db.attempt.findMany()},null,2));throw error;}finally{for(const h of hosts)await h.close();await r.close();}
});

test('status returns durable state while graph progression is busy and notifications coalesce',async()=>{
 const {WorkflowJobs}=require('../dist/workflow-jobs');
 let release,entered,passes=0;
 const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 const graphs=new WorkflowJobs({sdkWorkflowJob:{findMany:async()=>{passes++;entered();await gate;return [];}}},null,null,null,[]);
 graphs.owned=async()=>({row:{state:'ACTIVE'},data:{workflow:{nodes:[]},nodes:[{id:'n',state:'PENDING'}],plan:{decision:{suggestion:[{nodeId:'n'}]}}}});
 try{
  graphs.changed('group');await started;
  for(let i=0;i<100;i++)graphs.changed('group');
  const status=await graphs.status({groupId:'group'},'job');
  assert.equal(status.state,'ACTIVE');assert.equal(passes,1);
  release();await graphs.work;assert.equal(passes,2);
 }finally{release();await graphs.close();}
});

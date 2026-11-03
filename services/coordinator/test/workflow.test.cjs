const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {runtime}=require('./helpers.cjs'),{builtinCpuPacks,cpuConfiguration}=require('@harmony/reference-capabilities');
const {CpuHost}=require('../../pc-agent/dist/host'),{DurableLedger}=require('../../pc-agent/dist/durable-ledger');
const base=builtinCpuPacks()[0],raw=Buffer.from('{"text":"graph"}'),counts=Buffer.from('{"characters":5,"words":1,"lines":1}');
function identityPack(id,schema,bytes){return {...base,maxOutputBytes:4096,manifest:{...base.manifest,packId:id,contract:{...base.manifest.contract,contractId:id,capability:id,serviceId:id,inputSchemas:[schema],outputSchemas:[schema]}},cases:[{id:'identity',input:bytes,parameters:'{}',config:cpuConfiguration,maxOutputBytes:4096}],evaluate:async(_c,out)=>out.equals(bytes)?1:0};}
const collect=identityPack('source.collect.v1','text.input',raw),final=identityPack('source.finish.v1','text.counts',counts);
async function until(fn){const end=Date.now()+60000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,150));}throw Error('GRAPH_HOST_TIMEOUT');}
test('SDK three-node graph moves a private source result to a remote worker and returns to the fixed source service',async()=>{
 const r=await runtime({cpuHost:true,referencePacks:[...builtinCpuPacks(),collect,final]}),hosts=[],errors=[];
 try{
  const group=randomUUID(),capacity=[{resourcePoolId:'cpu',amount:1},{resourcePoolId:'ram',amount:268435456}];
  let source;
  for(const isApp of [true,false]){
   const device=randomUUID(),holder=randomUUID(),invite=await r.auth.invite(group,randomUUID(),device,r.url),owner=await r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:holder});
   await r.allotments.confirmDevice(device,capacity,[{groupId:group,holderInstanceId:holder,appInstanceId:null}]);
   let paired=owner;
   if(isApp){const invitation=await r.apps.register(owner.peer,{label:'Graph source',allowedContracts:['text.count.v1',collect.manifest.contract.contractId,final.manifest.contract.contractId],maxConcurrent:2,resources:capacity,offlineBase:capacity,onlineExtra:[]},r.url);paired=await r.apps.exchange({registrationId:invitation.registrationId,code:invitation.code});source=paired;}
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
  await r.profiles.refresh(group);
  // Deterministic regression: remove direct-link evidence after the verified copy
  // arrives, before the downstream start re-plans. The received replica must win.
  let uploaded=false,directUploads=0;const originalWrite=sdk.port.write,originalStart=r.jobs.start.bind(r.jobs);
  r.jobs.start=async(peer,jobId,...rest)=>{const row=await r.db.cpuJob.findUnique({where:{id:jobId}}),task=row?JSON.parse(row.metadataJson).offer.task:null;if(task?.workflowId===id&&task.nodeId==='count'&&!uploaded)throw Error('INPUT_NOT_UPLOADED');return originalStart(peer,jobId,...rest);};
  sdk.port.write=async(ticket,bytes)=>{
   await originalWrite(ticket,bytes);if(!ticket.direct)return;directUploads++;
   assert.equal(await r.directTransfers.hasInput(group,remote.holderInstanceId,source.peer.app.appInstanceId,ticket.ref),true);
   await r.directTransfers.resetNetwork(source.peer);await r.profiles.refresh(group);uploaded=true;
  };
  const invalid=structuredClone(workflow);invalid.nodes[1].inputFrom='missing';await assert.rejects(sdk.plan(invalid,{requestId:randomUUID(),budgetMs:30000,resultDestination:'ORIGIN'}),/SDK_GRAPH_EDGE_INVALID/);
  const task=await sdk.submit(workflow,{requestId:id,budgetMs:30000,resultDestination:'ORIGIN',inputLocation:'ORIGIN'}),result=await task.result();
  assert.deepEqual(JSON.parse(Buffer.from(result.output)),JSON.parse(counts));assert.equal(result.status.state,'SUCCEEDED');
  assert.equal(directUploads,1);r.jobs.start=originalStart;sdk.port.write=originalWrite;
  const attempts=await r.db.attempt.findMany({where:{workflowId:id}});assert.equal(attempts.length,3);assert.equal(new Set(attempts.map(a=>a.nodeId)).size,3);
  const trace=[];
  for(const a of attempts){assert.equal((await r.db.receipt.findUnique({where:{id:a.id}})).committed,true);const offer=JSON.parse(a.offerJson);trace.push([offer.task.nodeId,offer.target.backend,offer.task.workflowId]);}
  assert.equal(trace.find(x=>x[0]==='count')[1],'CPU');assert.equal(trace.find(x=>x[0]==='finish')[1],'SERVICE');
  for(const child of workflow.nodes.filter(n=>n.inputFrom)){
    const jobFor=async node=>JSON.parse((await r.db.cpuJob.findUniqueOrThrow({where:{id:attempts.find(a=>JSON.parse(a.taskJson).nodeId===node).id}})).metadataJson);
    const produced=await jobFor(child.inputFrom),consumed=await jobFor(child.id);
    assert.deepEqual(consumed.input,produced.output);
    assert.equal(consumed.sourceAttemptId,produced.offer.task.attemptId);
  }
  const finalJob=await r.db.cpuJob.findUnique({where:{id:attempts.find(a=>JSON.parse(a.taskJson).nodeId==='finish').id}});assert.equal(r.artifacts.available(JSON.parse(finalJob.metadataJson).output),false);
  const graphTrace=await r.traces.read(source.peer,id);assert.equal(graphTrace.traceId,id);assert.equal(new Set(graphTrace.spans.map(s=>s.nodeId)).size,3);
  await task.status();assert.equal(await r.db.attempt.count({where:{workflowId:id}}),3,'status must not replay committed nodes');
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

const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{fork}=require('node:child_process'),{randomUUID}=require('node:crypto');
const {runtime}=require('./helpers.cjs'),{builtinCpuPacks}=require('@harmony/reference-capabilities'),{collect,final,counts}=require('./workflow-packs.cjs');
const {child,until}=require('./workflow-process-util.cjs');
test('formal SDK graph crosses independent host processes: direct, relay isolation, lost receiver reply and competing graphs',async()=>{
 const r=await runtime({cpuHost:true,referencePacks:[...builtinCpuPacks(),collect,final]}),hosts=[child(),child()];const conflicts=[];const register=r.artifacts.register.bind(r.artifacts);r.artifacts.register=d=>{try{return register(d);}catch(error){conflicts.push({artifactId:d.ref.artifactId,expiresAt:d.expiresAt,previousExpiresAt:r.artifacts.lookup(d.groupId,d.ref)?.expiresAt,stack:error.stack});throw error;}};
 try{
  const group=randomUUID(),peers=[],pids=[],capacity=[{resourcePoolId:'cpu',amount:1},{resourcePoolId:'ram',amount:268435456}];
  for(let i=0;i<2;i++){
   const device=randomUUID(),holder=randomUUID(),invite=await r.auth.invite(group,randomUUID(),device,r.url),owner=await r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:holder});let paired=owner;
   await r.allotments.confirmDevice(device,capacity,[{groupId:group,holderInstanceId:holder,appInstanceId:null}]);
   if(i===0){const registration=await r.apps.register(owner.peer,{label:'Independent graph',allowedContracts:['text.count.v1',collect.manifest.contract.contractId,final.manifest.contract.contractId],maxConcurrent:4,resources:capacity,offlineBase:capacity,onlineExtra:[]},r.url);paired=await r.apps.exchange({registrationId:registration.registrationId,code:registration.code});}
   peers.push(paired.peer);const identity={groupId:group,deviceId:device,holderInstanceId:paired.peer.holderInstanceId,appInstanceId:paired.peer.app?.appInstanceId??null};
   pids.push((await hosts[i].request({action:'open',certificate:invite.certificate,source:i===0,config:{directory:path.join(r.config.dataDir,identity.holderInstanceId),identity,connection:{address:r.url,certificate:invite.certificate,fingerprint:invite.fingerprint,credential:paired.credential,domain:'SIMULATED'},controlIntervalMs:1500,contribution:{ownerMode:'dedicated',maxCpuThreads:1,maxMemoryBytes:268435456,reserveMemoryBytes:0}}})).pid);
  }
  assert.equal(new Set([...pids,process.pid]).size,3);
  const target=await until(async()=>{try{const s=(await r.snapshots.build(group)).snapshot;return s.candidates.some(c=>c.capability===final.manifest.contract.capability)&&s.candidates.find(c=>c.capability==='text.count.v1'&&c.holderInstanceId===peers[1].holderInstanceId);}catch{return false;}});
  for(const host of hosts)await host.request({action:'freeze'});
  const endpoints=await r.directTransfers.list(peers[0]);
  async function refreshLinks(){for(let i=0;i<2;i++){const endpoint=endpoints.find(e=>e.holderInstanceId===peers[1-i].holderInstanceId),network=await r.directTransfers.resetNetwork(peers[i]);await r.directTransfers.reportLink(peers[i],{epoch:network.epoch,endpointId:endpoint.id,endpointEpoch:endpoint.epoch,direction:'WRITE',reason:'REACHABLE',samples:[1024,8192,32768].map(bytes=>({bytes,durationMs:.01+bytes/1000000}))});}
  await r.profiles.refresh(group);}
  async function run(mode){
   await refreshLinks();await hosts[0].request({action:'fault',mode});const id=randomUUID();await hosts[0].request({action:'submit',jobId:id,targetId:target.targetId});const result=await hosts[0].request({action:'result',jobId:id});
   assert.equal(result.state,'SUCCEEDED');assert.deepEqual(Buffer.from(result.output,'base64'),counts);
   const attempts=await r.db.attempt.findMany({where:{workflowId:id}});assert.equal(attempts.length,3);assert.equal(new Set(attempts.map(a=>a.nodeId)).size,3);
   const parent=await r.db.cpuJob.findUniqueOrThrow({where:{id:attempts.find(a=>JSON.parse(a.taskJson).nodeId==='count').id}}),p=JSON.parse(parent.metadataJson);
   const c=JSON.parse((await r.db.cpuJob.findUniqueOrThrow({where:{id:attempts.find(a=>JSON.parse(a.taskJson).nodeId==='finish').id}})).metadataJson);
   if(mode==='producer-full'){assert.equal(p.retainOutput,undefined);assert.equal(p.outputFallback.reason,'ARTIFACT_CACHE_FULL');}else if(mode==='isolate'||mode==='cache-full'){assert.ok(result.faults>0);assert.equal(c.delivery.received.bytes,counts.length);assert.ok(c.delivery.received.remainingMs>0);}else assert.equal(c.delivery?.received,undefined);
   const trace=await r.traces.read(peers[0],id);assert.equal(trace.coverage.sourceSdkRoot,true);
   const delivered=await r.db.transferAuthorization.findMany({where:{groupId:group,state:'COMPLETED'}}),edgeGrants=delivered.filter(g=>g.attemptId===parent.id||g.attemptId===c.offer.task.attemptId).map(g=>JSON.parse(g.metadataJson).authorization).filter(a=>a.version===2);
   const measured=await until(async()=>{const t=await r.traces.read(peers[0],id);return edgeGrants.every(a=>t.spans.some(s=>s.transferId===a.id&&s.phase==='TRANSFER_RECV'))&&t;});
   assert.ok(measured.causality.links.some(l=>l.reason==='COMMITTED_DEPENDENCY'));assert.ok(measured.causality.links.some(l=>l.reason==='VERIFIED_INPUT_BEFORE_DISPATCH'));
   assert.equal(measured.spans.filter(s=>s.parentSpanId===null).length,1,'the SDK root contains phases without counting its duration as work');
   if(mode!=='drop-reply'){const paired=await until(async()=>{const t=await r.traces.read(peers[0],id);return edgeGrants.every(a=>t.spans.some(s=>s.transferId===a.id&&s.phase==='TRANSFER_SEND'))&&t;});assert.ok(paired.analysis.work.transferMs>0);}
   assert.equal(measured.coverage.criticalPathPending,true,'cross-clock gaps still prevent a complete critical-path claim');
   assert.ok(measured.analysis.predictionErrors.some(row=>row.phase==='EXECUTE'&&Number.isFinite(row.errorMs)&&row.snapshotVersion>0));
   await until(async()=>!await hosts[1].request({action:'ref',groupId:group,ref:p.output.ref}));
   console.log('INDEPENDENT_GRAPH '+JSON.stringify({mode:mode||'direct',pids,state:result.state,attempts:attempts.length,sourceDurationMs:trace.coverage.sourceDurationMs,faults:result.faults,receivedBytes:c.delivery?.received?.bytes??0}));
  }
  await run('');await run('drop-reply');await run('isolate');await run('cache-full');await hosts[1].request({action:'fault',mode:'cache-full'});await run('producer-full');await hosts[1].request({action:'fault',mode:''});
  // Direct ingress is isolated and the relay is full: reject clearly while the
  // parent remains committed, rather than retrying compute or exhausting 30 s.
  await refreshLinks();await hosts[0].request({action:'fault',mode:'isolate'});const fullId=randomUUID(),cacheLimit=r.artifacts.limits.cacheBytes;r.artifacts.limits.cacheBytes=0;
  try{
   await hosts[0].request({action:'submit',jobId:fullId,targetId:target.targetId});await assert.rejects(hosts[0].request({action:'result',jobId:fullId}),/JOB_FAILED/);
   const full=await r.sdk.status(peers[0],fullId),graph=await r.db.sdkWorkflowJob.findUniqueOrThrow({where:{id:fullId}});
   assert.equal(full.rejection.code,'ARTIFACT_CACHE_FULL');assert.equal(full.rejection.reason,'NO_FEASIBLE_INPUT_PATH');assert.ok(JSON.parse(graph.metadataJson).deadlineAt>Date.now());
   const attempts=await r.db.attempt.findMany({where:{workflowId:fullId}});assert.equal(attempts.length,2);assert.equal(new Set(attempts.map(a=>a.nodeId)).size,2);
   assert.ok(attempts.every(a=>a.state==='SUCCEEDED'));await r.sdk.status(peers[0],fullId);assert.equal(await r.db.attempt.count({where:{workflowId:fullId}}),2);
   console.log('INDEPENDENT_GRAPH '+JSON.stringify({mode:'relay-full',pids,state:full.state,rejection:full.rejection.code,attempts:attempts.length,remainingMs:JSON.parse(graph.metadataJson).deadlineAt-Date.now()}));
  }finally{r.artifacts.limits.cacheBytes=cacheLimit;}
  await refreshLinks();await hosts[0].request({action:'fault',mode:''});const ids=[randomUUID(),randomUUID()];await Promise.all(ids.map(jobId=>hosts[0].request({action:'submit',jobId,targetId:target.targetId})));
  const results=await Promise.all(ids.map(jobId=>hosts[0].request({action:'result',jobId})));for(let i=0;i<2;i++){assert.equal(results[i].state,'SUCCEEDED');assert.equal(await r.db.attempt.count({where:{workflowId:ids[i]}}),3);}
 }catch(error){if(conflicts.length)console.log('REGISTRATION_CONFLICT '+JSON.stringify(conflicts));throw error;}finally{for(const host of hosts){try{await host.request({action:'close'});}catch{}host.close();}await r.close();}
});

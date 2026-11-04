const {test}=require('node:test'),assert=require('node:assert/strict');
const {runtime}=require('./helpers.cjs'),{attempt,fixture}=require('./fixtures.cjs'),{pinnedRequest}=require('../dist/pinned-client');
test('trace ingestion binds holder, group, target and workflow; immutable retries and authenticated query',async()=>{
 const r=await runtime();try{
  const invite=await r.auth.invite('g1','p1','device1',r.url),paired=await r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:'h1'});
  const f=attempt();f.message.senderInstanceId=r.identity.id;await r.store.persistOffer(f.offer,'h1',f.message);
  const span=fixture('TraceSpan');await r.traces.ingest(paired.peer,[span]);await r.traces.ingest(paired.peer,[span]);assert.equal(await r.db.traceSpan.count(),1);
  const trace=await pinnedRequest(invite,'/v2/traces/trace1',undefined,paired.credential);assert.equal(trace.spans.length,1);
  await r.db.cpuJob.create({data:{id:f.offer.task.attemptId,groupId:'g1',principalId:'p1',sourceHolderId:'h1',state:'DISPATCHED',metadataJson:JSON.stringify({traceId:span.traceId,offer:f.offer,request:{},decisionEvidence:{snapshotVersion:span.snapshotVersion,phaseCosts:{EXECUTE:5,QUEUE:0,PUBLISH:1}}})}});
  await r.traces.sourceRoot({...paired.peer,app:f.offer.task.app},f.offer,span.traceId,1,{clockDomainId:'sdk-clock',startMono:0,endMono:100});
  const measured=await pinnedRequest(invite,'/v2/traces/trace1',undefined,paired.credential);assert.equal(measured.analysis.predictionErrors[0].errorMs,5);assert.equal(measured.spans.filter(s=>s.parentSpanId===null).length,1);
  assert.equal(JSON.parse((await r.db.traceSpan.findUniqueOrThrow({where:{id:JSON.stringify(['g1',span.traceId,span.spanId])}})).metadataJson).span.predictedMs,null,'read projection must not rewrite authenticated telemetry');
  await assert.rejects(r.traces.ingest({...paired.peer,holderInstanceId:'intruder'},[span]),/UNAUTHORIZED/);
  await assert.rejects(r.traces.ingest(paired.peer,[{...span,workflowId:'other'}]),/SCOPE/);
  await assert.rejects(r.traces.ingest(paired.peer,[{...span,traceId:'unrelated'}]),/SCOPE/);
  await assert.rejects(r.traces.ingest(paired.peer,[{...span,reasonCode:'CHANGED'}]),/CONFLICT/);
  await assert.rejects(r.traces.read({...paired.peer,principalId:'other'},span.traceId),/UNAUTHORIZED/);
  await assert.rejects(r.traces.read({...paired.peer,groupId:'other'},span.traceId),/UNAUTHORIZED/);
  await r.auth.revoke(paired.peer.credentialId);await assert.rejects(pinnedRequest(invite,'/v2/traces/trace1',undefined,paired.credential));
 }finally{await r.close();}
});

test('transfer timing is limited to the actual sender/receiver of a completed full-ref delivery and immutable on retry',async()=>{
 const {randomUUID}=require('node:crypto'),r=await runtime();try{
  async function pair(holder,device){const invite=await r.auth.invite('g1','p1',device,r.url);return r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:holder});}
  const source=await pair('source','device-a'),receiver=await pair('receiver','device-b'),foreign=await pair('foreign','device-c'),id=randomUUID(),grantId=randomUUID();
  const ref={artifactId:'ref-'+id,contentVersion:1,contentHash:'a'.repeat(64),schemaId:'text.input',schemaVersion:1},f=attempt();
  const d={sourceAttemptId:'parent',traceId:'transfer-trace',input:{ref,bytes:1},plan:{snapshotVersion:1},offer:{...f.offer,task:{...f.offer.task,app:{...f.offer.task.app,principalId:'p1'}},target:{...f.offer.target,deviceId:'device-b'}}};
  await r.db.cpuJob.create({data:{id,groupId:'g1',principalId:'p1',sourceHolderId:'source',state:'WAITING_INPUT',metadataJson:JSON.stringify(d)}});
  const authorization={id:grantId,version:2,operation:'WRITE',attemptId:id,producerAttemptId:'parent',ref,bytes:1,senderHolderId:'source',receiverHolderId:'receiver',endpoint:{deviceId:'device-b'}};
  await r.db.transferAuthorization.create({data:{id:grantId,groupId:'g1',attemptId:id,endpointId:'ep-b',requesterCredentialId:source.peer.credentialId,state:'ISSUED',expiresAt:Date.now()+30000,metadataJson:JSON.stringify({authorization})}});
  const body={authorizationId:grantId,side:'SENDER',interval:{clockDomainId:'sender-boot',startMono:100,endMono:120}};
  await assert.rejects(r.traces.transfer(source.peer,body),/TRANSFER_TRACE_SCOPE/);
  await r.db.transferAuthorization.update({where:{id:grantId},data:{state:'COMPLETED'}});
  await assert.rejects(r.traces.transfer(foreign.peer,body),/TRANSFER_TRACE_SCOPE/);
  await assert.rejects(r.traces.transfer(receiver.peer,body),/TRANSFER_TRACE_SCOPE/);
  await assert.rejects(r.traces.transfer(source.peer,{...body,side:'RECEIVER'}),/TRANSFER_TRACE_SCOPE/);
  await assert.rejects(r.traces.transfer(source.peer,{...body,interval:{...body.interval,endMono:99}}),/TRANSFER_TRACE_INVALID/);
  await r.traces.transfer(source.peer,body);await r.traces.transfer(source.peer,{...body,interval:{...body.interval,endMono:140}});
  await r.traces.transfer(receiver.peer,{...body,side:'RECEIVER',interval:{clockDomainId:'receiver-boot',startMono:8,endMono:18}});
  const rows=(await r.db.traceSpan.findMany()).map(row=>JSON.parse(row.metadataJson).span);
  assert.equal(rows.length,2);assert.equal(rows.find(s=>s.phase==='TRANSFER_SEND').durationMs,20);assert.equal(rows.find(s=>s.phase==='TRANSFER_RECV').measurementScope,'PARTIAL_TRANSFER');
  assert.ok(rows.every(s=>s.transferId===grantId&&s.authoritativeSide==='SENDER'));
  await r.db.cpuJob.update({where:{id},data:{metadataJson:JSON.stringify({...d,input:{...d.input,ref:{...ref,artifactId:'same-hash-wrong-ref'}}})}});
  await assert.rejects(r.traces.transfer(source.peer,body),/TRANSFER_TRACE_SCOPE/);
 }finally{await r.close();}
});

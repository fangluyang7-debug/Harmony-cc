const {test}=require('node:test'),assert=require('node:assert/strict');
const {runtime}=require('./helpers.cjs'),{attempt,fixture}=require('./fixtures.cjs'),{pinnedRequest}=require('../dist/pinned-client');
test('trace ingestion binds holder, group, target and workflow; immutable retries and authenticated query',async()=>{
 const r=await runtime();try{
  const invite=await r.auth.invite('g1','p1','device1',r.url),paired=await r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:'h1'});
  const f=attempt();f.message.senderInstanceId=r.identity.id;await r.store.persistOffer(f.offer,'h1',f.message);
  const span=fixture('TraceSpan');await r.traces.ingest(paired.peer,[span]);await r.traces.ingest(paired.peer,[span]);assert.equal(await r.db.traceSpan.count(),1);
  const trace=await pinnedRequest(invite,'/v2/traces/trace1',undefined,paired.credential);assert.equal(trace.spans.length,1);
  await assert.rejects(r.traces.ingest({...paired.peer,holderInstanceId:'intruder'},[span]),/UNAUTHORIZED/);
  await assert.rejects(r.traces.ingest(paired.peer,[{...span,workflowId:'other'}]),/SCOPE/);
  await assert.rejects(r.traces.ingest(paired.peer,[{...span,traceId:'unrelated'}]),/SCOPE/);
  await assert.rejects(r.traces.ingest(paired.peer,[{...span,reasonCode:'CHANGED'}]),/CONFLICT/);
  await assert.rejects(r.traces.read({...paired.peer,principalId:'other'},span.traceId),/UNAUTHORIZED/);
  await assert.rejects(r.traces.read({...paired.peer,groupId:'other'},span.traceId),/UNAUTHORIZED/);
  await r.auth.revoke(paired.peer.credentialId);await assert.rejects(pinnedRequest(invite,'/v2/traces/trace1',undefined,paired.credential));
 }finally{await r.close();}
});

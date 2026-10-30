const {test}=require('node:test'),assert=require('node:assert/strict');
const {runtime}=require('./helpers.cjs'),{attempt,fixture}=require('./fixtures.cjs');
async function pending(r){const q=await r.db.outbox.findFirst({where:{kind:'AttemptStatusQuery',acked:false,superseded:false}});return JSON.parse(q.messageJson);}
test('recovery statuses bind to a current query and complete execution identity; terminal evidence never commits an old result',async()=>{
 const r=await runtime();try{
  const f=attempt();f.message.senderInstanceId=r.identity.id;await r.store.persistOffer(f.offer,'h1',f.message);await r.store.recordAdmission(f.record);
  await r.store.requestStatus('g1','h1',2);await r.store.requestStatus('g1','h1',2);const q=await pending(r);
  assert.equal(await r.db.outbox.count({where:{kind:'AttemptStatusQuery'}}),1);
  const reply={attemptId:f.task.attemptId,record:{...f.record,state:'SIDE_EFFECT_UNKNOWN'}};
  for(const args of [['g1','other','device1',q.messageId,reply,2],['g2','h1','device1',q.messageId,reply,2],['g1','h1','device1','unknown',reply,2],['g1','h1','device1',q.messageId,reply,1]]){
   await assert.rejects(r.store.reconcileStatus(...args),/UNAUTHORIZED/);
  }
  for(const patch of [{principalId:'other'},{executionDigest:'a'.repeat(64)},{leaseId:'other'},{fence:{...f.record.fence,counter:9}},{state:'RUNNING',resourcesSettled:true}]){
   await assert.rejects(r.store.reconcileStatus('g1','h1','device1',q.messageId,{...reply,record:{...reply.record,...patch}},2),/MISMATCH|INVALID/);
  }
  await r.store.reconcileStatus('g1','h1','device1',q.messageId,reply,2);
  assert.equal(await r.store.reconciliationAction('g1',f.task.attemptId),'WAIT_SETTLEMENT');
  await r.store.requestStatus('g1','h1',2);const q2=await pending(r);
  const receipt={...fixture('ExecutionReceipt'),state:'FAILED',resourcesSettled:true,outputs:[],errorCode:'ENGINE_STOP_CONFIRMED'};
  const terminal={attemptId:f.task.attemptId,record:{...f.record,state:receipt.state,resourcesSettled:true,receipt}};
  await r.store.reconcileStatus('g1','h1','device1',q2.messageId,terminal,2);await r.store.reconcileStatus('g1','h1','device1',q2.messageId,terminal,2);
  assert.equal((await r.db.receipt.findFirst()).committed,false);assert.notEqual((await r.db.node.findFirst()).state,'COMMITTED');
  assert.equal(await r.store.reconciliationAction('g1',f.task.attemptId),'ALLOW_NEW_ATTEMPT');assert.equal(await r.db.attempt.count(),1);
  await assert.rejects(r.store.reconcileStatus('g1','h1','device1',q2.messageId,reply,2),/TERMINAL_CONFLICT/);
 }finally{await r.close();}
});
test('a missing admission can be recovered; missing local records are not proof to release capacity or replay',async()=>{
 const r=await runtime();try{
  const f=attempt();f.message.senderInstanceId=r.identity.id;await r.store.persistOffer(f.offer,'h1',f.message);
  await r.store.requestStatus('g1','h1',1);let q=await pending(r);
  await r.store.reconcileStatus('g1','h1','device1',q.messageId,{attemptId:f.task.attemptId,record:null},1);
  assert.equal(await r.store.reconciliationAction('g1',f.task.attemptId),'MANUAL_RECONCILIATION');assert.equal(await r.db.attempt.count(),1);
  await r.store.requestStatus('g1','h1',1);q=await pending(r);
  await r.store.reconcileStatus('g1','h1','device1',q.messageId,{attemptId:f.task.attemptId,record:f.record},1);
  assert.equal(JSON.parse((await r.db.attempt.findFirst()).recordJson).leaseId,f.record.leaseId);
  await assert.rejects(r.store.reconcileStatus('g1','h1','device1',q.messageId,{attemptId:f.task.attemptId,record:null},1),/RECORD_LOST/);
 }finally{await r.close();}
});
test('successful output may still hold resources; later settlement changes only the settlement flag',async()=>{
 const r=await runtime();try{
  const f=attempt();f.message.senderInstanceId=r.identity.id;await r.store.persistOffer(f.offer,'h1',f.message);await r.store.recordAdmission(f.record);
  await r.store.requestStatus('g1','h1',1);let q=await pending(r);
  const receipt={...fixture('ExecutionReceipt'),resourcesSettled:false};
  const reply={attemptId:f.task.attemptId,record:{...f.record,state:'SUCCEEDED',resourcesSettled:false,receipt}};
  await r.store.reconcileStatus('g1','h1','device1',q.messageId,reply,1);
  assert.equal(JSON.parse((await r.db.attempt.findFirst()).recordJson).resourcesSettled,false);
  await r.store.requestStatus('g1','h1',1);q=await pending(r);
  const settled={...reply,record:{...reply.record,resourcesSettled:true,receipt:{...receipt,resourcesSettled:true}}};
  await r.store.reconcileStatus('g1','h1','device1',q.messageId,settled,1);
  assert.equal(JSON.parse((await r.db.receipt.findFirst()).recordJson).resourcesSettled,true);assert.equal((await r.db.receipt.findFirst()).committed,false);
  await assert.rejects(r.store.reconcileStatus('g1','h1','device1',q.messageId,reply,1),/TERMINAL_CONFLICT/);
 }finally{await r.close();}
});

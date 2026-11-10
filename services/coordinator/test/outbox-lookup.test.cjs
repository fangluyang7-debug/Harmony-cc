const {test}=require('node:test'),assert=require('node:assert/strict');
const {runtime}=require('./helpers.cjs'),{outboxByWireId}=require('../dist/outbox-lookup');
test('wire lookup uses a primary key for ordinary messages, preserves recovery keys, and rejects cross-group or ambiguous ACKs',async()=>{
 const r=await runtime();try{
  const add=(id,groupId,messageId,kind='DispatchOffer')=>r.db.outbox.create({data:{id,groupId,attemptId:'attempt',sequence:1,kind,epoch:1,messageJson:JSON.stringify({messageId})}});
  await add('ordinary','g1','ordinary');await add('durable-recovery-key','g1','wire-recovery','AttemptStatusQuery');
  await add('foreign','g2','foreign');
  const fast={outbox:{findUnique:r.db.outbox.findUnique.bind(r.db.outbox)},$queryRaw:()=>{throw Error('ORDINARY_ACK_MUST_NOT_SCAN');}};
  assert.equal((await outboxByWireId(fast,'g1','ordinary')).id,'ordinary');
  assert.equal((await outboxByWireId(r.db,'g1','wire-recovery')).id,'durable-recovery-key');
  assert.equal(await outboxByWireId(r.db,'g1','wire-recovery','DispatchOffer'),null);
  assert.equal(await outboxByWireId(r.db,'g1','foreign'),null);
  assert.equal(await outboxByWireId(r.db,'g1',"' OR 1=1 --"),null);
  await add('duplicate-wire','g1','wire-recovery');await assert.rejects(outboxByWireId(r.db,'g1','wire-recovery'),/AMBIGUOUS/);
 }finally{await r.close();}
});

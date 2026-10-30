const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {execFileSync,spawnSync}=require('node:child_process');
const {PrismaClient}=require('../generated/client');
const {CoordinatorStore,executionDigest}=require('../dist/store');
const {attempt,fixture}=require('./fixtures.cjs');
async function database(){
  fs.mkdirSync(path.resolve('../../.test'),{recursive:true});
  const data=fs.mkdtempSync(path.resolve('../../.test/store-'));
  execFileSync(process.execPath,['scripts/migrate.cjs'],{env:{...process.env,COORDINATOR_DATA_DIR:data},stdio:'pipe'});
  const url='file:'+path.join(data,'coordinator.sqlite').replaceAll('\\','/');
  const db=new PrismaClient({datasources:{db:{url}}});return {db,url,store:new CoordinatorStore(db,'coordinator1')};
}
for(const point of ['before-send','after-send'])test(`crash ${point}: durable query replaces offer without a second attempt`,async()=>{
  const {db,url,store}=await database();
  try{
    const child=spawnSync(process.execPath,['test/crash-child.cjs',url,point]);assert.equal(child.status,17);
    assert.equal(await db.attempt.count(),1);
    assert.equal((await db.outbox.findFirst()).deliveryCount,point==='after-send'?1:0);
    await store.recover(2);await store.recover(2);
    const sent=[];await store.flush(async m=>sent.push(m));
    assert.equal(sent.length,1);assert.equal(sent[0].type,'AttemptStatusQuery');assert.equal(sent[0].coordinatorEpoch,2);
    assert.equal(sent[0].seq,2);
    assert.equal(await db.attempt.count(),1);
    assert.equal(await store.receive('g1','h1',fixture('ExecutionReceipt'),2),'RECONCILE');
    assert.equal((await db.receipt.findFirst()).committed,false);
    await store.acknowledge('g1',sent[0].messageId);await store.acknowledge('g1',sent[0].messageId);
    assert.equal(await store.flush(async()=>{throw Error('unexpected');}),0);
  }finally{await db.$disconnect();}
});
test('attempt plus outbox is atomic, duplicate identity is idempotent, changed input conflicts',async()=>{
  const {db,store}=await database();
  try{
    const a=attempt();assert.equal(await store.persistOffer(a.offer,a.record.holderInstanceId,a.message),'CREATED');
    assert.equal(await store.persistOffer(a.offer,a.record.holderInstanceId,{...a.message,messageId:'m2'}),'EXISTING');
    assert.equal(await db.outbox.count(),1);
    a.task.parameters='{"changed":true}';a.record.executionDigest=executionDigest(a.task);a.message.payload=JSON.stringify(a.offer);
    await assert.rejects(store.persistOffer(a.offer,a.record.holderInstanceId,a.message),/ATTEMPT_CONFLICT/);
    const b=attempt();b.task.attemptId='attempt2';b.task.nodeId='node2';b.record.attemptId='attempt2';b.message.payload=JSON.stringify(b.offer);
    // Reusing a message primary key fails at the last statement in the transaction.
    await assert.rejects(store.persistOffer(b.offer,b.record.holderInstanceId,b.message));
    assert.equal(await db.attempt.count(),1);assert.equal(await db.node.count(),1);
    await assert.rejects(store.flush(async()=>{throw Error('CHANNEL_DOWN');}),/CHANNEL_DOWN/);
    assert.equal((await db.outbox.findFirst()).acked,false);
    await store.flush(async()=>{});await store.flush(async()=>{});
    assert.equal((await db.outbox.findFirst()).deliveryCount,2);
  }finally{await db.$disconnect();}
});
test('only authorized current attempt/fence/target results commit',async()=>{
  const {db,store}=await database();
  try{
    const f=attempt();await store.persistOffer(f.offer,f.record.holderInstanceId,f.message);
    await store.recordAdmission(f.record);
    await assert.rejects(store.recordAdmission({...f.record,planRevision:2}),/ADMISSION_CONFLICT/);
    const receipt=fixture('ExecutionReceipt');
    await assert.rejects(store.receive('other-group','h1',receipt,1),/AUTHORIZATION_DENIED/);
    await assert.rejects(store.receive('g1','other-holder',receipt,1),/AUTHORIZATION_DENIED/);
    await assert.rejects(store.receive('g1','h1',{...receipt,actualConfiguration:'forbidden'},1),/EXECUTION_SCOPE_MISMATCH/);
    assert.equal(await store.receive('g1','h1',{...receipt,fence:{...receipt.fence,counter:2}},1),'RECONCILE');
    assert.equal((await db.node.findFirst()).state,'ACCEPTED');
    assert.equal(await store.receive('g1','h1',receipt,1),'COMMITTED');
    assert.equal((await db.node.findFirst()).state,'COMMITTED');
    assert.equal((await db.receipt.findFirst()).committed,true);
    assert.equal(await store.receive('g1','h1',receipt,1),'COMMITTED');
    await assert.rejects(store.receive('g1','h1',{...receipt,outputs:[]},1),/RECEIPT_CONFLICT/);
  }finally{await db.$disconnect();}
});
test('reconciliation honors side-effect policy and cannot turn unknown execution into automatic replay',async()=>{
  const {db,store}=await database();
  try{
    const cases=[['PURE','ALLOW_NEW_ATTEMPT'],['IDEMPOTENT_WRITE','QUERY_IDEMPOTENCY_KEY'],['TRANSACTIONAL','QUERY_TRANSACTION'],['NO_REPLAY','MANUAL_RECONCILIATION']];
    for(let index=0;index<cases.length;index++){
      const [policy,action]=cases[index],f=attempt(),id='reconcile'+index;
      f.task.attemptId=id;f.task.workflowId='wf'+index;f.task.contract.sideEffectPolicy=policy;
      f.task.businessIdempotencyKey=policy==='IDEMPOTENT_WRITE'?'business-key':null;
      f.record.attemptId=id;f.record.businessIdempotencyKey=f.task.businessIdempotencyKey;f.record.executionDigest=executionDigest(f.task);f.record.fence.counter=index+1;
      f.message.messageId='message'+index;f.message.payload=JSON.stringify(f.offer);
      await store.persistOffer(f.offer,'h1',f.message);await store.recordAdmission(f.record);
      const receipt={...fixture('ExecutionReceipt'),attemptId:id,fence:f.record.fence,state:'FAILED',resourcesSettled:true,outputs:[],errorCode:'EXECUTION_FAILED'};
      assert.equal(await store.receive('g1','h1',receipt,1),'RECONCILE');
      assert.equal(await store.reconciliationAction('g1',id),action);
    }
    assert.equal(await db.attempt.count(),4); // Recommendations do not create attempts.
    await assert.rejects(store.reconciliationAction('other-group','reconcile0'),/AUTHORIZATION_DENIED/);
  }finally{await db.$disconnect();}
});

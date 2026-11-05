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
test('quota preflight and offer creation are one transaction; stale quota creates no attempt/outbox',async()=>{
 const {db,store}=await database();try{
  const a=attempt();let calls=0;
  await assert.rejects(store.persistOffer(a.offer,a.record.holderInstanceId,a.message,async tx=>{calls++;assert.equal(await tx.attempt.count(),0);throw Error('PLAN_STALE');}),/PLAN_STALE/);
  assert.equal(calls,1);assert.equal(await db.attempt.count(),0);assert.equal(await db.outbox.count(),0);
  await store.persistOffer(a.offer,a.record.holderInstanceId,a.message,async()=>{calls++;});
  await store.persistOffer(a.offer,a.record.holderInstanceId,a.message,async()=>{throw Error('duplicate must retain existing identity');});
  assert.equal(calls,2);assert.equal(await db.attempt.count(),1);
 }finally{await db.$disconnect();}
});
test('a late admission cannot reverse a durable pre-start rejection',async()=>{
 const {db,store}=await database();
 try{
  const f=attempt();await store.persistOffer(f.offer,f.record.holderInstanceId,f.message);
  await db.attempt.update({where:{id:f.record.attemptId},data:{state:'REJECTED',rejectionJson:JSON.stringify({reply:{reasonCode:'QUEUE_STARVED_NOT_STARTED'}})}});
  await assert.rejects(store.recordAdmission(f.record),/ADMISSION_CONFLICT/);
  const row=await db.attempt.findUniqueOrThrow({where:{id:f.record.attemptId}});
  assert.equal(row.state,'REJECTED');assert.equal(row.recordJson,null);
 }finally{await db.$disconnect();}
});
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
    await store.receive('g1','h1',receipt,1,undefined,4,'COLD');
    await store.receive('g1','h1',receipt,1,undefined,6,'COLD');
    const enriched=await db.receipt.findFirst();assert.equal(enriched.overheadMs,4);assert.equal(enriched.startup,'COLD');
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
      const settled=await db.attempt.findUnique({where:{id}});assert.equal(settled.state,'FAILED');assert.equal(JSON.parse(settled.recordJson).resourcesSettled,true);
      assert.equal((await db.receipt.findUnique({where:{id}})).committed,false,'failure must never publish a business result');
      assert.equal(await store.receive('g1','h1',receipt,1),'RECONCILE');
      await assert.rejects(store.receive('g1','h1',{...receipt,errorCode:'CONFLICTING_FAILURE'},1),/RECEIPT_CONFLICT/);
      assert.equal(await store.reconciliationAction('g1',id),action);
    }
    assert.equal(await db.attempt.count(),4); // Recommendations do not create attempts.
    await assert.rejects(store.reconciliationAction('other-group','reconcile0'),/AUTHORIZATION_DENIED/);
  }finally{await db.$disconnect();}
});

for(const race of ['backup-first','simultaneous','cancel-before-success','cancel-before-rejection'])test('logical node chooses one result and settles both attempts: '+race,async()=>{
 const {db,store,url}=await database();let reopened;
 try{
  const primary=attempt(),backup=attempt();
  for(const f of [primary,backup])f.offer.task.priority='REMOTE_INTERACTIVE';
  backup.offer.task.attemptId='backup';backup.offer.task.allowedTargetIds=['target2'];
  Object.assign(backup.offer.target,{targetId:'target2',deviceId:'device2'});
  for(const hop of backup.offer.transferPlan)hop.to=backup.offer.target.deviceId;
  backup.message.messageId='backup-offer';
  Object.assign(backup.record,{attemptId:'backup',holderInstanceId:'h2'});
  Object.assign(backup.record.fence,{deviceId:'device2',holderInstanceId:'h2'});
  for(const f of [primary,backup]){
   f.message.payload=JSON.stringify(f.offer);f.record.executionDigest=executionDigest(f.offer.task);
  }
  await store.persistOffer(primary.offer,'h1',primary.message);
  await store.recordAdmission(primary.record);
  await store.persistOffer(backup.offer,'h2',backup.message,async()=>{},primary.offer.task.attemptId);
  await store.recordAdmission(backup.record);
  const win={...fixture('ExecutionReceipt'),attemptId:'backup',actualTarget:backup.offer.target,fence:backup.record.fence};
  win.outputs=[{...win.outputs[0],schemaId:'output.schema'}];
  for(const f of [primary,backup]){
   await db.cpuJob.create({data:{id:f.offer.task.attemptId,groupId:'g1',principalId:f.offer.task.app.principalId,sourceHolderId:'source',state:'DISPATCHED',
    metadataJson:JSON.stringify({output:{groupId:'g1',ownerPrincipalId:f.offer.task.app.principalId,ref:win.outputs[0]}})}});
  }
  await assert.rejects(store.receive('g1','h2',{...win,outputs:fixture('ExecutionReceipt').outputs},1),/RACE_OUTPUT_SCOPE/);
  if(race.startsWith('cancel-before-')){
   const node=await db.node.findFirstOrThrow();await db.node.update({where:{id:node.id},data:{state:'CANCEL_REQUESTED'}});
   assert.equal(await store.receive('g1','h2',win,1),'RECONCILE');
   assert.equal((await db.node.findUniqueOrThrow({where:{id:node.id}})).state,'CANCEL_REQUESTED');
   assert.equal(JSON.parse((await db.attempt.findUniqueOrThrow({where:{id:primary.record.attemptId}})).recordJson).resourcesSettled,false);
   if(race==='cancel-before-rejection'){
    await db.$transaction(async tx=>{
     await tx.attempt.update({where:{id:primary.record.attemptId},data:{state:'REJECTED'}});
     await store.recordNodeFailure(tx,node.id,primary.record.attemptId,'REJECTED');
    });
   }else assert.equal(await store.receive('g1','h1',fixture('ExecutionReceipt'),1),'RECONCILE');
   const ended=await db.node.findUniqueOrThrow({where:{id:node.id}});
   assert.equal(ended.state,'CANCELLED_SETTLED');assert.equal(ended.winnerAttemptId,null);
   assert.equal(await db.receipt.count({where:{committed:true}}),0);return;
  }
  if(race==='simultaneous'){
   const first={...fixture('ExecutionReceipt'),outputs:win.outputs};
   const results=await Promise.all([store.receive('g1','h1',first,1),store.receive('g1','h2',win,1)]);
   assert.deepEqual(results.sort(),['COMMITTED','RECONCILE']);
   assert.equal(await db.receipt.count({where:{committed:true}}),1);
   const winner=await db.receipt.findFirstOrThrow({where:{committed:true}}),node=await db.node.findFirstOrThrow();
   assert.equal(node.winnerAttemptId,winner.attemptId);
   assert.ok((await db.attempt.findMany()).every(row=>JSON.parse(row.recordJson).resourcesSettled));
   return;
  }
  assert.equal(await store.receive('g1','h2',win,1),'COMMITTED');
  assert.equal((await db.cpuJob.findUniqueOrThrow({where:{id:primary.record.attemptId}})).state,'CANCEL_REQUESTED');
  assert.equal(JSON.parse((await db.attempt.findUniqueOrThrow({where:{id:primary.record.attemptId}})).recordJson).resourcesSettled,false);
  await db.$disconnect();reopened=new PrismaClient({datasources:{db:{url}}});const next=new CoordinatorStore(reopened,'coordinator1');
  const late=fixture('ExecutionReceipt');
  assert.equal(await next.receive('g1','h1',late,1),'RECONCILE');
  assert.equal(await next.receive('g1','h2',win,1),'COMMITTED');
  const {raceIntervals,raceKey}=require('../dist/race-timing');
  const raceNode=await reopened.node.findFirstOrThrow();
  const timing=JSON.parse((await reopened.costObservation.findUniqueOrThrow({where:{id:raceKey(raceNode.id)}})).metadataJson);
  const spans=raceIntervals(timing,raceNode.primaryAttemptId,raceNode.backupAttemptId);
  assert.ok(spans.offerToWinnerMs>=0&&spans.offerToWinnerMs!==null);
  assert.ok(spans.winnerToBothSettledMs>=0&&spans.winnerToBothSettledMs!==null);
  assert.equal(raceIntervals({...timing,offer:{...timing.offer,clock:'another-process'}},raceNode.primaryAttemptId,raceNode.backupAttemptId).offerToWinnerMs,null);
  const node=await reopened.node.findFirstOrThrow();assert.equal(node.winnerAttemptId,'backup');assert.equal(node.currentAttemptId,'backup');
  assert.equal(await reopened.receipt.count({where:{committed:true}}),1);
  assert.equal(JSON.parse((await reopened.attempt.findUniqueOrThrow({where:{id:late.attemptId}})).recordJson).resourcesSettled,true);
 }finally{await reopened?.$disconnect();await db.$disconnect();}
});

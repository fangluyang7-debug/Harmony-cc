const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {spawn}=require('node:child_process'),{once}=require('node:events');
const {runtime}=require('./helpers.cjs'),{attempt}=require('./fixtures.cjs');
const {createCoordinator}=require('../dist/app');
const {pinnedRequest}=require('../dist/pinned-client');
const {DurableLedger}=require('../../pc-agent/dist/durable-ledger');
const {RecoveryClient}=require('../../pc-agent/dist/recovery-client');
const {occupiedV2}=require('@harmony/scheduler-core');
const who={groupId:'g1',deviceId:'device1',holderInstanceId:'h1',appInstanceId:null};
async function until(check){const deadline=Date.now()+15000;while(Date.now()<deadline){if(await check())return;await new Promise(r=>setTimeout(r,25));}throw Error('RECOVERY_TIMEOUT');}
async function prepare(r){
 const invite=await r.auth.invite('g1','p1','device1',r.url),pair=await pinnedRequest(invite,'/v2/pair',{inviteId:invite.inviteId,code:invite.code,holderInstanceId:'h1'});
 const capacity=[{resourcePoolId:'memory1',amount:200}];await r.allotments.confirmDevice('device1',capacity,[{groupId:'g1',holderInstanceId:'h1',appInstanceId:null}]);
 const dir=fs.mkdtempSync(path.join(r.config.dataDir,'recovery-holder-')),ledger=await DurableLedger.open(dir,who,r.identity.cert);
 ledger.requestGrant('request1');const grant=await pinnedRequest(invite,'/v2/allotments/request',{ledgerEpoch:1,leaseRequestId:'request1',leaseMs:300000,base:[],extra:capacity},pair.credential);ledger.installGrant(grant);
 async function add(id,start,recordAdmission=true){
  const f=attempt();f.task.attemptId=id;f.task.workflowId='workflow-'+id;f.task.nodeId='node-'+id;
  f.offer.allotmentId=grant.allotmentId;f.message.messageId='offer-'+id;f.message.senderInstanceId=r.identity.id;f.message.payload=JSON.stringify(f.offer);
  await r.store.persistOffer(f.offer,'h1',f.message);
  const entry=ledger.admit(f.offer,{coordinatorEpoch:r.epoch,online:true,ownerIdle:true,admissionLimit:capacity});
  if(recordAdmission)await r.store.recordAdmission(entry.record);if(start)ledger.begin(id);return entry;
 }
 const connection={address:r.url,certificate:invite.certificate,fingerprint:invite.fingerprint,credential:pair.credential,domain:'SIMULATED'};
 return {ledger,dir,add,connection};
}
function settled(entry){return {attemptId:entry.record.attemptId,coordinatorEpoch:entry.record.coordinatorEpoch,planRevision:entry.record.planRevision,fence:entry.record.fence,
 state:'SUCCEEDED',resourcesSettled:true,outputs:[],actualTarget:entry.offer.target,actualConfiguration:entry.offer.allowedConfigs[0].id,errorCode:null};}
test('coordinator and holder restart reconcile over pinned TLS; standalone process returns later settlement without re-execution',async()=>{
 let r=await runtime(),ledger,client,child;const errors=[];
 try{
  const f=await prepare(r);ledger=f.ledger;const running=await f.add('running1',true),queued=await f.add('queued1',false,false);
  const reserved=JSON.stringify(await r.db.allotment.findMany({orderBy:{id:'asc'}}));
  await ledger.close();ledger=null;const config=r.config;await r.close();
  const next=await createCoordinator(config);await next.app.listen(0,'127.0.0.1');await next.restore();
  r=Object.assign(next,{config,url:'https://localhost:'+next.app.getHttpServer().address().port});assert.equal(r.epoch,2);
  ledger=await DurableLedger.open(f.dir,who,r.identity.cert);const connection={...f.connection,address:r.url};
  client=new RecoveryClient(ledger,connection,e=>errors.push(e.message));await client.connect();
  await until(async()=>{const rows=await r.db.attempt.findMany();return rows.some(a=>a.id==='running1'&&a.state==='SIDE_EFFECT_UNKNOWN')&&rows.some(a=>a.id==='queued1'&&a.state==='CANCELLED_SETTLED');});
  assert.equal(await r.db.attempt.count(),2);assert.equal(occupiedV2(ledger.snapshot()).find(p=>p.resourcePoolId==='memory1').amount,100);
  assert.equal(JSON.stringify(await r.db.allotment.findMany({orderBy:{id:'asc'}})),reserved);
  assert.equal(await r.store.reconciliationAction('g1','running1'),'WAIT_SETTLEMENT');assert.equal(await r.store.reconciliationAction('g1','queued1'),'ALLOW_NEW_ATTEMPT');
  assert.equal((await r.db.receipt.findUnique({where:{id:'queued1'}})).committed,false);
  assert.throws(()=>ledger.begin('running1'),/NOT_STARTABLE/);assert.throws(()=>ledger.begin(queued.record.attemptId),/NOT_STARTABLE/);
  await client.close();client=null;
  // Test stand-in for trusted local engine reconciliation. A disconnect alone did not free this allocation.
  ledger.settle(settled(running));await ledger.close();ledger=null;
  const filename=path.join(f.dir,'recovery-test-config.json');fs.writeFileSync(filename,JSON.stringify({directory:f.dir,identity:who,connection}),{mode:0o600});
  child=spawn(process.execPath,[path.resolve('../pc-agent/dist/recovery-main.js'),filename],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  await until(async()=> (await r.db.attempt.findUnique({where:{id:'running1'}})).state==='SUCCEEDED');
  assert.match(output,/execution disabled/);assert.equal(output.includes(connection.credential),false);
  assert.equal((await r.db.receipt.findUnique({where:{id:'running1'}})).committed,false);assert.equal(await r.db.attempt.count(),2);
  assert.equal(JSON.stringify(await r.db.allotment.findMany({orderBy:{id:'asc'}})),reserved);
  const exited=once(child,'exit');child.kill();await exited;child=null;fs.unlinkSync(filename);
  assert.deepEqual(errors,[]);
 }finally{if(child){const exited=once(child,'exit');child.kill();await exited;}await client?.close();await ledger?.close();await r.close();}
});
test('lost response ACK replays the same persistent message after reconnect; forged pins never connect',async()=>{
 const r=await runtime();let ledger,client;
 try{
  const f=await prepare(r);ledger=f.ledger;await f.add('running1',true);
  let dropped=false,replyId;const send=r.channel.send.bind(r.channel);
  r.channel.send=async(session,message)=>{
   const outgoing=message.type==='Ack'?ledger.pendingMessages().find(m=>m.messageId===message.ackOf):null;
   if(!dropped&&outgoing?.type==='AttemptStatusReply'){dropped=true;replyId=outgoing.messageId;session.socket.terminate();return;}
   return send(session,message);
  };
  client=new RecoveryClient(ledger,f.connection);await client.connect();await until(()=>dropped);await client.close();client=null;
  assert.ok(ledger.pendingMessages().some(m=>m.messageId===replyId));await ledger.close();
  ledger=await DurableLedger.open(f.dir,who,r.identity.cert);
  client=new RecoveryClient(ledger,f.connection);await client.connect();await until(()=>!ledger.pendingMessages().some(m=>m.messageId===replyId));
  await until(async()=> (await r.db.attempt.findUnique({where:{id:'running1'}})).state==='SIDE_EFFECT_UNKNOWN');
  assert.equal(await r.db.attempt.count(),1);assert.equal(occupiedV2(ledger.snapshot())[0].amount,100);
  await client.close();client=null;
  const forged=new RecoveryClient(ledger,{...f.connection,fingerprint:'0'.repeat(64)});await assert.rejects(forged.connect(),/CONNECTION_INVALID/);await forged.close();
 }finally{await client?.close();await ledger?.close();await r.close();}
});
test('automatic reconnect and explicit local settlement flush update evidence without starting a new attempt',async()=>{
 const r=await runtime();let ledger,client;
 try{
  const f=await prepare(r);ledger=f.ledger;const entry=await f.add('running1',true);await ledger.close();
  ledger=await DurableLedger.open(f.dir,who,r.identity.cert);client=new RecoveryClient(ledger,f.connection);client.start();
  await until(async()=> (await r.db.attempt.findUnique({where:{id:'running1'}})).state==='SIDE_EFFECT_UNKNOWN');
  for(const session of r.channel.sessions)session.socket.terminate();
  await until(()=>[...r.channel.sessions].some(session=>session.hello));
  const {reconcileEngine}=require('../../pc-agent/dist/engine-recovery');
  await reconcileEngine(ledger,'running1',async()=>({state:'SETTLED',receipt:settled(entry)}));
  assert.ok(ledger.pendingMessages().some(m=>m.type==='RecoveryRequest'));await client.flush();
  await until(async()=> (await r.db.attempt.findUnique({where:{id:'running1'}})).state==='SUCCEEDED');
  assert.equal(await r.db.attempt.count(),1);assert.equal((await r.db.receipt.findFirst()).committed,false);assert.deepEqual(occupiedV2(ledger.snapshot()),[]);
 }finally{await client?.close();await ledger?.close();await r.close();}
});

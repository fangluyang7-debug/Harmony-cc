const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const {spawnSync}=require('node:child_process');
const {DurableLedger,grantSigningText}=require('../dist/durable-ledger');
const {occupiedV2,ledgerPoolsV2}=require('@harmony/scheduler-core');
const fixture=require('../../../contracts/scheduling/v2/fixtures/t2/valid/DispatchOffer.json');
const grantFixture=require('../../../contracts/scheduling/v2/fixtures/t2/valid/AllotmentGrant.json');
const {privateKey,publicKey}=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
const cert=publicKey.export({type:'spki',format:'pem'});
const clone=v=>structuredClone(v),identity={groupId:fixture.task.groupId,deviceId:fixture.target.deviceId,holderInstanceId:'holder1',appInstanceId:null};
const capacity=[{resourcePoolId:'memory1',amount:150},{resourcePoolId:'cpu1',amount:2}];
const context={coordinatorEpoch:1,online:true,ownerIdle:true,admissionLimit:capacity};
function dispatch(o,id='dispatch1'){return {protocolVersion:2,messageId:id,type:'DispatchOffer',groupId:identity.groupId,senderInstanceId:'coordinator1',coordinatorEpoch:1,seq:1,ackOf:null,traceId:'trace1',payload:JSON.stringify(o),extensions:[]};}
function directory(){const base=path.resolve('../../.test');fs.mkdirSync(base,{recursive:true});return fs.mkdtempSync(path.join(base,'ledger-'));}
function offer(id='a1'){const v=clone(fixture);v.task.attemptId=id;v.task.coordinatorEpoch=1;v.allotmentId='grant1';v.allotmentVersion=1;return v;}
function signed(ledger,extra=capacity,version=1,request='request1',base=[]){const s=ledger.snapshot();const g={...clone(grantFixture),groupId:s.groupId,deviceId:s.deviceId,holderInstanceId:s.holderInstanceId,appInstanceId:s.appInstanceId,ledgerEpoch:s.ledgerEpoch,coordinatorEpoch:1,allotmentId:'grant1',version,base,extra,leaseRequestId:request,leaseMs:100};g.signature=crypto.sign('sha256',Buffer.from(grantSigningText(g)),privateKey).toString('base64');return g;}
function receipt(entry,state='SUCCEEDED'){return {attemptId:entry.record.attemptId,coordinatorEpoch:1,planRevision:entry.record.planRevision,fence:entry.record.fence,state,resourcesSettled:true,outputs:[],actualTarget:entry.offer.target,actualConfiguration:entry.offer.allowedConfigs[0].id,errorCode:null};}
async function setup(dir=directory(),who=identity){let now=0;const ledger=await DurableLedger.open(dir,who,cert,()=>now);ledger.requestGrant('request1');ledger.installGrant(signed(ledger));return {ledger,dir,setNow:n=>now=n};}

test('reference settlement persists and frees only settled capacity without initiating business recovery',async()=>{
 for(const delivery of ['BUSINESS','EVALUATION']){
  const {ledger}=await setup();try{ledger.bindChannel('coordinator1',1);const entry=ledger.admit(offer(),context);ledger.begin(entry.record.attemptId);ledger.settle(receipt(entry),delivery);
   assert.equal(ledger.status(entry.record.attemptId).resourcesSettled,true);assert.deepEqual(occupiedV2(ledger.snapshot()),[]);
   assert.equal(ledger.pendingMessages().some(m=>m.type==='RecoveryRequest'),delivery==='BUSINESS');
  }finally{await ledger.close();}
 }
});

test('rename failure reports sanitized stage, poisons writer and preserves last committed snapshot',async()=>{
 const {ledger,dir}=await setup(),rename=fs.renameSync;
 const before=fs.readFileSync(path.join(dir,'ledger.json'),'utf8');
 try{
  fs.renameSync=()=>{throw Object.assign(Error('sensitive local path'),{code:'EACCES'});};
  assert.throws(()=>ledger.requestGrant('failed-request'),/^Error: LEDGER_COMMIT_RENAME:EACCES$/);
  assert.throws(()=>ledger.snapshot(),/LEDGER_UNAVAILABLE/);
  assert.equal(fs.readFileSync(path.join(dir,'ledger.json'),'utf8'),before);
 }finally{fs.renameSync=rename;await ledger.close();}
 const reopened=await DurableLedger.open(dir,identity,cert,()=>0);
 try{assert.ok(reopened.snapshot().grant);}finally{await reopened.close();}
});

test('Windows transient replacement contention retries the same snapshot and commits once',{skip:process.platform!=='win32'},async()=>{
 const {ledger,dir}=await setup(),rename=fs.renameSync;let calls=0;
 try{
  fs.renameSync=(...args)=>{if(++calls<3)throw Object.assign(Error('busy'),{code:'EPERM'});return rename(...args);};
  ledger.requestGrant('retry-request');assert.equal(calls,3);
  assert.match(fs.readFileSync(path.join(dir,'ledger.json'),'utf8'),/retry-request/);
  assert.ok(ledger.snapshot().grant);
 }finally{fs.renameSync=rename;await ledger.close();}
});

test('dispatch reservation and reply commit together; terminal report survives crash; wrong envelope cannot reserve',async()=>{
 const {ledger:l,dir}=await setup();l.bindChannel('coordinator1',1);const o=offer(),m=dispatch(o);
 assert.throws(()=>l.admit(o,context,{...m,senderInstanceId:'forged'}),/UNAUTHORIZED/);assert.equal(l.status('a1'),null);
 const entry=l.admit(o,context,m);assert.deepEqual(l.pendingMessages().map(m=>m.type),['AdmissionReply','Ack']);
 l.admit(o,context,m);assert.equal(l.pendingMessages().length,2);l.begin('a1');l.settle(receipt(entry));
 const report=l.pendingMessages().find(m=>m.type==='ExecutionReceipt');assert.ok(report);assert.equal(l.pendingMessages().some(m=>m.type==='RecoveryRequest'),false);
 await l.close();const restarted=await DurableLedger.open(dir,identity,cert,()=>0);
 try{assert.deepEqual(restarted.pendingMessages().find(m=>m.type==='ExecutionReceipt'),report);assert.equal(restarted.status('a1').state,'SUCCEEDED');assert.throws(()=>restarted.begin('a1'),/NOT_STARTABLE/);}
 finally{await restarted.close();}
});
test('rejected dispatch identity persists and cannot later execute after ACK or restart',async()=>{
 const {ledger:l,dir}=await setup();l.bindChannel('coordinator1',1);const o=offer(),m=dispatch(o);l.rejectDispatch(m,'OWNER_ACTIVE');
 for(const message of l.pendingMessages())l.acknowledgeMessage(message.messageId);
 assert.throws(()=>l.admit(o,context,m),/PREVIOUSLY_REJECTED/);await l.close();const restarted=await DurableLedger.open(dir,identity,cert,()=>0);
 try{assert.throws(()=>restarted.admit(o,context,m),/PREVIOUSLY_REJECTED/);assert.equal(restarted.status('a1'),null);assert.deepEqual(occupiedV2(restarted.snapshot()),[]);}
 finally{await restarted.close();}
});
test('atomic multi-pool admission; duplicate delivery does not run twice; cancellation and timeout do not release',async()=>{
 const {ledger:l,setNow}=await setup();try{
  const a=l.admit(offer(),context);assert.deepEqual(l.admit(offer(),context).record,a.record);
  const changed=offer();changed.task.parameters='{"changed":true}';assert.throws(()=>l.admit(changed,context),/CONFLICT/);
  const gpu=offer('a2');gpu.target.targetId='gpu2';gpu.task.allowedTargetIds=['gpu2'];assert.throws(()=>l.admit(gpu,context),/RESOURCE_UNAVAILABLE/);
  assert.equal(l.snapshot().entries.length,1);l.begin('a1');assert.throws(()=>l.begin('a1'),/NOT_STARTABLE/);
  l.cancel('a1');setNow(10000);l.expire();assert.equal(occupiedV2(l.snapshot()).find(r=>r.resourcePoolId==='memory1').amount,100);
  const wrong=receipt(a);wrong.fence={...wrong.fence,counter:99};assert.throws(()=>l.settle(wrong),/MISMATCH/);
  l.settle(receipt(a));l.settle(receipt(a));assert.deepEqual(occupiedV2(l.snapshot()),[]);
 }finally{await l.close();}
});
test('completed receipts survive restart; RUNNING before engine invocation recovers UNKNOWN and stays occupied',async()=>{
 const {ledger:l,dir}=await setup();const a=l.admit(offer(),context);l.begin('a1');await l.close();
 let restored=await DurableLedger.open(dir,identity,cert,()=>0);try{
  assert.equal(restored.status('a1').state,'SIDE_EFFECT_UNKNOWN');assert.throws(()=>restored.begin('a1'),/NOT_STARTABLE/);
  assert.equal(restored.snapshot().onlineUntil,0);assert.throws(()=>restored.admit(offer('a2'),context),/OFFLINE/);
  restored.settle(receipt(a));assert.equal(restored.receipts().length,1);
 }finally{await restored.close();}
 restored=await DurableLedger.open(dir,identity,cert,()=>0);try{assert.equal(restored.receipts().length,1);assert.equal(restored.admit(offer(),context).record.state,'SUCCEEDED');assert.throws(()=>restored.begin('a1'),/NOT_STARTABLE/);}finally{await restored.close();}
});
test('grant delay, signature, epoch replay, shrink/drain and independent fence namespaces',async()=>{
 const {ledger:l,setNow}=await setup();const {ledger:other}=await setup(directory(),{...identity,holderInstanceId:'holder2'});
 try{
  const a=l.admit(offer(),context),b=other.admit(offer(),context);assert.equal(a.record.fence.counter,b.record.fence.counter);assert.notEqual(a.record.fence.holderInstanceId,b.record.fence.holderInstanceId);
  assert.throws(()=>l.settle(receipt(b)),/MISMATCH/);
  l.requestGrant('next');const forged=signed(l,[],2,'next');forged.signature='A'.repeat(64);assert.throws(()=>l.installGrant(forged),/UNAUTHORIZED/);
  setNow(101);assert.throws(()=>l.installGrant(signed(l,[],2,'next')),/EXPIRED/);
  l.requestGrant('shrink');l.installGrant(signed(l,[],2,'shrink'));
  assert.equal(ledgerPoolsV2(l.snapshot(),[]).find(p=>p.resourcePoolId==='memory1').draining,true);
  assert.throws(()=>l.admit({...offer('a2'),allotmentVersion:2},context),/RESOURCE_UNAVAILABLE/);
  l.settle(receipt(a));assert.equal(occupiedV2(l.snapshot()).length,0);
 }finally{await l.close();await other.close();}
});
test('single writer across processes, corrupt snapshot and missing committed snapshot fail closed',async()=>{
 const {ledger:l,dir}=await setup();try{
  const code=`require(${JSON.stringify(path.resolve('dist/durable-ledger.js'))}).DurableLedger.open(${JSON.stringify(dir)},${JSON.stringify(identity)},${JSON.stringify(cert)}).then(l=>l.close().then(()=>process.exit(9))).catch(e=>{process.stdout.write(e.message);process.exit(0)})`;
  const child=spawn(process.execPath,['-e',code],{windowsHide:true});let out='';child.stdout.on('data',s=>out+=s);const exit=await new Promise(resolve=>child.on('exit',resolve));assert.equal(exit,0);assert.match(out,/SINGLE_WRITER/);
 }finally{await l.close();}
 const filename=path.join(dir,'ledger.json'),backup=fs.readFileSync(filename);fs.writeFileSync(filename,'{}');await assert.rejects(DurableLedger.open(dir,identity,cert),/CHECKSUM/);
 fs.writeFileSync(filename,backup);fs.unlinkSync(filename);await assert.rejects(DurableLedger.open(dir,identity,cert),/UNCERTAIN/);
});
test('offline base includes all previous online occupancy and never creates an additional budget',async()=>{
 const who={...identity,appInstanceId:fixture.task.app.appInstanceId},dir=directory();let now=0;const l=await DurableLedger.open(dir,who,cert,()=>now);
 try{
  l.requestGrant('request1');l.installGrant(signed(l,[{resourcePoolId:'memory1',amount:50}],1,'request1',[{resourcePoolId:'memory1',amount:100},{resourcePoolId:'cpu1',amount:2}]));
  const a=offer();a.task.priority='ORIGIN_INTERACTIVE';const entry=l.admit(a,context);now=101;
  const next=offer('a2');next.task.priority='ORIGIN_INTERACTIVE';assert.throws(()=>l.admit(next,{...context,online:false}),/RESOURCE_UNAVAILABLE/);
  l.settle(receipt(entry));assert.equal(l.admit(next,{...context,online:false}).record.state,'ACCEPTED');
 }finally{await l.close();}
});
for(const point of ['before-engine','after-settlement'])test('abrupt child-process death '+point+' preserves the durable execution boundary',async()=>{
 const dir=directory(),state={...identity,ledgerEpoch:1};
 const g=signed({snapshot:()=>state});const filename=path.join(dir,'child-config.json');
 fs.writeFileSync(filename,JSON.stringify({directory:dir,identity,certificate:cert,key:privateKey.export({type:'pkcs8',format:'pem'}),grant:g,offer:offer(),context}),{mode:0o600});
 const child=spawnSync(process.execPath,['test/crash-child.cjs',filename,point],{windowsHide:true,encoding:'utf8'});assert.equal(child.status,17,child.stderr);
 const l=await DurableLedger.open(dir,identity,cert,()=>0);try{
  assert.equal(l.status('a1').state,point==='before-engine'?'SIDE_EFFECT_UNKNOWN':'SUCCEEDED');
  assert.equal(l.receipts().length,point==='before-engine'?0:1);assert.throws(()=>l.begin('a1'),/NOT_STARTABLE/);
  assert.equal(occupiedV2(l.snapshot()).length,point==='before-engine'?2:0);
 }finally{await l.close();fs.unlinkSync(filename);}
});

test('durable ACCEPTED proves engine was never started; recovery cancels it but never frees RUNNING',async()=>{
 const {ledger:l,dir}=await setup();l.admit(offer(),context);const seq=l.snapshot().settlementSeq;await l.close();
 const restored=await DurableLedger.open(dir,identity,cert,()=>0);try{
  const record=restored.status('a1');assert.equal(record.state,'CANCELLED_SETTLED');assert.equal(record.receipt.errorCode,'RECOVERED_BEFORE_START');
  assert.equal(restored.snapshot().settlementSeq,seq+1);assert.deepEqual(occupiedV2(restored.snapshot()),[]);
  assert.throws(()=>restored.begin('a1'),/NOT_STARTABLE/);
 }finally{await restored.close();}
});
function query(seq=1,id='query1',epoch=1){return {protocolVersion:2,messageId:id,type:'AttemptStatusQuery',groupId:identity.groupId,senderInstanceId:'coordinator1',coordinatorEpoch:epoch,
 seq,ackOf:null,traceId:'trace1',extensions:[],payload:JSON.stringify({groupId:identity.groupId,holderInstanceId:identity.holderInstanceId,attemptId:'a1',coordinatorEpoch:epoch})};}
test('status response and inbox/outbox survive restart and lost ACK; altered duplicates fail closed',async()=>{
 const {ledger:l,dir}=await setup();const a=l.admit(offer(),context);l.begin('a1');l.bindChannel('coordinator1',1);l.answerStatus(query());
 const pending=l.pendingMessages();assert.equal(pending.length,2);assert.equal(pending[0].type,'AttemptStatusReply');assert.equal(JSON.parse(pending[0].payload).record.state,'RUNNING');
 l.answerStatus(query());assert.deepEqual(l.pendingMessages(),pending);await l.close();
 const restored=await DurableLedger.open(dir,identity,cert,()=>0);try{
  assert.deepEqual(restored.pendingMessages(),pending);assert.equal(restored.status('a1').state,'SIDE_EFFECT_UNKNOWN');
  const altered=query();altered.traceId='different';assert.throws(()=>restored.answerStatus(altered),/CONFLICT/);
  assert.throws(()=>restored.answerStatus(query(1,'another')),/REORDERED/);
  for(const m of pending)restored.acknowledgeMessage(m.messageId);assert.deepEqual(restored.pendingMessages(),[]);
  restored.settle(receipt(a));restored.answerStatus(query(2,'query2'));
  assert.equal(restored.pendingMessages()[0].type,'RecoveryRequest');
  assert.equal(JSON.parse(restored.pendingMessages().find(m=>m.type==='AttemptStatusReply').payload).record.resourcesSettled,true);
  restored.bindChannel('coordinator1',2);assert.deepEqual(restored.pendingMessages(),[]);
  assert.equal(restored.receipts().length,1);assert.throws(()=>restored.bindChannel('coordinator1',1),/MISMATCH/);
  assert.throws(()=>restored.bindChannel('other',2),/MISMATCH/);
 }finally{await restored.close();}
});
test('legacy snapshot upgrade preserves attempts; bounded journal overflow leaves last committed state intact',async()=>{
 const {ledger:l,dir}=await setup();l.admit(offer(),context);l.begin('a1');const old=l.snapshot();await l.close();
 const {canonical}=require('@harmony/scheduler-core');
 fs.writeFileSync(path.join(dir,'ledger.json'),JSON.stringify({state:old,sha256:crypto.createHash('sha256').update(canonical(old)).digest('hex')}));
 const restored=await DurableLedger.open(dir,identity,cert,()=>0);try{
  assert.equal(restored.status('a1').state,'SIDE_EFFECT_UNKNOWN');restored.bindChannel('coordinator1',1);
  for(let i=1;i<=32;i++)restored.answerStatus(query(i,'q'+i));
  assert.equal(restored.pendingMessages().length,64);assert.throws(()=>restored.answerStatus(query(33,'q33')),/CORRUPT|BACKPRESSURE/);
  assert.equal(restored.pendingMessages().length,64);assert.equal(occupiedV2(restored.snapshot()).length,2);
 }finally{await restored.close();}
});
test('external-engine recovery retains unknown occupancy and requires matching local settlement evidence',async()=>{
 const {reconcileEngine}=require('../dist/engine-recovery');
 const {ledger:l,dir}=await setup();const entry=l.admit(offer(),context);l.begin('a1');await l.close();
 const restored=await DurableLedger.open(dir,identity,cert,()=>0);try{
  assert.equal(await reconcileEngine(restored,'a1',async()=>{throw Error('ENGINE_UNREACHABLE');}),'UNKNOWN');
  assert.equal(await reconcileEngine(restored,'a1',async q=>{assert.equal(q.target.executorId,entry.offer.target.executorId);return {state:'RUNNING'};}),'RUNNING');
  await assert.rejects(reconcileEngine(restored,'a1',async()=>({state:'SETTLED',receipt:{...receipt(entry),fence:{...entry.record.fence,counter:9}}})),/MISMATCH/);
  assert.equal(occupiedV2(restored.snapshot()).length,2);assert.throws(()=>restored.begin('a1'),/NOT_STARTABLE/);
  assert.equal(await reconcileEngine(restored,'a1',async()=>({state:'SETTLED',receipt:receipt(entry)})),'SETTLED');
  assert.deepEqual(occupiedV2(restored.snapshot()),[]);
 }finally{await restored.close();}
});

test('profile sequence and outbox persist together; duplicate pending profile is bounded',async()=>{
 const {ledger,dir}=await setup();
 ledger.bindChannel('coordinator1',1);
 const p=structuredClone(require('../../../contracts/scheduling/v2/fixtures/t2/valid/DeviceProfile.json'));
 p.holderInstanceId=identity.holderInstanceId;p.ledgerEpoch=ledger.snapshot().ledgerEpoch;
 const first=ledger.queueProfile(p);assert.equal(JSON.parse(first.payload).sequence,first.seq);
 await assert.rejects(async()=>ledger.queueProfile(p),/PROFILE_PENDING/);
 await ledger.close();const restored=await DurableLedger.open(dir,identity,cert);
 try{assert.deepEqual(restored.pendingMessages().find(m=>m.messageId===first.messageId),first);
  restored.acknowledgeMessage(first.messageId);p.ledgerEpoch=restored.snapshot().ledgerEpoch;
  const second=restored.queueProfile(p);assert.ok(second.seq>first.seq);
 }finally{await restored.close();}
});

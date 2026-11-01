const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {runtime}=require('./helpers.cjs');
const {DeviceDirectory}=require('../dist/directory');
const {QualificationService}=require('../dist/qualification');
const {CalibrationExecutor}=require('../../pc-agent/dist/calibration-executor');
const {DurableLedger}=require('../../pc-agent/dist/durable-ledger');
const {canonical,occupiedV2}=require('@harmony/scheduler-core');
const profile=()=>structuredClone(require('../../../contracts/scheduling/v2/fixtures/t2/valid/DeviceProfile.json'));
const peer={groupId:'g1',holderInstanceId:'h1',deviceId:'device1',principalId:'p1',credentialId:'c1'};
const policy={maxRuns:12,maxDurationMs:60000,maxBytes:100000,maxConcurrent:1,caseTimeoutMs:4000,canarySamples:1,activeSamples:2,evidenceTtlMs:200,cooldownMs:20};
const key=JSON.stringify(['g1','h1','target1']);
function packFor(p){const e=p.executors[0],input=Buffer.from('{"dimension":2,"rows":[[3,4]]}');
 return {manifest:{packId:'normalize.v1',contract:e.contract,executorIds:[e.target.executorId],model:e.model,suiteId:'normalize-suite.v1',qualityThreshold:1,resourceLimit:e.resources},
 cases:[{id:'normal',input,parameters:'{}',config:e.configurations[0],maxOutputBytes:4096}],evaluate:async(_test,bytes)=>JSON.parse(bytes).rows[0][0]===.6?1:0};}
const contribution={minimumBattery:20,maximumTemperature:3,allowMetered:false,priority:'REMOTE_INTERACTIVE',requireForeground:true};

test('fresh CANARY evidence remains usable while the next case runs; a failed reference still suspends it',async()=>{
 const r=await runtime();let release;try{
  const now=100,dir=new DeviceDirectory(r.db,'SIMULATED',()=>now),p=profile();await dir.ingest(peer,p);const pack=packFor(p);let runs=0;
  const held=new Promise(resolve=>{release=resolve;});
  const runner={run:async permit=>{if(++runs===2)await held;return {settled:true,permitId:permit.id,domain:'SIMULATED',durationMs:1,output:Buffer.from(runs===1?'{"rows":[[0.6,0.8]]}':'{"rows":[[0,0]]}')};},reconcile:async()=>null};
  const service=new QualificationService(r.db,dir,[pack],runner,policy,async()=>null,()=>now);
  assert.equal(await service.advance(peer,'target1'),'CANARY');
  const pending=service.advance(peer,'target1');
  const deadline=Date.now()+5000;while(runs<2){if(Date.now()>deadline)throw Error('REFERENCE_DID_NOT_START');await new Promise(resolve=>setTimeout(resolve,10));}
  const evidence=await dir.qualification(peer,'target1');assert.equal(evidence.admission.state,'CANARY');assert.equal(evidence.admission.quality.value,1);
  release();assert.equal(await pending,'SUSPENDED');assert.equal((await dir.qualification(peer,'target1')).admission.quality.value,null);
 }finally{release?.();await r.close();}
});
test('trusted calibration uses real CPU and durable quota before automatic CANARY/ACTIVE; restart, pause, expiry and scoped evidence',async()=>{
 const r=await runtime();let ledger;let now=100,gate=null;
 try{
  const dir=new DeviceDirectory(r.db,'SIMULATED',()=>now),p=profile();p.executors[0].contract.capability='vector.normalize.v1';p.executors[0].contract.outputSchemas=['vector.normalized'];
  p.executors[0].configurations=[{id:'default',threads:1,batchSize:64,quality:'standard'}];
  await dir.ingest(peer,p);const pack=packFor(p),packDigest=crypto.createHash('sha256').update(canonical({manifest:pack.manifest,cases:pack.cases.map(c=>({...c,input:crypto.createHash('sha256').update(c.input).digest('hex')}))})).digest('hex');
  const pairedInvite=await r.auth.invite('g1','p1','device1',r.url),paired=await r.auth.exchange({inviteId:pairedInvite.inviteId,code:pairedInvite.code,holderInstanceId:'h1'});
  await r.allotments.confirmDevice('device1',p.executors[0].resources,[{groupId:'g1',holderInstanceId:'h1',appInstanceId:null}]);
  ledger=await DurableLedger.open(path.join(r.config.dataDir,'evaluation-ledger'),{groupId:'g1',deviceId:'device1',holderInstanceId:'h1',appInstanceId:null},r.identity.cert);
  ledger.requestGrant('eval-grant');const grant=await r.allotments.issue(paired.peer,{ledgerEpoch:1,leaseRequestId:'eval-grant',leaseMs:300000,base:[],extra:p.executors[0].resources});ledger.installGrant(grant);
  const runner=new CalibrationExecutor(ledger,path.join(r.config.dataDir,'evaluation-output'),'SIMULATED',new Map([[packDigest+':normal',pack.cases[0]]]),async(permit,executor)=>{
   const offer=structuredClone(require('../../../contracts/scheduling/v2/fixtures/t2/valid/DispatchOffer.json'));
   offer.task.attemptId=permit.id;offer.task.contract=executor.contract;offer.task.inputs[0].contentHash=permit.inputHash;offer.task.parameters='{}';offer.target=executor.target;
   offer.resources=executor.resources;offer.allowedConfigs=[permit.config];offer.allotmentId=grant.allotmentId;offer.leaseMs=permit.timeoutMs;offer.task.budget={remainingMs:permit.timeoutMs,deadlineAt:Date.now()+permit.timeoutMs};return offer;
  },async()=>({coordinatorEpoch:r.epoch,online:true,ownerIdle:true,admissionLimit:grant.extra}));
  const make=()=>new QualificationService(r.db,dir,[pack],runner,policy,async()=>gate,()=>now);let service=make();
  assert.equal((await dir.snapshot('g1','p1',1,contribution)).candidates.length,0);
  assert.equal(await service.advance(peer,'target1'),'CANARY');assert.deepEqual(occupiedV2(ledger.snapshot()),[]);
  assert.equal((await dir.snapshot('g1','p1',1,contribution)).candidates.length,1);
  service=make();await service.pause(peer,'target1',true);assert.equal(await service.advance(peer,'target1'),'WAITING_WINDOW');
  await service.pause(peer,'target1',false);gate='AUTH';assert.equal(await service.advance(peer,'target1'),'WAITING_AUTH');gate=null;
  assert.equal(await service.advance(peer,'target1'),'ACTIVE');assert.equal(ledger.snapshot().entries.length,2);
  assert.equal(await service.advance(peer,'target1'),'ACTIVE');assert.equal(ledger.snapshot().entries.length,2);
  now=301;assert.equal((await dir.snapshot('g1','p1',1,contribution)).candidates.length,0);assert.equal(await service.advance(peer,'target1'),'SUSPENDED');
  assert.equal(await service.advance(peer,'target1'),'CANARY');
  p.sequence++;p.foreground.value='BACKGROUND';await dir.ingest(peer,p);assert.equal(await service.advance(peer,'target1'),'WAITING_WINDOW');
  await assert.rejects(service.advance({...peer,deviceId:'other'},'target1'),/UNKNOWN/);
 }finally{if(ledger)await ledger.close();await r.close();}
});
test('missing pack, malformed output, budget exhaustion and unknown settlement never qualify; failures cool down',async()=>{
 const r=await runtime();let now=100,starts=0;
 try{
  const dir=new DeviceDirectory(r.db,'SIMULATED',()=>now),p=profile();await dir.ingest(peer,p);const pack=packFor(p);
  const unknown={run:async()=>{starts++;throw Error('LOST');},reconcile:async()=>null};
  assert.equal(await new QualificationService(r.db,dir,[],unknown,policy,async()=>null,()=>now).advance(peer,'target1'),'SUSPENDED');
  let service=new QualificationService(r.db,dir,[pack],unknown,policy,async()=>null,()=>now);
  assert.equal(await service.advance(peer,'target1'),'SUSPENDED'); // Trusted pack change invalidates previous job.
  assert.equal(await service.advance(peer,'target1'),'WAITING_RESOURCE');
  service=new QualificationService(r.db,dir,[pack],unknown,policy,async()=>null,()=>now);assert.equal(await service.advance(peer,'target1'),'WAITING_RESOURCE');assert.equal(starts,1);
  const job=JSON.parse((await r.db.calibrationJob.findUniqueOrThrow({where:{id:key}})).metadataJson);
  const settled={run:async permit=>({settled:true,permitId:permit.id,domain:'SIMULATED',output:Buffer.from('bad json'),durationMs:1}),reconcile:async permit=>({settled:true,permitId:permit.id,domain:'SIMULATED',output:Buffer.alloc(0),durationMs:0})};
  service=new QualificationService(r.db,dir,[pack],settled,policy,async()=>null,()=>now);
  assert.equal(await service.advance(peer,'target1'),'SUSPENDED');assert.equal(JSON.parse((await r.db.capabilityState.findUniqueOrThrow({where:{id:key}})).metadataJson).reasonCode,'QUALITY_EVALUATION_FAILED');
  assert.equal(await service.advance(peer,'target1'),'SUSPENDED');assert.equal(JSON.parse((await r.db.capabilityState.findUniqueOrThrow({where:{id:key}})).metadataJson).reasonCode,'EVALUATION_COOLDOWN');
  now=130;service=new QualificationService(r.db,dir,[pack],settled,{...policy,maxBytes:1},async()=>null,()=>now);
  assert.equal(await service.advance(peer,'target1'),'SUSPENDED');assert.equal(JSON.parse((await r.db.capabilityState.findUniqueOrThrow({where:{id:key}})).metadataJson).reasonCode,'EVALUATION_BUDGET_EXHAUSTED');
  assert.ok(job.inFlight);assert.equal((await dir.snapshot('g1','p1',1,contribution)).candidates.length,0);
 }finally{await r.close();}
});

const {QualificationLoop}=require('../dist/qualification-loop');
test('calibration loop bounds work, prevents overlap, refreshes failed targets and rotates fairly',async()=>{
 const calls=[],refreshes=[],errors=[];let release;
 const gate=new Promise(r=>release=r);
 const targets=['a','b','c'].map(targetId=>({peer:{groupId:'g',holderInstanceId:'h'},targetId}));
 const loop=new QualificationLoop({advance:async(_,id)=>{calls.push(id);if(id==='a')await gate;if(id==='b')throw Error('FAILED');}},
  {targets:async()=>targets,refresh:async g=>refreshes.push(g),onError:e=>errors.push(e.message)},60000,2);
 loop.start();const first=loop.tick();assert.equal(loop.tick(),first);release();await first;
 assert.deepEqual(calls,['a','b']);assert.deepEqual(refreshes,['g','g']);assert.deepEqual(errors,['FAILED']);
 await loop.tick();assert.deepEqual(calls,['a','b','c','a']);await loop.close();await loop.tick();assert.equal(calls.length,4);
});

test('qualification read is scoped to holder and invalidated when executor is removed',async()=>{
 const r=await runtime();try{
  const p=structuredClone(require('../../../contracts/scheduling/v2/fixtures/t2/valid/DeviceProfile.json'));
  const invite=await r.auth.invite('g1','p1','device1',r.url),pair=await r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:p.holderInstanceId});
  await r.directory.ingest(pair.peer,p);
  const {pinnedRequest}=require('../dist/pinned-client');
  const result=await pinnedRequest(invite,'/v2/qualification/target1',undefined,pair.credential);
  assert.equal(result.admission.state,'DISCOVERED');
  const otherInvite=await r.auth.invite('g1','p1','device1',r.url),other=await r.auth.exchange({inviteId:otherInvite.inviteId,code:otherInvite.code,holderInstanceId:'other'});
  await assert.rejects(pinnedRequest(invite,'/v2/qualification/target1',undefined,other.credential),/401/);
  p.sequence++;p.executors=[];await r.directory.ingest(pair.peer,p);
  await assert.rejects(pinnedRequest(invite,'/v2/qualification/target1',undefined,pair.credential),/401/);
 }finally{await r.close();}
});

test('coordinator owns calibration loop lifecycle and enumerates only active credentials',async()=>{
 const r=await runtime();try{
  const p=profile(),invite=await r.auth.invite('g1','p1','device1',r.url),paired=await r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:p.holderInstanceId});
  await r.directory.ingest(paired.peer,p);
  let gates=0;const errors=[];
  r.startCalibration({packs:[packFor(p)],runner:{run:async()=>{throw Error('MUST_NOT_EXECUTE');},reconcile:async()=>null},policy,
    gate:async()=>{gates++;return 'RESOURCE';},onError:e=>errors.push(e.message),intervalMs:100});
  const until=async check=>{const deadline=Date.now()+5000;while(!await check()){if(Date.now()>deadline)throw Error('TIMEOUT');await new Promise(r=>setTimeout(r,20));}};
  await until(async()=>(await r.directory.qualification(paired.peer,'target1')).admission.state==='WAITING_RESOURCE');assert.ok(gates>0);
  await r.auth.revoke(paired.peer.credentialId);assert.deepEqual(await r.auth.activePeers(),[]);
  await r.close();const count=gates;await new Promise(resolve=>setTimeout(resolve,150));assert.equal(gates,count);
  assert.ok(errors.every(e=>e==='GROUP_UNKNOWN'));
 }finally{await r.close();}
});

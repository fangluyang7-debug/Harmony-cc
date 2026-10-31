const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),crypto=require('node:crypto');
const {fork}=require('node:child_process');
const {runtime}=require('./helpers.cjs');
const {DeviceDirectory,executorIdentity}=require('../dist/directory');
const {RemoteEvaluationRunner}=require('../dist/remote-evaluation');
const {allotmentTransport}=require('../../pc-agent/dist/allotment-client');
const {canonical}=require('@harmony/scheduler-core');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
async function until(fn){const end=Date.now()+15000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,20));}throw Error('REMOTE_TEST_TIMEOUT');}
async function setup(){
 const r=await runtime();
 const invitation=await r.auth.invite('g1','p1','device1',r.url),pair=await r.auth.exchange({inviteId:invitation.inviteId,code:invitation.code,holderInstanceId:'h1'});
 const profile=structuredClone(require('../../../contracts/scheduling/v2/fixtures/t2/valid/DeviceProfile.json')),executor=profile.executors[0];
 executor.contract.capability='vector.normalize.v1';executor.contract.inputSchemas=['vector.input'];executor.contract.outputSchemas=['vector.normalized'];
 const directory=new DeviceDirectory(r.db,'SIMULATED',()=>100);await directory.ingest(pair.peer,profile);
 await r.allotments.confirmDevice('device1',executor.resources,[{groupId:'g1',holderInstanceId:'h1',appInstanceId:null}]);
 const input=Buffer.from('{"dimension":2,"rows":[[3,4],[0,0]]}'),config=executor.configurations[0];
 const pack={manifest:{packId:'normalize',contract:executor.contract,executorIds:[executor.target.executorId],model:null,suiteId:'reference',qualityThreshold:1,resourceLimit:executor.resources},
  cases:[{id:'reference',input,parameters:'{}',config,maxOutputBytes:4096}],evaluate:async(_t,b)=>canonical(JSON.parse(b))===canonical({dimension:2,rows:[[.6,.8],[0,0]],norms:[5,0]})?1:0};
 const packDigest=hash(Buffer.from(canonical({manifest:pack.manifest,cases:pack.cases.map(c=>({...c,input:hash(c.input)}))})));
 const permit=()=>({id:crypto.randomUUID(),groupId:'g1',holderInstanceId:'h1',targetId:'target1',identity:executorIdentity(executor),packDigest,caseId:'reference',inputHash:hash(input),config,maxOutputBytes:4096,timeoutMs:5000,domain:'SIMULATED'});
 const connection={address:r.url,certificate:invitation.certificate,fingerprint:invitation.fingerprint,credential:pair.credential,domain:'SIMULATED'};
 return {r,pair,profile,executor,directory,pack,packDigest,permit,connection,request:allotmentTransport(connection)};
}
test('remote calibration crosses process and TLS boundaries; dropped output delivery reuses settled CPU result',async()=>{
 const s=await setup();const {r}=s;let child;let runs=0;
 try{
  const offer=structuredClone(require('../../../contracts/scheduling/v2/fixtures/t2/valid/DispatchOffer.json'));
  offer.task.contract=s.executor.contract;offer.target=s.executor.target;offer.resources=s.executor.resources;offer.allowedConfigs=[s.pack.cases[0].config];
  offer.task.parameters='{}';offer.task.inputs=[{artifactId:'evaluation-input',contentVersion:1,contentHash:s.permit().inputHash,schemaId:'vector.input',schemaVersion:1}];offer.transferPlan=[];
  child=fork(path.join(__dirname,'remote-evaluation-worker.cjs'),[],{stdio:['ignore','ignore','pipe','ipc'],windowsHide:true});let ready=false,failed=false;
  child.on('message',m=>{if(m.ready)ready=true;if(m.failed)failed=true;if(m.runs)runs=m.runs;});
  child.send({config:{connection:s.connection,directory:path.join(r.config.dataDir,'child-ledger'),identity:{groupId:'g1',deviceId:'device1',holderInstanceId:'h1',appInstanceId:null},instance:'instance1',epoch:r.epoch,executor:s.executor,
   test:{...s.pack.cases[0],input:s.pack.cases[0].input.toString('base64')},packDigest:s.packDigest,offer,dropReport:true}});
  await until(()=>ready||failed);assert.equal(failed,false);
  // Install fresh software-domain samples; the lifecycle uses the real host clock, with no manual advance/ACTIVE injection.
  function fresh(value){if(!value||typeof value!=='object')return;if('sampledAt'in value){value.sampledAt=Date.now();value.ttlMs=60000;}for(const child of Object.values(value))fresh(child);}
  fresh(s.profile);s.profile.sequence++;
  await r.profiles.configure('g1',{version:'policy1',revoked:false,allowedTargetIds:['target1'],limits:{maxCandidates:8,lookahead:16,beamWidth:8,planningBudgetMs:20,switchCostMs:0,hysteresisMs:0}},
   {minimumBattery:null,maximumTemperature:null,allowMetered:true,priority:'REMOTE_INTERACTIVE',requireForeground:true});
  await r.profiles.ingest(s.pair.peer,s.profile);const errors=[];
  r.startCalibration({packs:[s.pack],policy:{maxRuns:4,maxDurationMs:30000,maxBytes:100000,maxConcurrent:1,caseTimeoutMs:10000,canarySamples:1,activeSamples:1,evidenceTtlMs:60000,cooldownMs:100},
   gate:async()=>null,onError:e=>errors.push(e.message),intervalMs:100});
  await until(async()=>(await r.directory.qualification(s.pair.peer,'target1')).admission.state==='ACTIVE');assert.equal(runs,1);assert.deepEqual(errors,[]);
  await until(async()=>(await r.snapshots.build('g1')).snapshot.candidates.some(c=>c.targetId==='target1'));
  const row=await r.db.evaluationDispatch.findFirstOrThrow();assert.equal(row.state,'SETTLED');
  const restarted=new RemoteEvaluationRunner(r.db,r.directory,()=>r.epoch);
  const result=await restarted.reconcile(JSON.parse(row.workJson).permit);assert.deepEqual(JSON.parse(result.output),{dimension:2,rows:[[.6,.8],[0,0]],norms:[5,0]});
  const report=JSON.parse(row.resultJson);await s.request('/v2/evaluations/'+row.id+'/report',report);
  await assert.rejects(s.request('/v2/evaluations/'+row.id+'/report',{...report,output:Buffer.from('different').toString('base64')}),/REJECTED/);
  const invite=await r.auth.invite('g1','p2','device2',r.url),other=await r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:'h2'}),foreign=allotmentTransport({...s.connection,credential:other.credential});
  assert.deepEqual(await foreign('/v2/evaluations/claim',{}),{work:null});
  await assert.rejects(foreign('/v2/evaluations/'+row.id,null),/REJECTED/);
  await assert.rejects(foreign('/v2/evaluations/'+row.id+'/report',report),/REJECTED/);
  await r.auth.revoke(s.pair.peer.credentialId);await assert.rejects(s.request('/v2/evaluations/claim',{}),/REJECTED/);
 }finally{
  if(child&&child.connected){const exited=new Promise(resolve=>child.once('exit',resolve));child.send({stop:true});const timeout=setTimeout(()=>child.kill(),12000);await exited;clearTimeout(timeout);}
  await r.close();
 }
});
test('claimed delivery is reconciliation-only after restart; cancellation never fabricates settlement for an unknown engine',async()=>{
 const s=await setup(),p=s.permit(),abort=new AbortController();
 try{
  const running=s.r.remoteEvaluation.run(p,s.pack.cases[0],s.executor,abort.signal).catch(e=>e);
  await until(async()=>await s.r.db.evaluationDispatch.count()===1);
  const first=(await s.request('/v2/evaluations/claim',{})).work;assert.equal(first.mode,'RUN');
  const restarted=new RemoteEvaluationRunner(s.r.db,s.r.directory,()=>s.r.epoch+1);
  assert.equal((await restarted.claim(s.pair.peer)).mode,'RECONCILE');
  assert.equal((await restarted.status(s.pair.peer,p.id)).cancel,true);
  abort.abort();assert.match((await running).message,/UNKNOWN/);
  assert.equal(await restarted.reconcile(p),null);
  const report={settled:true,permitId:p.id,domain:'SIMULATED',durationMs:0,output:''};
  await assert.rejects(s.request('/v2/evaluations/'+p.id+'/report',{...report,domain:'REAL'}),/REJECTED/);
  await assert.rejects(s.request('/v2/evaluations/'+p.id+'/report',{...report,output:'not base64'}),/REJECTED/);
  await s.request('/v2/evaluations/'+p.id+'/report',report);assert.equal((await restarted.reconcile(p)).settled,true);
 }finally{abort.abort();await s.r.close();}
});
test('unclaimed cancellation and stale queued installation have non-execution proof',async()=>{
 const s=await setup();
 try{
  const p=s.permit(),abort=new AbortController(),running=s.r.remoteEvaluation.run(p,s.pack.cases[0],s.executor,abort.signal).catch(e=>e);
  await until(async()=>await s.r.db.evaluationDispatch.count()===1);abort.abort();await running;
  assert.equal((await s.r.remoteEvaluation.reconcile(p)).output.length,0);assert.equal((await s.request('/v2/evaluations/claim',{})).work,null);
  const p2=s.permit(),abort2=new AbortController(),running2=s.r.remoteEvaluation.run(p2,s.pack.cases[0],s.executor,abort2.signal).catch(e=>e);
  await until(async()=>await s.r.db.evaluationDispatch.count()===2);
  const restart=new RemoteEvaluationRunner(s.r.db,s.r.directory,()=>s.r.epoch+1);
  assert.equal(await restart.claim(s.pair.peer),null);assert.equal((await running2).settled,true);
 }finally{await s.r.close();}
});

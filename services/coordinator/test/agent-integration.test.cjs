const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),crypto=require('node:crypto');
const {runtime}=require('./helpers.cjs'),{fixture}=require('./fixtures.cjs');
const {PcAgent}=require('../../pc-agent/dist/agent'),{DurableLedger}=require('../../pc-agent/dist/durable-ledger');
const {CalibrationExecutor}=require('../../pc-agent/dist/calibration-executor'),{artifactPorts}=require('../../pc-agent/dist/artifact-client');
const {requireBusinessQualification}=require('../../pc-agent/dist/business-gate');
const {QualificationService}=require('../dist/qualification'),{DeviceDirectory}=require('../dist/directory');
const {transfer}=require('@harmony/resource-transport'),{canonical,occupiedV2}=require('@harmony/scheduler-core');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
async function until(check){const deadline=Date.now()+15000;while(Date.now()<deadline){if(await check())return;await new Promise(r=>setTimeout(r,20));}throw Error('AGENT_TEST_TIMEOUT');}
test('integrated agent: trusted CPU qualification -> pinned artifacts -> WS dispatch -> durable report/trace; lost ACK and restart never execute twice',async()=>{
 const schemas=new Map([['vector.input:1',bytes=>{const v=JSON.parse(bytes);return v.dimension===2&&Array.isArray(v.rows);}],['vector.normalized:1',bytes=>{const v=JSON.parse(bytes);return v.dimension===2&&Array.isArray(v.norms);}]]);
 const r=await runtime({artifactSchemas:schemas});let ledger,agent;const errors=[];
 try{
  const invite=await r.auth.invite('g1','p1','device1',r.url),pair=await r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:'h1'}),peer=pair.peer;
  const p=structuredClone(require('../../../contracts/scheduling/v2/fixtures/t2/valid/DeviceProfile.json')),executor=p.executors[0];
  executor.contract.capability='vector.normalize.v1';executor.contract.inputSchemas=['vector.input'];executor.contract.outputSchemas=['vector.normalized'];
  const config=executor.configurations[0],input=Buffer.from('{"dimension":2,"rows":[[3,4],[0,0]]}');
  const directory=new DeviceDirectory(r.db,'SIMULATED',()=>100);await directory.ingest(peer,p);
  await r.allotments.confirmDevice('device1',executor.resources,[{groupId:'g1',holderInstanceId:'h1',appInstanceId:null}]);
  const ledgerDir=path.join(r.config.dataDir,'integrated-agent'),identity={groupId:'g1',deviceId:'device1',holderInstanceId:'h1',appInstanceId:null};
  ledger=await DurableLedger.open(ledgerDir,identity,r.identity.cert);ledger.requestGrant('grant1');
  const grant=await r.allotments.issue(peer,{ledgerEpoch:1,leaseRequestId:'grant1',leaseMs:300000,base:[],extra:executor.resources});ledger.installGrant(grant);
  const inputRef={artifactId:'integration-input',contentVersion:1,contentHash:digest(input),schemaId:'vector.input',schemaVersion:1};
  const descriptor={ref:inputRef,groupId:'g1',ownerPrincipalId:'p1',domain:'SIMULATED',bytes:input.length,expiresAt:Date.now()+120000};
  r.artifacts.register(descriptor);await transfer(invite,r.artifacts.issue(descriptor,peer,'WRITE'),pair.credential,input);
  function offerFor(id){const o=structuredClone(require('../../../contracts/scheduling/v2/fixtures/t2/valid/DispatchOffer.json'));
   o.task.attemptId=id;o.task.workflowId='wf-'+id;o.task.nodeId='node-'+id;o.task.priority='REMOTE_INTERACTIVE';o.task.contract=executor.contract;o.task.inputs=[inputRef];o.task.parameters='{}';
   // This suite tests transport/recovery, not a one-second latency target under concurrent RSA/SQLite load.
   o.leaseMs=15000;o.task.budget={remainingMs:15000,deadlineAt:Date.now()+15000};o.target=executor.target;o.resources=executor.resources;o.allowedConfigs=[config];o.allotmentId=grant.allotmentId;o.leaseMs=5000;o.transferPlan=[];return o;}
  let publishes=0;const outputs=new Map();
  const ports=artifactPorts({read:async(ref,offer)=>{assert.equal(offer.task.app.principalId,'p1');assert.deepEqual(ref,inputRef);return {endpoint:invite,ticket:r.artifacts.issue(descriptor,peer,'READ'),credential:pair.credential};},
   write:async(bytes,schemaId,offer)=>{publishes++;const ref={artifactId:'out-'+offer.task.attemptId,contentVersion:1,contentHash:digest(bytes),schemaId,schemaVersion:1};
    const d={...descriptor,ref,bytes:bytes.length};r.artifacts.register(d);outputs.set(offer.task.attemptId,d);return {endpoint:invite,ticket:r.artifacts.issue(d,peer,'WRITE'),credential:pair.credential};}});
  const context=()=>({coordinatorEpoch:r.epoch,online:true,ownerIdle:true,admissionLimit:grant.extra});
  const pack={manifest:{packId:'normalize',contract:executor.contract,executorIds:[executor.target.executorId],model:null,suiteId:'reference1',qualityThreshold:1,resourceLimit:executor.resources},
   cases:[{id:'reference',input,parameters:'{}',config,maxOutputBytes:4096}],evaluate:async(_c,b)=>canonical(JSON.parse(b))===canonical({dimension:2,rows:[[.6,.8],[0,0]],norms:[5,0]})?1:0};
  const packDigest=digest(Buffer.from(canonical({manifest:pack.manifest,cases:pack.cases.map(c=>({...c,input:digest(c.input)}))})));
  const evaluator=new CalibrationExecutor(ledger,path.join(r.config.dataDir,'evaluation'),'SIMULATED',new Map([[packDigest+':reference',pack.cases[0]]]),async permit=>{const o=offerFor(permit.id);o.leaseMs=permit.timeoutMs;return o;},async()=>context());
  const options={connection:{address:r.url,certificate:invite.certificate,fingerprint:invite.fingerprint,credential:pair.credential,domain:'SIMULATED'},
   deviceInstanceId:'instance1',queuePolicy:{shares:[.5,.3,.2],agingMs:100,maxConsecutive:2,yieldDeadlineMs:1000},select:o=>o.allowedConfigs[0],snapshotVersion:()=>1,onYield:()=>{},onError:e=>errors.push(e.message),
   now:()=>100,
   ports:{...ports,authorize:async()=>context()},calibration:{executor:evaluator,intervalMs:100}};
  agent=new PcAgent(ledger,options);await agent.updateResources(grant.extra,'IDLE');agent.start();await until(()=>agent.ready);
  await agent.publishProfile(p);assert.ok((await r.directory.profiles(peer.groupId))[0].sequence>1);
  async function dispatch(id){const offer=offerFor(id),message={...fixture('MessageEnvelope'),messageId:'dispatch-'+id,type:'DispatchOffer',senderInstanceId:r.identity.id,traceId:'trace-'+id,payload:JSON.stringify(offer)};
   await r.store.persistOffer(offer,'h1',message);await r.channel.flush();return offer;}
  await dispatch('unqualified');await until(async()=> (await r.db.attempt.findUnique({where:{id:'unqualified'}}))?.state==='REJECTED');assert.equal(ledger.status('unqualified'),null);
  const qualification=new QualificationService(r.db,directory,[pack],r.remoteEvaluation,{maxRuns:4,maxDurationMs:20000,maxBytes:100000,maxConcurrent:1,caseTimeoutMs:5000,canarySamples:1,activeSamples:2,evidenceTtlMs:10000,cooldownMs:100},async()=>null,()=>100);
  assert.equal(await qualification.advance(peer,'target1'),'CANARY');assert.equal(await qualification.advance(peer,'target1'),'ACTIVE');
  let dropped=false,reportId;const send=r.channel.send.bind(r.channel);
  r.channel.send=async(session,m)=>{const pending=ledger.pendingMessages().find(p=>p.messageId===m.ackOf);if(!dropped&&m.type==='Ack'&&pending?.type==='ExecutionReceipt'){dropped=true;reportId=pending.messageId;session.socket.terminate();return;}return send(session,m);};
  const business=await dispatch('business');try{await until(async()=> (await r.db.receipt.findUnique({where:{id:'business'}}))?.committed);}catch(error){throw Error(JSON.stringify({cause:error.message,errors,local:ledger.status('business'),pending:ledger.pendingMessages().map(m=>({type:m.type,payload:m.type==='AdmissionReply'?m.payload:undefined}))}));}
  await until(()=>dropped&&agent.ready&&!ledger.pendingMessages().some(m=>m.messageId===reportId));
  assert.equal(publishes,1);assert.equal(ledger.snapshot().entries.filter(e=>e.record.attemptId==='business').length,1);assert.deepEqual(occupiedV2(ledger.snapshot()),[]);
  const d=outputs.get('business'),result=await transfer(invite,r.artifacts.issue(d,peer,'READ'),pair.credential);assert.deepEqual(JSON.parse(result.bytes),{dimension:2,rows:[[.6,.8],[0,0]],norms:[5,0]});
  await until(async()=>await r.db.traceSpan.count()>=3);const trace=await r.traces.read(peer,'trace-business');assert.deepEqual(trace.spans.map(s=>s.phase).sort(),['EXECUTE','LOAD','PUBLISH']);assert.equal(trace.analysis.issues.includes('ROOT_INCOMPLETE'),true);
  assert.ok(!errors.some(e=>/CONFLICT|CORRUPT|UNAUTHORIZED|INVALID/.test(e)),errors.join(','));
  await agent.close();agent=null;await ledger.close();ledger=await DurableLedger.open(ledgerDir,identity,r.identity.cert);
  assert.equal(ledger.status(business.task.attemptId).state,'SUCCEEDED');assert.throws(()=>ledger.begin('business'),/NOT_STARTABLE/);assert.equal(publishes,1);
 }finally{await agent?.close();await ledger?.close();await r.close();}
});

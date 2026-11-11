const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {PrismaClient}=require('../generated/client');
const {SnapshotBuilder,PlanningService}=require('../dist/planning');
test('batched snapshot publication crosses SQL batches, preserves retired rows and rolls back on invalid scope',async()=>{
 const {runtime}=require('./helpers.cjs'),r=await runtime();
 try{
  const f=fixture(),builder=new SnapshotBuilder(r.db,'SIMULATED');
  f.snapshot.candidates=Array.from({length:205},(_,i)=>({...f.snapshot.candidates[0],targetId:'target-'+i,executorId:"executor'quoted"}));
  await builder.replace(f.snapshot,f.policy);
  assert.equal((await builder.build('g1')).snapshot.candidates.length,205);
  f.snapshot.candidates=f.snapshot.candidates.slice(0,2);f.snapshot.candidates[0].computeMs=99;
  await builder.replace(f.snapshot,f.policy);
  const saved=(await builder.build('g1')).snapshot;assert.equal(saved.version,2);assert.equal(saved.candidates.length,2);assert.equal(saved.candidates[0].computeMs,99);
  assert.equal(await r.db.target.count({where:{groupId:'g1'}}),205,'retired projections remain available for audit');
  f.snapshot.candidates[0].availability={snapshotVersion:999};
  await assert.rejects(builder.replace(f.snapshot,f.policy),/AVAILABILITY_SCOPE_MISMATCH/);
  assert.deepEqual((await builder.build('g1')).snapshot,saved,'a rejected publication cannot expose a partial revision');
 }finally{await r.close();}
});
function fixture(){
  const policy={version:'p1',revoked:false,allowedTargetIds:['target1'],limits:{maxCandidates:8,lookahead:16,beamWidth:8,planningBudgetMs:20,switchCostMs:0,hysteresisMs:0}};
  const snapshot={version:1,policyVersion:'p1',groupId:'g1',domain:'SIMULATED',capturedAt:100,
    devices:[{deviceId:'d1',deviceInstanceId:'instance1',ledgerEpoch:1,sampledAt:100,ttlMs:1000}],
    resources:[{deviceId:'d1',resourcePoolId:'memory',availableMemoryBytes:100,availableSlots:1,observedAt:100,ttlMs:1000}],links:[],
    candidates:[{targetId:'target1',deviceId:'d1',executorId:'executor1',capability:'test.capability',resourcePoolIds:['memory'],trusted:true,source:'SIMULATED',observedAt:100,ttlMs:1000,availableSlots:1,availableMemoryBytes:100,quality:1,computeMs:10,queueMs:0,coldMs:0,publishMs:0,uncertaintyMs:0}]};
  const request={nodes:[{id:'n1',capability:'test.capability',dependencies:[],inputs:['input'],output:{id:'output',bytes:10},baselineTargetId:'target1',memoryBytes:10,minimumQuality:1,candidates:[]}],
    artifacts:[{id:'input',bytes:10,replicas:[{deviceId:'d1',readMs:0}]}],links:[],deviceResources:[],domain:'SIMULATED',remainingBudgetMs:1000,networkAllowed:false,privacy:'LOCAL_ONLY',localDeviceId:'d1',now:100,committedNodeIds:[],committedArtifacts:[],finalDestination:'d1'};
  return {snapshot,policy,request,clock:{now:100,monotonic:()=>0}};
}
test('pure planning does not touch I/O ports and returns bounded fallback on virtual time',()=>{
  let calls=0;const io=new Proxy({},{get(){calls++;throw Error('IO_FORBIDDEN');}}),service=new PlanningService(io);
  const f=fixture();const before=JSON.stringify(f.snapshot);
  assert.equal(service.plan(f.snapshot,f.request,f.policy,f.clock).decision.status,'ready');
  let tick=0;f.policy.limits.planningBudgetMs=1;
  assert.equal(service.plan(f.snapshot,f.request,f.policy,{now:100,monotonic:()=>tick++}).decision.reason,'PLANNING_BUDGET_BASELINE');
  assert.equal(calls,0);assert.equal(JSON.stringify(f.snapshot),before);
  f.policy.revoked=true;assert.throws(()=>service.plan(f.snapshot,f.request,f.policy,f.clock),/POLICY_INVALID/);
});
test('device epoch freshness and target authorization affect the decision',()=>{
  const service=new PlanningService(null),f=fixture();
  assert.equal(service.plan(f.snapshot,f.request,f.policy,{now:1200,monotonic:()=>0}).decision.status,'blocked');
  f.policy.allowedTargetIds=[];assert.equal(service.plan(f.snapshot,f.request,f.policy,f.clock).decision.status,'blocked');
  f.policy.allowedTargetIds=['target1'];f.snapshot.resources[0].availableMemoryBytes=0;
  assert.equal(service.plan(f.snapshot,f.request,f.policy,f.clock).decision.status,'blocked');
});

test('App-bound candidates require the same authenticated installation even with an explicit target',()=>{
 const service=new PlanningService(null),f=fixture();
 f.snapshot.candidates[0].appInstanceId='installation-one';
 f.request.nodes[0].allowedTargetIds=['target1'];
 assert.equal(service.plan(f.snapshot,f.request,f.policy,f.clock).decision.status,'blocked');
 f.request.appInstanceId='installation-two';
 assert.equal(service.plan(f.snapshot,f.request,f.policy,f.clock).decision.status,'blocked');
 f.request.appInstanceId='installation-one';
 assert.equal(service.plan(f.snapshot,f.request,f.policy,f.clock).decision.status,'ready');
 delete f.snapshot.candidates[0].appInstanceId;
 f.request.appInstanceId='installation-two';
 assert.equal(service.plan(f.snapshot,f.request,f.policy,f.clock).decision.status,'ready');
});

test('origin sandbox costs zero transfer only for its holder; another holder on the same device pays both relay hops',()=>{
 const service=new PlanningService(null),f=fixture();
 f.snapshot.devices[0].holderInstanceId='source';f.snapshot.candidates[0].holderInstanceId='source';
 f.request.artifacts[0].replicas=[{deviceId:'d1',holderInstanceId:'source',readMs:0}];
 f.request.inputRelayId='relay';f.request.networkAllowed=true;f.request.privacy='AUTHORIZED_REMOTE';
 f.snapshot.links=[{from:'d1',to:'relay',bytesPerSecond:1000,fixedMs:2,effective:false,observedAt:100,ttlMs:1000,source:'SIMULATED'},{from:'relay',to:'d1',bytesPerSecond:1000,fixedMs:3,effective:false,observedAt:100,ttlMs:1000,source:'SIMULATED'}];
 assert.equal(service.plan(f.snapshot,f.request,f.policy,f.clock).decision.suggestion[0].inputTransferMs,0);
 f.snapshot.devices[0].holderInstanceId='other';f.snapshot.candidates[0].holderInstanceId='other';
 assert.equal(service.plan(f.snapshot,f.request,f.policy,f.clock).decision.suggestion[0].inputTransferMs,25);
 f.snapshot.links=[];assert.equal(service.plan(f.snapshot,f.request,f.policy,f.clock).decision.status,'blocked');
});

for(const [sourceId,workerId] of [['d1','remote'],['cloud-runtime','phone_7'],['phone_7','cloud-runtime']])
test('placement follows measured costs across device identifiers '+sourceId+' and '+workerId,()=>{
 const service=new PlanningService(null),f=fixture();
 f.snapshot.devices[0].deviceId=sourceId;f.snapshot.resources[0].deviceId=sourceId;
 f.snapshot.candidates[0].deviceId=sourceId;f.request.localDeviceId=sourceId;
 f.snapshot.devices[0].holderInstanceId='source';f.snapshot.candidates[0].holderInstanceId='source';
 f.snapshot.devices.push({...f.snapshot.devices[0],deviceId:workerId,holderInstanceId:'worker'});
 f.snapshot.resources.push({...f.snapshot.resources[0],deviceId:workerId});
 f.snapshot.candidates.push({...f.snapshot.candidates[0],targetId:'remote-target',deviceId:workerId,holderInstanceId:'worker',computeMs:1});
 f.policy.allowedTargetIds.push('remote-target');
 f.request.artifacts[0].replicas=[{deviceId:sourceId,holderInstanceId:'source',readMs:0}];
 f.request.inputRelayId='relay';f.request.networkAllowed=true;f.request.privacy='AUTHORIZED_REMOTE';delete f.request.finalDestination;
 f.snapshot.links=[[sourceId,'relay'],['relay',workerId]].map(([from,to])=>({from,to,bytesPerSecond:1000,fixedMs:2,effective:false,observedAt:100,ttlMs:1000,source:'SIMULATED'}));
 assert.equal(service.plan(f.snapshot,f.request,f.policy,f.clock).decision.suggestion[0].targetId,'target1');
 f.snapshot.candidates[0].computeMs=100;
 assert.equal(service.plan(f.snapshot,f.request,f.policy,f.clock).decision.suggestion[0].targetId,'remote-target');
});

test('explicit target is a planner constraint; qualified alternatives cannot bypass it',()=>{
  const service=new PlanningService(null),f=fixture();f.request.nodes[0].allowedTargetIds=['missing'];
  assert.equal(service.plan(f.snapshot,f.request,f.policy,f.clock).decision.reason,'NO_LEGAL_PLAN');
  f.request.nodes[0].allowedTargetIds=['target1'];
  assert.equal(service.plan(f.snapshot,f.request,f.policy,f.clock).decision.suggestion[0].targetId,'target1');
  f.request.remainingBudgetMs=0;assert.equal(service.plan(f.snapshot,f.request,f.policy,f.clock).decision.reason,'BUDGET_EXHAUSTED');
});
test('database projection is consistent and preflight rejects changed versions and revocation',async()=>{
  fs.mkdirSync(path.resolve('../../.test'),{recursive:true});const data=fs.mkdtempSync(path.resolve('../../.test/planning-'));
  execFileSync(process.execPath,['scripts/migrate.cjs'],{env:{...process.env,COORDINATOR_DATA_DIR:data},stdio:'pipe'});
  const db=new PrismaClient({datasources:{db:{url:'file:'+path.join(data,'coordinator.sqlite').replaceAll('\\','/')}}});
  try{
    const views=new SnapshotBuilder(db,'SIMULATED'),service=new PlanningService(views),f=fixture();
    await views.replace(f.snapshot,f.policy);const built=await views.build('g1');
    const decision=service.plan(built.snapshot,f.request,built.policy,f.clock);
    assert.equal(await service.preflight('g1',decision,f.request,f.clock),true);
    const timed=structuredClone(f.snapshot),candidate=timed.candidates[0],amount={resourcePoolId:'memory',amount:10};
    candidate.resourceDemand=[amount];timed.resources[0].available=10;
    const sample={value:300,source:'PRIOR',unit:'ms',sampledAt:100,ttlMs:1000};
    timed.inFlight=[{deviceId:'d1',holderInstanceId:'h',targetId:'target1',overdue:false,resources:[amount],releaseAt:sample}];
    await views.replace(timed,f.policy);const current=await views.build('g1');
    const original=service.plan(current.snapshot,f.request,f.policy,f.clock),later={...f.clock,now:120};
    assert.equal(original.decision.suggestion[0].startMs,200);
    assert.equal(service.plan(current.snapshot,f.request,f.policy,later).decision.suggestion[0].startMs,180);
    assert.equal(await service.preflight('g1',original,f.request,later),true);
    f.policy.revoked=true;await views.replace(f.snapshot,f.policy);
    assert.equal(await service.preflight('g1',decision,f.request,f.clock),false);
    await assert.rejects(new SnapshotBuilder(db,'REAL').build('g1'),/SNAPSHOT_CORRUPT/);
    await assert.rejects(views.build('unknown'),/GROUP_UNKNOWN/);
  }finally{await db.$disconnect();}
});

test('local result publication stays private only for the authenticated App holder',()=>{
 const service=new PlanningService(null),f=fixture();
 f.request.appInstanceId='app';f.request.localResultHolderId='source';f.request.materializeOutputsAt='relay';f.request.finalDestination='relay';
 f.snapshot.devices[0].holderInstanceId='source';f.snapshot.candidates[0].holderInstanceId='source';f.snapshot.candidates[0].appInstanceId='app';
 assert.equal(service.plan(f.snapshot,f.request,f.policy,f.clock).decision.suggestion[0].executionMs,10);
 f.snapshot.devices[0].holderInstanceId='other';f.snapshot.candidates[0].holderInstanceId='other';
 assert.equal(service.plan(f.snapshot,f.request,f.policy,f.clock).decision.status,'blocked');
});

test('service placement matches the logical service without binding the origin holder',()=>{
 const f=fixture(),service=new PlanningService(null),c=f.snapshot.candidates[0];
 f.request.nodes[0].serviceId='catalog';c.serviceId='catalog';c.appInstanceId='app';c.holderInstanceId='origin';f.snapshot.devices[0].holderInstanceId='origin';
 f.request.appInstanceId='app';f.request.originHolderId='origin';
 assert.equal(service.plan(f.snapshot,f.request,f.policy,f.clock).decision.status,'ready');
 f.request.originHolderId='other';assert.equal(service.plan(f.snapshot,f.request,f.policy,f.clock).decision.status,'ready');
 f.request.originHolderId='origin';c.serviceId='different';assert.equal(service.plan(f.snapshot,f.request,f.policy,f.clock).decision.status,'blocked');
 c.serviceId='catalog';delete c.appInstanceId;delete f.request.appInstanceId;assert.equal(service.plan(f.snapshot,f.request,f.policy,f.clock).decision.status,'ready');
});

test('online slowdown uses a fresh alternate plan and keeps the primary when waiting is faster',async()=>{
 const r=await require('./helpers.cjs').runtime();
 try{
  const f=fixture(),now=Date.now(),id='slow',group='g1',profile={deviceId:'primary',holderInstanceId:'holder',domain:'SIMULATED'};
  f.snapshot.capturedAt=now;f.snapshot.devices[0].sampledAt=now;f.snapshot.resources[0].observedAt=now;f.snapshot.candidates[0].observedAt=now;
  for(const samples of [f.snapshot.devices,f.snapshot.resources,f.snapshot.candidates])samples[0].ttlMs=30000;
  const primary={...f.snapshot.candidates[0],targetId:'primary-target',deviceId:'primary',computeMs:1};
  f.snapshot.candidates.push(primary);f.policy.allowedTargetIds.push(primary.targetId);
  f.snapshot.devices.push({...f.snapshot.devices[0],deviceId:'primary',deviceInstanceId:'primary-instance'});
  f.snapshot.resources.push({...f.snapshot.resources[0],deviceId:'primary'});
  f.request.networkAllowed=true;f.request.privacy='AUTHORIZED_REMOTE';f.request.finalDestination=undefined;
  f.request.artifacts[0].replicas.push({deviceId:'primary',readMs:0});
  await r.snapshots.replace(f.snapshot,f.policy);
  const d={offer:{target:{targetId:'primary-target'},task:{priority:'REMOTE_INTERACTIVE',contract:{sideEffectPolicy:'PURE'}}},
   holderId:'holder',deadlineAt:now+30000,request:f.request};
  await r.db.cpuJob.create({data:{id,groupId:group,principalId:'app',sourceHolderId:'source',state:'DISPATCHED',metadataJson:JSON.stringify(d)}});
  await r.db.attempt.create({data:{id,groupId:group,workflowId:'wf',nodeId:'n',holderInstanceId:'holder',executionDigest:'fixture',taskJson:'{}',state:'RUNNING'}});
  const sample=value=>({value,source:'SIMULATED',unit:'ms',sampledAt:now,ttlMs:30000});
  profile.inFlight=[{attemptId:id,targetId:'primary-target',state:'RUNNING',elapsed:sample(150),remaining:sample(4),
   history:{samples:24,survivors:2,p90TotalMs:100,p90RemainingMs:8}}];
  await r.jobs.assessSlow(group,profile);
  const row=await r.db.attempt.findUniqueOrThrow({where:{id}}),result=JSON.parse(row.recoveryEstimateJson);
  assert.equal(result.reason,'WAIT_FOR_PRIMARY');assert.equal(result.alternativeMs,10);assert.equal(result.remainingMs,4);
  assert.equal(row.state,'RUNNING');assert.equal(result.targetId,'target1');
  await r.db.attempt.update({where:{id},data:{recoveryEstimateJson:null}});
  profile.inFlight[0].remaining.value=80;
  await r.jobs.assessSlow(group,profile);
  const second=await r.db.attempt.findUniqueOrThrow({where:{id}});
  assert.equal(JSON.parse(second.recoveryEstimateJson).reason,'ALTERNATIVE_FASTER');
  assert.equal(await r.db.outbox.count(),0);
 }finally{await r.close();}
});

test('planning resolves fresh matching costs, falls back to calibration and rejects expired evidence',()=>{
 const f=fixture(),c=f.snapshot.candidates[0],node=f.request.nodes[0];
 const ms=value=>({value,unit:'ms',source:'SIMULATED',sampledAt:100,ttlMs:900});
 c.costEvidence={compute:ms(40),cold:ms(5),publish:ms(1)};c.configId='main';c.startup='COLD';node.workKey='work';
 c.computeSamples=[{workKey:'work',configId:'main',startup:'COLD',count:3,p50Ms:12,p90Ms:19,coldP50Ms:3,observedAt:100,ttlMs:300}];
 const run=()=>new PlanningService(null).plan(f.snapshot,f.request,f.policy,f.clock).decision;
 let a=run().suggestion[0];assert.equal(a.costSource,'MEASURED');assert.equal(a.costConfidence,'LOW');assert.equal(a.uncertaintyMs,7);assert.equal(a.phaseCosts.EXECUTE,15);
 c.computeSamples[0].executionTotal=true;assert.equal(run().suggestion[0].phaseCosts.EXECUTE,12,'whole EXECUTE does not pay cold initialization twice');delete c.computeSamples[0].executionTotal;
 c.startup='WARM';assert.equal(run().suggestion[0].costSource,'PRIOR');c.startup='COLD';
 c.configId='other';assert.equal(run().suggestion[0].costSource,'PRIOR');c.configId='main';
 c.computeSamples[0].count=2;assert.equal(run().suggestion[0].costSource,'PRIOR');c.computeSamples[0].count=3;
 node.workKey='other';a=run().suggestion[0];assert.equal(a.costSource,'PRIOR');assert.equal(a.uncertaintyMs,20);
 c.costEvidence.cold.ttlMs=1;f.clock.now=102;assert.equal(run().rejections[0].code,'COST_UNKNOWN');
});

test('capability availability counts live physical devices, not duplicate targets or stale profiles',async()=>{
 const now=Date.now(),candidate=(deviceId,targetId,at=now)=>({deviceId,targetId,capability:'photo.enhance.v1',observedAt:at,ttlMs:10000});
 const planner=new PlanningService({build:async()=>({snapshot:{candidates:[candidate('phone','a'),candidate('phone','b'),candidate('pc','c'),candidate('old','d',now-20000),candidate('future','e',now+20000)]}})});
 assert.deepEqual(await planner.availability('g',['photo.enhance.v1']),[{capability:'photo.enhance.v1',targets:3,services:0,devices:2}]);
});

test('flight and equal-priority queue share one reservation calendar; unknown waits stay scoped to their pools',()=>{
 const f=fixture(),c=f.snapshot.candidates[0],node=f.request.nodes[0];const amount={resourcePoolId:'memory',amount:100};
 const ms=value=>({value,source:value===null?'UNKNOWN':'PRIOR',unit:'ms',sampledAt:100,ttlMs:900});
 Object.assign(c,{resourceDemand:[amount],holderInstanceId:'h',projectedSlots:1,holderCapacity:[amount],availability:{targetId:c.targetId,poolIds:['memory'],reason:'RESOURCE_CAPACITY',snapshotVersion:1,resourceWait:ms(200),policyWait:ms(null)},queueMs:0});
 f.snapshot.devices[0].holderInstanceId='h';f.snapshot.resources[0].available=100;
 f.snapshot.inFlight=[{deviceId:'d1',holderInstanceId:'h',targetId:'target1',resources:[amount],releaseAt:ms(300),overdue:false}];
 const q={deviceId:'d1',holderInstanceId:'h',targetId:'target1',priority:'REMOTE_INTERACTIVE',resources:[amount],attemptId:'q',elapsedMs:1,holdEstimate:ms(300)};f.snapshot.queued=[q];
 const run=()=>new PlanningService(null).plan(f.snapshot,f.request,f.policy,f.clock).decision;
 let a=run().suggestion[0];assert.equal(a.startMs,500);assert.equal(a.dagResourceWaitMs,200);assert.equal(a.policyQueueMs,300);
 q.priority='REMOTE_BATCH';a=run().suggestion[0];assert.equal(a.startMs,200);
 f.request.remainingBudgetMs=150;assert.equal(run().rejections[0].retryAfterMs,200);
 f.request.remainingBudgetMs=1;assert.equal(run().rejections[0].retryAfterMs,undefined);f.request.remainingBudgetMs=1000;
 q.priority='REMOTE_INTERACTIVE';q.holdEstimate=ms(null);assert.equal(run().rejections[0].code,'POLICY_WAIT_UNKNOWN');
 q.resources=[{resourcePoolId:'other',amount:1}];q.targetId='other';assert.equal(run().suggestion[0].startMs,200);
 f.snapshot.inFlight[0].releaseAt=ms(null);assert.equal(run().rejections[0].code,'RESOURCE_WAIT_UNKNOWN');
});

test('choose an occupied RAM target only while its release is usable, then serialize two jobs in the shared pool',()=>{
 const f=fixture(),busy=f.snapshot.candidates[0],ram={resourcePoolId:'memory',amount:100};
 const ms=value=>({value,unit:'ms',source:value===null?'UNKNOWN':'PRIOR',sampledAt:100,ttlMs:1000});
 Object.assign(busy,{computeMs:50,resourceDemand:[ram],requiredMemoryBytes:100,projectedSlots:1,holderInstanceId:'h1',holderCapacity:[ram],
  availability:{targetId:'target1',poolIds:['memory'],reason:'RESOURCE_CAPACITY',snapshotVersion:1,resourceWait:ms(200),policyWait:ms(null)}});
 f.snapshot.devices[0].holderInstanceId='h1';f.snapshot.resources[0].available=100;
 const idle={...busy,targetId:'target2',holderInstanceId:'h2',deviceId:'d2',computeMs:400,availability:undefined};
 f.snapshot.candidates.push(idle);f.policy.allowedTargetIds.push('target2');
 f.snapshot.devices.push({...f.snapshot.devices[0],deviceId:'d2',holderInstanceId:'h2'});f.snapshot.resources.push({...f.snapshot.resources[0],deviceId:'d2'});
 const live={deviceId:'d1',holderInstanceId:'h1',targetId:'target1',resources:[ram],releaseAt:ms(300),overdue:false};f.snapshot.inFlight=[live];
 const first=f.request.nodes[0];first.inputs=[];first.memoryBytes=100;
 f.request.nodes.push({...first,id:'n2',output:{id:'second',bytes:10}});
 Object.assign(f.request,{networkAllowed:true,privacy:'AUTHORIZED_REMOTE',finalDestination:undefined});
 const run=()=>new PlanningService(null).plan(f.snapshot,f.request,f.policy,f.clock).decision;
 const placed=run().suggestion;assert.deepEqual(placed.map(a=>[a.targetId,a.startMs]),[['target1',200],['target1',250]]);
 live.releaseAt=ms(null);assert.deepEqual(run().suggestion.map(a=>a.targetId),['target2','target2']);
 live.releaseAt=ms(300);live.overdue=true;assert.equal(run().rejections.find(r=>r.targetId==='target1').code,'RESOURCE_WAIT_UNKNOWN');
});

test('declared pixel scale corrects calibration prior and sparse same-work feedback overrides it',()=>{
 const f=fixture(),c=f.snapshot.candidates[0],node=f.request.nodes[0],ms=value=>({value,unit:'ms',source:'SIMULATED',sampledAt:100,ttlMs:900});
 node.workKey=JSON.stringify(['neural',2,{model:'pixels',values:{pixels:200},scale:{parameter:'pixels',reference:100}},null]);
 c.costEvidence={compute:ms(40),cold:ms(5),publish:ms(1)};c.configId='main';c.startup='UNKNOWN';
 const run=()=>new PlanningService(null).plan(f.snapshot,f.request,f.policy,f.clock).decision.suggestion[0];
 assert.equal(run().phaseCosts.EXECUTE,85);assert.equal(run().costSource,'PRIOR');
 c.computeSamples=[{workKey:node.workKey,configId:'main',startup:'UNKNOWN',count:1,p50Ms:140,p90Ms:140,coldP50Ms:0,executionTotal:true,observedAt:100,ttlMs:300}];
 assert.equal(run().phaseCosts.EXECUTE,140);assert.equal(run().costSource,'MEASURED');assert.equal(run().costConfidence,'LOW');assert.equal(run().uncertaintyMs,140);
});

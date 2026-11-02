const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {PrismaClient}=require('../generated/client');
const {SnapshotBuilder,PlanningService}=require('../dist/planning');
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

test('one planner chooses origin or remote according to compute plus measured relay cost',()=>{
 const service=new PlanningService(null),f=fixture();
 f.snapshot.devices[0].holderInstanceId='source';f.snapshot.candidates[0].holderInstanceId='source';
 f.snapshot.devices.push({...f.snapshot.devices[0],deviceId:'remote',holderInstanceId:'worker'});
 f.snapshot.resources.push({...f.snapshot.resources[0],deviceId:'remote'});
 f.snapshot.candidates.push({...f.snapshot.candidates[0],targetId:'remote-target',deviceId:'remote',holderInstanceId:'worker',computeMs:1});
 f.policy.allowedTargetIds.push('remote-target');
 f.request.artifacts[0].replicas=[{deviceId:'d1',holderInstanceId:'source',readMs:0}];
 f.request.inputRelayId='relay';f.request.networkAllowed=true;f.request.privacy='AUTHORIZED_REMOTE';delete f.request.finalDestination;
 f.snapshot.links=[['d1','relay'],['relay','remote']].map(([from,to])=>({from,to,bytesPerSecond:1000,fixedMs:2,effective:false,observedAt:100,ttlMs:1000,source:'SIMULATED'}));
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

test('fixed service placement requires the registered origin App holder and matching logical service',()=>{
 const f=fixture(),service=new PlanningService(null),c=f.snapshot.candidates[0];
 f.request.nodes[0].serviceId='catalog';c.serviceId='catalog';c.appInstanceId='app';c.holderInstanceId='origin';f.snapshot.devices[0].holderInstanceId='origin';
 f.request.appInstanceId='app';f.request.originHolderId='origin';
 assert.equal(service.plan(f.snapshot,f.request,f.policy,f.clock).decision.status,'ready');
 f.request.originHolderId='other';assert.equal(service.plan(f.snapshot,f.request,f.policy,f.clock).decision.status,'blocked');
 f.request.originHolderId='origin';c.serviceId='different';assert.equal(service.plan(f.snapshot,f.request,f.policy,f.clock).decision.status,'blocked');
 c.serviceId='catalog';delete c.appInstanceId;delete f.request.appInstanceId;assert.equal(service.plan(f.snapshot,f.request,f.policy,f.clock).decision.status,'blocked');
});

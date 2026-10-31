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

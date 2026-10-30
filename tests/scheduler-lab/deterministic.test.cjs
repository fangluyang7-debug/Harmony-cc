const {test}=require('node:test'),assert=require('node:assert/strict');
const core=require('@harmony/scheduler-core');
const load=name=>structuredClone(require('../../contracts/scheduling/v2/fixtures/t2/valid/'+name+'.json'));
function scenario(seed){
 let tick=0,random=seed>>>0;const events=[];
 const next=()=>{random=(Math.imul(random,1664525)+1013904223)>>>0;return random;};
 const grant=load('AllotmentGrant');grant.extra=[{resourcePoolId:'cpu1',amount:1},{resourcePoolId:'gpu1',amount:1},{resourcePoolId:'memory1',amount:100}];
 let state=core.newLedgerV2({groupId:'g1',deviceId:'device1',holderInstanceId:'h1',appInstanceId:null});state=core.requestGrantV2(state,grant.leaseRequestId,tick);state=core.installGrantV2(state,grant,true,tick);
 const queue=new core.MicroQueue('device1',{shares:[.5,.3,.2],agingMs:100,maxConsecutive:2,yieldDeadlineMs:1000});
 const offered=[];
 for(let i=0;i<24;i++){
  const offer=load('DispatchOffer'),gpu=i%2===0;offer.task.attemptId='job'+i;offer.task.app.appInstanceId='app'+i%3;offer.task.priority=['ORIGIN_INTERACTIVE','REMOTE_INTERACTIVE','REMOTE_BATCH'][i%3];
  offer.task.budget={remainingMs:10000,deadlineAt:10000};offer.target.targetId=gpu?'gpu':'cpu';offer.task.allowedTargetIds=[offer.target.targetId];offer.target.backend=gpu?'CUDA':'CPU';
  offer.target.resourcePoolIds=['memory1',gpu?'gpu1':'cpu1'];offer.resources=[{resourcePoolId:'memory1',amount:60},{resourcePoolId:gpu?'gpu1':'cpu1',amount:1}];
  queue.enqueue(offer,tick);offered.push(offer);
 }
 const completed=new Set(),started=new Set();
 while(completed.size<offered.length){
  const offer=queue.choose(grant.extra,core.occupiedV2(state),tick,true);assert.ok(offer);
  const context={now:tick,coordinatorEpoch:1,online:true,ownerIdle:true,admissionLimit:grant.extra,executionDigest:'a'.repeat(64),leaseId:'lease'+completed.size};
  const entry=core.admitV2(state,offer,context);state=entry.state;queue.start(offer.task.attemptId,tick);state=core.startAttemptV2(state,offer.task.attemptId,tick);
  assert.equal(started.has(offer.task.attemptId),false);started.add(offer.task.attemptId);events.push({tick,type:'START',attempt:offer.task.attemptId,app:offer.task.app.appInstanceId,backendLabel:offer.target.backend,domain:'SIMULATED'});
  assert.ok(core.vectorFitsV2(core.occupiedV2(state),grant.extra));assert.equal(queue.choose(grant.extra,core.occupiedV2(state),tick,true),null); // Shared RAM blocks otherwise independent CPU/GPU slots.
  if(next()%3===0){const before=core.occupiedV2(state);state=core.cancelAttemptV2(state,offer.task.attemptId);assert.deepEqual(core.occupiedV2(state),before);events.push({tick,type:'CANCEL_INTENT',attempt:offer.task.attemptId});}
  tick+=1+next()%15;
  const receipt={attemptId:offer.task.attemptId,coordinatorEpoch:1,planRevision:1,fence:entry.entry.record.fence,state:'SUCCEEDED',resourcesSettled:true,outputs:[],actualTarget:offer.target,actualConfiguration:'default',errorCode:null};
  assert.throws(()=>core.settleAttemptV2(state,{...receipt,fence:{...receipt.fence,counter:receipt.fence.counter+1}}),/MISMATCH/);
  state=core.settleAttemptV2(state,receipt);queue.settle(offer.task.attemptId,tick);assert.deepEqual(core.occupiedV2(state),[]);
  assert.equal(core.admitV2(state,offer,context).existing,true);completed.add(offer.task.attemptId);events.push({tick,type:'SETTLED',attempt:offer.task.attemptId});
 }
 assert.deepEqual([...new Set(events.filter(e=>e.type==='START').map(e=>e.app))].sort(),['app0','app1','app2']);
 assert.equal(started.size,24);return events;
}
test('virtual-clock seeded resource/fairness/fence/cancel/at-most-once traces replay exactly',()=>{
 for(const seed of [1,7,42,20261030])assert.deepEqual(scenario(seed),scenario(seed));
 assert.notDeepEqual(scenario(1),scenario(7));
});
test('missing dependency, wrong group, offline agent and unknown owner fail before creating any reservation',()=>{
 const offer=load('DispatchOffer'),grant=load('AllotmentGrant');let state=core.newLedgerV2({groupId:'g1',deviceId:'device1',holderInstanceId:'h1',appInstanceId:null});state=core.requestGrantV2(state,grant.leaseRequestId,0);state=core.installGrantV2(state,grant,true,0);
 const context={now:1,coordinatorEpoch:1,online:true,ownerIdle:true,admissionLimit:grant.extra,executionDigest:'a'.repeat(64),leaseId:'lease1'};
 const dependent=structuredClone(offer);dependent.dependencies=[{nodeId:'before',planRevision:1,committed:false}];assert.throws(()=>core.admitV2(state,dependent,context),/DEPENDENCY/);
 const foreign=structuredClone(offer);foreign.task.groupId='another';foreign.task.app.groupId='another';assert.throws(()=>core.admitV2(state,foreign,context),/UNAUTHORIZED/);
 assert.throws(()=>core.admitV2(state,offer,{...context,online:false}),/OFFLINE/);assert.throws(()=>core.admitV2(state,offer,{...context,ownerIdle:false}),/OWNER/);assert.deepEqual(core.occupiedV2(state),[]);
});

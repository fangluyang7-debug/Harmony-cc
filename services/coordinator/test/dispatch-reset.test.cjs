const {test}=require('node:test'),assert=require('node:assert/strict');
const {CpuJobs}=require('../dist/cpu-jobs');
for(const evidence of ['attempt','dispatch-outbox','obsolete-outbox','recovery-outbox','none']){
 test(`dispatch reset preserves ${evidence}`,async()=>{
  let state='DISPATCHING',inside=false,updates=0;
  const tx={attempt:{findUnique:async()=>{assert.ok(inside);return evidence==='attempt'?{id:'job'}:null;}},
   outbox:{count:async args=>{assert.ok(inside);assert.deepEqual(args,{where:{attemptId:'job'}});return evidence.endsWith('outbox')?1:0;}},
   cpuJob:{updateMany:async args=>{assert.ok(inside);assert.equal(args.where.state,state);updates++;state=args.data.state;return {count:1};}}};
  const jobs=Object.create(CpuJobs.prototype);jobs.db={$transaction:async fn=>{inside=true;try{return await fn(tx);}finally{inside=false;}}};
  assert.equal(await jobs.resetUndispatched('job'),evidence==='none');
  assert.equal(state,evidence==='none'?'WAITING_INPUT':'DISPATCHING');assert.equal(updates,evidence==='none'?1:0);
 });
}

test('graph dispatch defers unavailable resources without occupying the cursor with retry sleeps',async()=>{
 const jobs=Object.create(CpuJobs.prototype);let choices=0;
 const data={deadlineAt:Date.now()+10000,request:{artifacts:[],remainingBudgetMs:10000},input:{ref:{artifactId:'input'}},offer:{task:{app:{appInstanceId:'app'}}}};
 jobs.owned=async()=>data;jobs.db={cpuJob:{findUniqueOrThrow:async()=>({state:'WAITING_INPUT'})},attempt:{findUnique:async()=>null},outbox:{count:async()=>0}};
 jobs.inputReady=async()=>true;jobs.artifacts={available:()=>false};jobs.refreshCopies=async()=>{};jobs.remainingTail=async()=>0;
 jobs.choose=async()=>{choices++;throw Error('ALLOTMENT_UNAVAILABLE');};
 await assert.rejects(jobs.startAttempt({holderInstanceId:'h'},'job',0,{jobId:'job',until:Date.now()+2500,waitForResources:false}),/ALLOTMENT_UNAVAILABLE/);
 assert.equal(choices,1,'one attempt, then the workflow yields until resource evidence changes');
});

test('graph dispatch does not wait for an unacknowledged allotment',async()=>{
 const jobs=Object.create(CpuJobs.prototype);let unwatched=0;
 jobs.owned=async()=>({deadlineAt:Date.now()+10000});jobs.db={cpuJob:{findUniqueOrThrow:async()=>({state:'WAITING_INPUT'})}};jobs.epoch=()=>1;
 jobs.allotments={watch:()=>()=>{unwatched++;},reservations:async()=>[{grant:{groupId:'g',holderInstanceId:'h',coordinatorEpoch:1,version:2},ack:{version:1}}]};
 await assert.rejects(jobs.confirmedGrant({groupId:'g'},'d','h',{jobId:'job',until:Date.now()+2500,waitForResources:false}),/ALLOTMENT_ACK_PENDING/);
 assert.equal(unwatched,1);
});

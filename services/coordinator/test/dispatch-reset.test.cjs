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

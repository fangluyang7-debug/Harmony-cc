const {test}=require('node:test'),assert=require('node:assert/strict');
const {TeamSpaces}=require('../dist/spaces');
const {runtime}=require('./helpers.cjs');

test('space task window keeps the newest 100 jobs rather than the first 100 IDs',async()=>{
  const rows=Array.from({length:101},(_,i)=>({id:String(i).padStart(3,'0'),principalId:'owner',state:'SUCCEEDED',metadataJson:JSON.stringify({request:{now:i},offer:{target:{deviceId:'pc'},task:{contract:{capability:'text.count.v1'}},reasonCode:'USER_TARGET'}})}));
  rows.push({ ...rows[0],id:'unknown',metadataJson:JSON.stringify({offer:JSON.parse(rows[0].metadataJson).offer})});
  const r=await runtime();try{
  for(const row of rows)await r.db.cpuJob.create({data:{...row,groupId:"space",sourceHolderId:"holder"}});
  let attemptQuery;
  const context={
    member:async()=>({role:'OWNER'}),config:{domain:'SIMULATED'},status:()=>({ready:true,epoch:1}),
    directory:{profiles:async()=>[]},snapshots:{build:async()=>{throw Error('NOT_READY');}},
    db:{teamSpace:{findUniqueOrThrow:async()=>({id:'space'})},spaceMember:{findMany:async()=>[]},spaceUser:{findMany:async()=>[]},spaceDevice:{findMany:async()=>[]},capabilityState:{findMany:async()=>[]},attempt:{findMany:async args=>{attemptQuery=args;return [];}},$queryRaw:r.db.$queryRaw.bind(r.db)}
  };
  const result=await TeamSpaces.prototype.dashboard.call(context,'owner','space');
  assert.equal(attemptQuery.where.groupId,'space');
  assert.equal(attemptQuery.where.id.in.length,100);
  assert.ok(!attemptQuery.where.id.in.includes('unknown'));
  assert.equal(result.jobs.length,100);
  assert.equal(result.jobs[0].id,'100');
  assert.equal(result.jobs[99].id,'001');
  assert.ok(result.jobs.every((job,i)=>job.createdAt===100-i));
  assert.ok(result.jobs.every(job=>job.reason==='USER_TARGET'));
  const {recentJobs,traceJobs,traceRows}=require('../dist/dashboard-history');
  assert.equal((await recentJobs(r.db,"space' OR 1=1 --")).length,0);
  await r.db.traceSpan.create({data:{id:'legacy-noncanonical-id',groupId:'space',revision:1,metadataJson:JSON.stringify({span:{traceId:'wanted'}})}});
  await r.db.traceSpan.create({data:{id:'other-group',groupId:'other',revision:1,metadataJson:JSON.stringify({span:{traceId:'wanted'}})}});
  assert.deepEqual((await traceRows(r.db,'space','wanted')).map(r=>r.id),['legacy-noncanonical-id']);
  assert.equal((await traceRows(r.db,'space','absent')).length,0);
  await r.db.cpuJob.update({where:{id:'100'},data:{metadataJson:JSON.stringify({traceId:'wanted'})}});
  assert.deepEqual((await traceJobs(r.db,'space','wanted')).map(r=>r.id),['100']);
  }finally{await r.close();}
});

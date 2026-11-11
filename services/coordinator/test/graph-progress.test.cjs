const {test}=require('node:test'),assert=require('node:assert/strict');
const {runtime}=require('./helpers.cjs'),{CpuJobs}=require('../dist/cpu-jobs');

test('frontier uses one statement snapshot and preserves commit, backup, queue and ownership gates',async()=>{
 const r=await runtime();
 try{
  const peer={groupId:'g',principalId:'p',holderInstanceId:'h'},jobs=Object.create(CpuJobs.prototype);let reads=0;
  Object.assign(jobs,{db:{$queryRaw:async(...args)=>{reads++;return r.db.$queryRaw(...args);}},apps:{context:async()=>{}},artifacts:{available:()=>true},localOutput:()=>false});
  async function seed(id,state='RUNNING',extra={}){
   const output={ref:{contentHash:id},bytes:1},data={offer:{task:{workflowId:'wf',nodeId:id,app:{appInstanceId:'app'}}},output};
   await r.db.cpuJob.create({data:{id,groupId:'g',principalId:'p',sourceHolderId:'h',state:'DISPATCHED',metadataJson:JSON.stringify(data)}});
   await r.db.node.create({data:{id:JSON.stringify(['wf',id]),workflowId:'wf',currentAttemptId:id,primaryAttemptId:id,state:state==='SUCCEEDED'?'COMMITTED':'ACTIVE',...extra}});
   await r.db.attempt.create({data:{id,groupId:'g',workflowId:'wf',nodeId:id,executionDigest:'digest',state,holderInstanceId:'h',taskJson:'{}'}});
   if(state==='SUCCEEDED')await r.db.receipt.create({data:{id,attemptId:id,committed:true,recordJson:JSON.stringify({state,outputs:[output.ref]})}});
  }
  for(let i=0;i<16;i++)await seed('j'+i,i===0?'SUCCEEDED':'RUNNING');
  const ids=Array.from({length:16},(_,i)=>'j'+i),all=await jobs.graphProgress(peer,ids);
  assert.equal(reads,1,'sixteen active nodes share one SQL read');assert.equal(all.length,16);
  assert.equal(all.filter(x=>x.output).length,1);assert.equal(all.find(x=>x.id==='j0').output.descriptor.ref.contentHash,'j0');
  await r.db.receipt.update({where:{id:'j0'},data:{committed:false}});
  assert.equal((await jobs.graphProgress(peer,['j0']))[0].output,null);
  await r.db.receipt.update({where:{id:'j0'},data:{committed:true,recordJson:JSON.stringify({state:'SUCCEEDED',outputs:[{contentHash:'wrong'}]})}});
  assert.equal((await jobs.graphProgress(peer,['j0']))[0].output,null,'matching receipt bytes remain mandatory');
  await seed('backup','SUCCEEDED');
  await r.db.node.update({where:{id:JSON.stringify(['wf','j1'])},data:{backupAttemptId:'backup',winnerAttemptId:'backup',currentAttemptId:'backup',state:'COMMITTED'}});
  const winner=(await jobs.graphProgress(peer,['j1']))[0];assert.equal(winner.serving,'backup');assert.ok(winner.output);
  await r.db.node.update({where:{id:JSON.stringify(['wf','j1'])},data:{winnerAttemptId:null,state:'ACTIVE'}});
  assert.equal((await jobs.graphProgress(peer,['j1']))[0].serving,'j1','running primary stays primary until a winner is committed');
  await r.db.attempt.update({where:{id:'j1'},data:{state:'FAILED'}});
  assert.equal((await jobs.graphProgress(peer,['j1']))[0].serving,'backup');
  await r.db.attempt.delete({where:{id:'j2'}});
  await r.db.batchReadyJob.create({data:{id:'j2',groupId:'g',appId:'app',peerJson:'{}',queuedAt:Date.now(),deadlineAt:Date.now()+10000,reason:'CAPACITY'}});
  assert.equal((await jobs.graphProgress(peer,['j2']))[0].state,'QUEUED');
  await r.db.cpuJob.update({where:{id:'j2'},data:{state:'CANCELLED'}});
  assert.equal((await jobs.graphProgress(peer,['j2']))[0].state,'CANCELLED','stale queue entry must not resurrect a cancelled task');
  await assert.rejects(jobs.graphProgress({...peer,holderInstanceId:'other'},['j0']),/JOB_SCOPE/);
  await assert.rejects(jobs.graphProgress(peer,['missing']),/JOB_SCOPE/);
  await assert.rejects(jobs.graphProgress(peer,['j0','j0']),/GRAPH_FRONTIER_INVALID/);
  await r.db.cpuJob.update({where:{id:'backup'},data:{groupId:'other'}});
  await assert.rejects(jobs.graphProgress(peer,['j1']),/JOB_SCOPE/);
  const before=reads;assert.deepEqual(await jobs.graphProgress(peer,[]),[]);assert.equal(reads,before);
 }finally{await r.close();}
});

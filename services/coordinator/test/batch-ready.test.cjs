const {test}=require('node:test'),assert=require('node:assert/strict');
const {runtime}=require('./helpers.cjs'),{BatchReadyQueue}=require('../dist/batch-ready');

test('a waiting grant in another team cannot stall an eligible interaction behind a readable batch backlog',async()=>{
 const r=await runtime(),now=Date.now(),calls=[];let queue,release,finish,enter;
 const busy=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>enter=resolve);
 const interaction=new Promise(resolve=>finish=resolve);
 async function stage(id,groupId,priority){
  const appId=id=== 'interactive'?'search':'indexer';
  await r.db.cpuJob.create({data:{id,groupId,principalId:appId,sourceHolderId:appId,state:'WAITING_INPUT',metadataJson:'{}'}});
  await r.db.batchReadyJob.create({data:{id,groupId,appId,priority,peerJson:'{}',queuedAt:now,deadlineAt:now+30000,reason:'READY'}});
 }
 try{
  await stage('foreign','other','REMOTE_BATCH');
  queue=new BatchReadyQueue(r.db,async(_,id)=>{
   if(id==='foreign'){enter();await busy;return;}
   calls.push(id);if(id==='interactive')finish();
  });
  await queue.restore();await entered;
  await stage('local-batch','local','REMOTE_BATCH');await stage('interactive','local','REMOTE_INTERACTIVE');
  const start=performance.now();await queue.restore();
  let timer;
  try{await Promise.race([interaction,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('ELIGIBLE_INTERACTION_STALLED')),2500);})]);}
  finally{clearTimeout(timer);}
  assert.ok(performance.now()-start<2500);assert.equal(calls[0],'interactive');
 }finally{release();await queue?.close();await r.close();}
});

test('restored batch queue rotates apps, waits for credit events and expires a blocked tail independently',async()=>{
 const r=await runtime(),calls=[];let queue,credit=false;
 const until=async check=>{const end=Date.now()+8000;while(!await check()){if(Date.now()>end)assert.fail('batch queue timeout');await new Promise(resolve=>setTimeout(resolve,20));}};
 try{
  const now=Date.now();
  for(const [id,appId,offset] of [['a1','a',0],['a2','a',1],['b1','b',2],['late','a',3]]){
   await r.db.cpuJob.create({data:{id,groupId:'space',principalId:appId,sourceHolderId:appId,state:'WAITING_INPUT',metadataJson:'{}'}});
   await r.db.batchReadyJob.create({data:{id,appId,groupId:'space',peerJson:JSON.stringify({groupId:'space'}),queuedAt:now+offset,deadlineAt:now+(id==='late'?500:60000),reason:'READY'}});
  }
  queue=new BatchReadyQueue(r.db,async(_peer,id)=>{
   calls.push(id);
   if(!credit)throw Error('ALLOTMENT_UNAVAILABLE');
   await r.db.cpuJob.update({where:{id},data:{state:'DISPATCHED'}});
  });
  await queue.restore();
  await until(async()=>(await r.db.cpuJob.findUniqueOrThrow({where:{id:'late'}})).state==='BUDGET_EXHAUSTED');
  assert.ok(!calls.includes('late'));
  assert.equal((await r.db.batchReadyJob.findUniqueOrThrow({where:{id:'a1'}})).reason,'ALLOTMENT_UNAVAILABLE');
  await queue.close();credit=true;calls.length=0;
  queue=new BatchReadyQueue(r.db,async(_peer,id)=>{calls.push(id);await r.db.cpuJob.update({where:{id},data:{state:'DISPATCHED'}});});
  await queue.restore();await until(async()=>await r.db.batchReadyJob.count()===0);
  assert.deepEqual(calls,['a1','b1','a2']);
 }finally{await queue?.close();await r.close();}
});

test('weighted resource time orders competing apps and measured settlement corrects an estimate once',async()=>{
 const {chargeBatch,settleBatchCharge}=require('../dist/batch-ready'),r=await runtime(),calls=[];
 let queue;
 try{
  const resources=[{resourcePoolId:'cpu',amount:1}],group='weighted',at=Date.now();
  await r.db.device.create({data:{id:JSON.stringify(['budget','worker']),groupId:group,revision:1,metadataJson:JSON.stringify({capacity:resources})}});
  for(const [app,weight] of [['a',1],['b',2]]){
   await r.db.registeredApp.create({data:{id:app,groupId:group,label:app,principalId:app,maxConcurrent:4,contractsJson:'[]',resourcesJson:JSON.stringify(resources),batchWeight:weight}});
   for(let i=1;i<=4;i++){
    const id=app+i;
    await r.db.cpuJob.create({data:{id,groupId:group,principalId:app,sourceHolderId:app,state:'WAITING_INPUT',metadataJson:'{}'}});
    await r.db.batchReadyJob.create({data:{id,groupId:group,appId:app,queuedAt:at+i,deadlineAt:at+30000,reason:'READY',peerJson:JSON.stringify({appId:app})}});
   }
  }
  queue=new BatchReadyQueue(r.db,async(peer,id)=>{
   await r.db.$transaction(tx=>chargeBatch(tx,id,peer.appId,'worker',resources,10));
   calls.push(id);
  });
  await queue.restore();
  const deadline=Date.now()+8000;
  while(await r.db.batchReadyJob.count()){if(Date.now()>deadline)assert.fail('queue stalled');await new Promise(resolve=>setTimeout(resolve,20));}
  assert.deepEqual(calls.slice(0,6),['a1','b1','b2','a2','b3','b4']);
  const settle=()=>r.db.$transaction(tx=>settleBatchCharge(tx,'b1',6));
  await settle();await settle();
  assert.equal((await r.db.registeredApp.findUniqueOrThrow({where:{id:'b'}})).batchService,18);
 }finally{await queue?.close();await r.close();}
});

test('under contention, ready interactive and batch jobs in the same app both receive dispatch turns',async()=>{
 const r=await runtime(),group='mixed',calls=[];let queue;
 try{
  const now=Date.now();
  for(const [prefix,priority] of [['batch','REMOTE_BATCH'],['interactive','REMOTE_INTERACTIVE']]){
   for(let i=0;i<3;i++){
    const id=prefix+i;
    await r.db.cpuJob.create({data:{id,groupId:group,principalId:'owner',sourceHolderId:'source',state:'WAITING_INPUT',metadataJson:'{}'}});
    await r.db.batchReadyJob.create({data:{id,groupId:group,priority,appId:'same',peerJson:'{}',queuedAt:now+i,deadlineAt:now+30000,reason:'READY'}});
   }
  }
  queue=new BatchReadyQueue(r.db,async(_peer,id)=>{calls.push(id);});
  await queue.restore();
  const deadline=Date.now()+8000;
  while(await r.db.batchReadyJob.count()){if(Date.now()>deadline)assert.fail('mixed queue stalled');await new Promise(resolve=>setTimeout(resolve,20));}
  assert.deepEqual(calls,['interactive0','batch0','interactive1','batch1','interactive2','batch2']);
 }finally{await queue?.close();await r.close();}
});

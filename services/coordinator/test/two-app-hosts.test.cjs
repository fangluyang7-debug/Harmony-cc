const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {runtime}=require('./helpers.cjs');
const interactiveWaitLimitMs=5000; // Controlled two-slot fixture policy, measured from submission to admitted input read.
const {CpuHost}=require('../../pc-agent/dist/host'),{DurableLedger}=require('../../pc-agent/dist/durable-ledger');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check){const end=Date.now()+45000;while(Date.now()<end){if(await check())return;await sleep(100);}throw Error('TWO_APP_TIMEOUT');}
test('two independent App hosts share one physical budget without cross-App execution or result access',async()=>{
 const errors=[],r=await runtime({cpuHost:true,onError:error=>errors.push('server:'+error.code+':'+String(error))}),hosts=[],gates=[];
 try{
  const group=randomUUID(),device=randomUUID(),ownerHolder=randomUUID(),unit=[{resourcePoolId:'cpu',amount:1},{resourcePoolId:'ram',amount:134217728}],capacity=unit.map(x=>({...x,amount:x.amount*2}));
  const invite=await r.auth.invite(group,randomUUID(),device,r.url),owner=await r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:ownerHolder});
  await r.allotments.confirmDevice(device,capacity,[{groupId:group,holderInstanceId:ownerHolder,appInstanceId:null}]);
  for(const label of ['SoleAI fixture','Indexer fixture']){
   const invitation=await r.apps.register(owner.peer,{label,allowedContracts:['text.count.v1'],maxConcurrent:1,resources:unit,offlineBase:unit,onlineExtra:[]},r.url),registered=await r.apps.exchange({registrationId:invitation.registrationId,code:invitation.code});
   const identity={groupId:group,deviceId:device,holderInstanceId:registered.peer.holderInstanceId,appInstanceId:registered.peer.app.appInstanceId},directory=path.join(r.config.dataDir,identity.appInstanceId);
   const ledger=await DurableLedger.open(directory,identity,invite.certificate);await ledger.close();
   const host=await CpuHost.open({directory,identity,connection:{address:r.url,certificate:invite.certificate,fingerprint:invite.fingerprint,credential:registered.credential,domain:'SIMULATED'},controlIntervalMs:500,contribution:{ownerMode:'dedicated',maxCpuThreads:1,maxMemoryBytes:134217728,reserveMemoryBytes:0}},e=>errors.push(String(e)));
   hosts.push(host);host.start();
  }
  await until(async()=>{try{return (await r.snapshots.build(group)).snapshot.candidates.length===2;}catch{return false;}});
  await assert.rejects(r.apps.register(owner.peer,{label:'Overbooked',allowedContracts:['text.count.v1'],maxConcurrent:1,resources:unit,offlineBase:unit,onlineExtra:[]},r.url),/APP_BASE_BUDGET_UNAVAILABLE/);
  for(let repetition=0;repetition<5;repetition++){
  const tasks=[];
  for(const i of [1,0]){
   const host=hosts[i];
   const sdk=host.sdk(),input=await sdk.registerInput(Buffer.from(JSON.stringify({text:i===0?'SoleAI':'Indexer'})),'text.input');
   const runtime=host.agent.runtime,read=runtime.ports.read,publish=runtime.ports.publish;runtime.ports.publish=async(...args)=>{try{return await publish(...args);}catch(error){errors.push('publish:'+String(error));throw error;}};let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);gates.push(release);
   runtime.ports.read=async(...args)=>{entered();await gate;try{return await read(...args);}catch(error){errors.push('read:'+String(error));throw error;}};
   const id=randomUUID(),start=performance.now(),task=await sdk.submit({version:3,id,outputContract:'text.counts',qualityTarget:'reference',nodes:[{id:'compute',capability:'text.count.v1',input,parameters:'{}',dependsOn:[]}]},{requestId:id,budgetMs:30000,resultDestination:'ORIGIN',inputLocation:'ORIGIN',priority:i===1?'REMOTE_BATCH':'REMOTE_INTERACTIVE'});
   await started;tasks[i]=task;
   if(i===0){
    const waitMs=performance.now()-start;
    assert.equal(hosts[1].ledger.status(tasks[1].id).resourcesSettled,false);
    assert.ok(waitMs<=interactiveWaitLimitMs,'eligible interactive wait '+waitMs+' ms exceeded '+interactiveWaitLimitMs);
    console.log('INTERACTIVE_ADMITTED_MS '+waitMs.toFixed(1));
   }else{
    const readyWait=(await task.status()).readyWait;
    assert.equal(readyWait.priority,'REMOTE_BATCH');assert.equal(readyWait.outcome,'OFFERED');assert.ok(readyWait.waitMs>=0);
   }
  }
  for(let i=0;i<2;i++){
   const state=hosts[i].ledger.snapshot(),entry=state.entries.find(e=>e.record.attemptId===tasks[i].id);
   assert.ok(entry);assert.equal(entry.record.resourcesSettled,false);assert.equal(state.grant.appInstanceId,hosts[i].identity?.appInstanceId??state.appInstanceId);
   await assert.rejects(hosts[1-i].sdk().resume(tasks[i].id).status(),/SCOPE|NOT_FOUND|FORBIDDEN/);
  }
  assert.equal(hosts.reduce((n,h)=>n+h.ledger.snapshot().grant.base.find(r=>r.resourcePoolId==='cpu').amount,0),2);
  gates.forEach(release=>release());
  for(let i=0;i<2;i++){
   const result=await tasks[i].result();assert.equal(JSON.parse(Buffer.from(result.output)).characters,i===0?6:7);
   const job=await r.db.cpuJob.findUnique({where:{id:tasks[i].id}}),data=JSON.parse(job.metadataJson);
   assert.equal(data.holderId,hosts[i].ledger.snapshot().grant.holderInstanceId);assert.equal(r.artifacts.available(data.output),false);
   assert.equal((await r.db.receipt.findUnique({where:{id:tasks[i].id}})).committed,true);
  }
  }
 }catch(error){console.error(JSON.stringify({errors,jobs:await r.db.cpuJob.findMany({select:{id:true,state:true}})},null,2));throw error;}finally{gates.forEach(release=>release());for(const h of hosts)await h.close();await r.close();}
});

const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {runtime}=require('./helpers.cjs');
const {CpuHost}=require('../../pc-agent/dist/host'),{DurableLedger}=require('../../pc-agent/dist/durable-ledger');
const {SchedulerSdk}=require('@harmony/scheduler-client'),{nodeSdkPort}=require('@harmony/scheduler-client/dist/node');
const {builtinCpuPacks}=require('@harmony/reference-capabilities');
test('SIMULATED shopping partitions use three real CPU hosts through SDK and planner, settle once and merge exactly',async()=>{
 const pack=builtinCpuPacks().find(p=>p.manifest.packId==='catalog.filter.v1');
 const r=await runtime({cpuHost:true,referencePacks:[pack]}),hosts=[],errors=[];
 const group=randomUUID(),capacity=[{resourcePoolId:'cpu',amount:1},{resourcePoolId:'ram',amount:268435456}];
 try{
  const peers=[];
  for(let i=0;i<3;i++){
   const holder=randomUUID(),device=randomUUID(),invite=await r.auth.invite(group,randomUUID(),device,r.url);
   const owner=await r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:holder});
   await r.allotments.confirmDevice(device,capacity,[{groupId:group,holderInstanceId:holder,appInstanceId:null}]);
   const identity={groupId:group,deviceId:device,holderInstanceId:holder,appInstanceId:null};
   const directory=path.join(r.config.dataDir,'shopping-host-'+i),ledger=await DurableLedger.open(directory,identity,invite.certificate);await ledger.close();
   const connection={address:r.url,certificate:invite.certificate,fingerprint:invite.fingerprint,credential:owner.credential,domain:'SIMULATED'};
   const host=await CpuHost.open({directory,identity,connection,controlIntervalMs:200,contribution:{ownerMode:'dedicated',maxCpuThreads:1,maxMemoryBytes:268435456,reserveMemoryBytes:0}},e=>errors.push(String(e)));
   hosts.push(host);peers.push({owner,connection});host.start();
  }
  let targets=[];for(const until=Date.now()+90000;Date.now()<until;){
   try{targets=(await r.snapshots.build(group)).snapshot.candidates.filter(c=>c.capability==='catalog.filter.v1');}catch{}
   if(targets.length===3)break;await new Promise(resolve=>setTimeout(resolve,250));
  }
  assert.equal(targets.length,3,JSON.stringify(errors));
  const invitation=await r.apps.register(peers[0].owner.peer,{label:'SIMULATED shopping UI',allowedContracts:['catalog.filter.v1'],maxConcurrent:3,resources:capacity.map(r=>({...r,amount:r.amount*3})),offlineBase:[],onlineExtra:[]},r.url);
  const app=await r.apps.exchange({registrationId:invitation.registrationId,code:invitation.code});
  const sdk=new SchedulerSdk(nodeSdkPort({...peers[0].connection,credential:app.credential}));
  const {candidatesFrom,partitionCandidates,mergePartitions}=await import('../../../apps/team-space-web/shopping-runtime.mjs');
  const candidates=candidatesFrom({runtimeRunId:'run_SIMULATED',candidates:{items:Array.from({length:30},(_,i)=>({candidateItemId:'fixture-'+i,title:'SIMULATED item '+i,price:{amount:([499,500,500.01,399,100.1][i%5]).toFixed(2),currency:i===0?'USD':'CNY'}}))}});
  const parts=partitionCandidates(candidates,3,50000),jobs=[];
  const results=await Promise.all(parts.map(async(part,index)=>{
   const input=await sdk.registerInput(Buffer.from(JSON.stringify(part)),'catalog.items'),id=randomUUID();jobs.push(id);
   try{
    const task=await sdk.submit({version:3,id,outputContract:'catalog.ranked',qualityTarget:'reference',nodes:[{id:'filter',capability:'catalog.filter.v1',input,parameters:'{}',dependsOn:[],targetId:targets[index].targetId}]},{requestId:id,budgetMs:30000,resultDestination:'ORIGIN'});
    const result=await task.result();assert.equal(result.status.deviceId,targets[index].deviceId);assert.ok(result.status.traceId);
    // Verified results are acknowledged and relay bytes released. Resume metadata,
    // retaining the client result, rather than asking for deleted output again.
    const resumed=await sdk.resume(id).status();assert.equal(resumed.state,'SUCCEEDED');
    assert.equal(await r.db.attempt.count({where:{id}}),1);assert.equal((await r.db.receipt.findUniqueOrThrow({where:{id}})).committed,true);
    return JSON.parse(Buffer.from(result.output));
   }finally{sdk.releaseInput(input);}
  }));
  const merged=mergePartitions(candidates,results,50000);
  const expected=candidates.filter(p=>p.price.currency==='CNY'&&Number(p.price.amount)<=500).sort((a,b)=>Number(a.price.amount)-Number(b.price.amount)||a.rank-b.rank);
  assert.deepEqual(merged.items.map(p=>p.candidateItemId),expected.map(p=>p.candidateItemId));assert.equal(merged.scanned,30);
  for(const until=Date.now()+10000;Date.now()<until;){if(jobs.every(id=>hosts.some(h=>h.ledger.status(id)?.resourcesSettled)))break;await new Promise(resolve=>setTimeout(resolve,100));}
  for(const id of jobs){const statuses=hosts.map(h=>h.ledger.status(id)).filter(Boolean);assert.equal(statuses.length,1);assert.equal(statuses[0].resourcesSettled,true);}
 }finally{await Promise.all(hosts.map(h=>h.close()));await r.close();}
});

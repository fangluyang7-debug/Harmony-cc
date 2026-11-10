const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),zlib=require('node:zlib');
const {randomUUID}=require('node:crypto'),{performance}=require('node:perf_hooks'),{transformSync}=require('esbuild');
const {runtime}=require('./helpers.cjs'),{builtinCpuPacks}=require('@harmony/reference-capabilities');
const {CpuHost}=require('../../pc-agent/dist/host'),{DurableLedger}=require('../../pc-agent/dist/durable-ledger');
const {execute}=require('../../pc-agent/dist/executors/visual');
const core=require('../../../scripts/lib/visual-review-core.cjs');
const m={exports:{}},source=fs.readFileSync(path.resolve(__dirname,'../../../apps/harmony/entry/src/main/ets/services/ShoppingComputeFlow.ets'),'utf8');
new Function('require','module','exports',transformSync(source,{loader:'ts',format:'cjs'}).code)(()=>core,m,m.exports);
test('SIMULATED ordinary photo flow: source App host + peer via SDK/PlanningService, local equivalence and settled unique attempts',async()=>{
 const r=await runtime({cpuHost:true,referencePacks:builtinCpuPacks().filter(p=>p.manifest.packId==='image.visual-match.v1')}),hosts=[],errors=[];
 const group=randomUUID(),capacity=[{resourcePoolId:'cpu',amount:1},{resourcePoolId:'ram',amount:268435456}];
 try{
  let origin;
  for(let i=0;i<2;i++){
   const device=randomUUID(),holder=randomUUID(),invite=await r.auth.invite(group,randomUUID(),device,r.url),owner=await r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:holder});
   await r.allotments.confirmDevice(device,capacity,[{groupId:group,holderInstanceId:holder,appInstanceId:null}]);
   let peer=owner.peer,credential=owner.credential;
   if(i===0){const invitation=await r.apps.register(owner.peer,{label:'Ordinary shopping fixture',allowedContracts:['image.visual-match.v1'],maxConcurrent:4,resources:[{resourcePoolId:'cpu',amount:4},{resourcePoolId:'ram',amount:1073741824}],offlineBase:[],onlineExtra:capacity},r.url);const registered=await r.apps.exchange({registrationId:invitation.registrationId,code:invitation.code});peer=registered.peer;credential=registered.credential;origin=peer;}
   const identity={groupId:group,deviceId:device,holderInstanceId:peer.holderInstanceId,appInstanceId:peer.app?.appInstanceId??null},directory=path.join(r.config.dataDir,'normal-host-'+i);
   const ledger=await DurableLedger.open(directory,identity,invite.certificate);await ledger.close();
   const host=await CpuHost.open({directory,identity,connection:{address:r.url,certificate:invite.certificate,fingerprint:invite.fingerprint,credential,domain:'SIMULATED'},controlIntervalMs:200,contribution:{ownerMode:'dedicated',maxCpuThreads:1,maxMemoryBytes:268435456,reserveMemoryBytes:0}},e=>errors.push(String(e)));hosts.push(host);host.start();
  }
  let candidates=[];for(const end=Date.now()+60000;Date.now()<end;){try{candidates=(await r.snapshots.build(group)).snapshot.candidates.filter(c=>c.capability==='image.visual-match.v1');}catch{}if(candidates.length===2)break;await new Promise(resolve=>setTimeout(resolve,200));}
  assert.equal(candidates.length,2,errors.slice(-5).join('|'));
  const images=Array.from({length:18},(_,n)=>({id:n?'p'+(n-1):'query',width:64,height:64,rgb:Uint8Array.from({length:64*64*3},(_,i)=>(i*13+n*17)%256)}));
  const pack=async raw=>{const h=Buffer.alloc(8);h.write('HVG1');h.writeUInt32LE(raw.length,4);return Buffer.concat([h,zlib.deflateSync(raw)]);};
  const common={originDevice:origin.deviceId,localConcurrency:4,now:()=>performance.now(),id:randomUUID,encode:s=>Buffer.from(s),decode:b=>Buffer.from(b).toString(),pack,local:async b=>(await execute(Buffer.from(b),{},{})).output,cancelled:()=>false};
  const local=await m.exports.matchShoppingPhoto(images,{...common,sdk:null,originTarget:null,deadline:performance.now()+30000},null);
  // Synthetic evidence selects the cooperation branch for correctness, never a speed claim.
  const team=await m.exports.matchShoppingPhoto(images,{...common,sdk:hosts[0].sdk(),originTarget:candidates.find(c=>c.deviceId===origin.deviceId).targetId,deadline:performance.now()+30000},{localMs:10000,dispatchRoundTripMs:1,remoteAvailable:true});
  assert.deepEqual(team.pairs,local.pairs);assert.equal(team.jobs.length,3);assert.ok(team.jobs.some(j=>j.deviceId===origin.deviceId));
  // A cheap fixture may rationally stay on the source. Do not equate an SDK
  // submission with actual two-device execution, or turn this into a speed test.
  assert.equal(team.executionMode,new Set(team.jobs.map(j=>j.deviceId)).size===2?'MULTI_DEVICE_SDK':'SINGLE_DEVICE_SDK');
  const realSdk=hosts[0].sdk(),remote=candidates.find(c=>c.deviceId!==origin.deviceId);
  const coverageSdk={registerInput:realSdk.registerInput.bind(realSdk),releaseInput:realSdk.releaseInput.bind(realSdk),submit:async(workflow,options)=>{
   const copy=structuredClone(workflow);if(!copy.nodes[0].targetId)copy.nodes[0].targetId=remote.targetId;return realSdk.submit(copy,options);
  }};
  // Test-only target constraints cover both real host paths; production does
  // not pin the peer. This assertion is not evidence of automatic placement.
  const coverage=await m.exports.matchShoppingPhoto(images,{...common,sdk:coverageSdk,originTarget:candidates.find(c=>c.deviceId===origin.deviceId).targetId,deadline:performance.now()+30000},{localMs:10000,dispatchRoundTripMs:1,remoteAvailable:true});
  assert.deepEqual(coverage.pairs,local.pairs);assert.equal(coverage.executionMode,'MULTI_DEVICE_SDK');team.jobs.push(...coverage.jobs);
  for(const end=Date.now()+10000;Date.now()<end;){if(team.jobs.every(j=>hosts.some(h=>h.ledger.status(j.id)?.resourcesSettled)))break;await new Promise(resolve=>setTimeout(resolve,100));}
  for(const job of team.jobs){assert.ok(job.traceId);assert.equal(await r.db.attempt.count({where:{workflowId:job.id}}),1);assert.equal((await r.db.receipt.findUniqueOrThrow({where:{id:job.id}})).committed,true);assert.equal(hosts.filter(h=>h.ledger.status(job.id)?.resourcesSettled).length,1);}
 }finally{await Promise.all(hosts.map(h=>h.close()));await r.close();}
});

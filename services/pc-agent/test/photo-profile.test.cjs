const {test}=require('node:test'),assert=require('node:assert/strict');
const {CpuHost}=require('../dist/host');
test('profile ACK timeout does not turn a valid local sample into unknown or cancel admitted work',async()=>{
 const host=Object.create(CpuHost.prototype),updates=[],errors=[];
 Object.assign(host,{config:{connection:{domain:'SIMULATED'},contribution:{ownerMode:'dedicated',maxCpuThreads:2,maxMemoryBytes:268435456,reserveMemoryBytes:0}},clockOffset:0,packs:[],stopped:false,
  relayLinks:{sample:async()=>[]},ledger:{snapshot:()=>({entries:[],grant:{},deviceId:'device',holderInstanceId:'holder',ledgerEpoch:1}),pendingMessages:()=>[],inFlight:()=>null},
  agent:{ready:true,updateResources:async(limits,owner)=>updates.push({limits,owner}),scheduler:{capacityCredits:()=>[],queuedFacts:()=>null},publishProfile:async()=>{throw Error('PROFILE_ACK_TIMEOUT');}},onError:e=>errors.push(e.message)});
 await host.sample(false);assert.deepEqual(errors,['PROFILE_ACK_TIMEOUT']);assert.equal(updates.length,1);assert.equal(updates[0].owner,'IDLE');assert.ok(updates[0].limits[0].amount>0);assert.equal(host.owner,'IDLE');
 host.config.contribution.ownerMode='paused';await host.sample(false);assert.equal(updates.at(-1).owner,'ACTIVE');assert.ok(updates.at(-1).limits.every(x=>x.amount===0));
 host.ledger.snapshot=()=>{throw Error('LOCAL_SAMPLE_FAILED');};await host.sample(false);assert.equal(updates.at(-1).owner,'UNKNOWN');assert.deepEqual(updates.at(-1).limits,[]);
});

 test('photo GPU lifecycle lanes and VRAM admission include own occupancy exactly once',async()=>{
 const host=Object.create(CpuHost.prototype),GiB=1073741824,profiles=[],updates=[];
 const entry={resources:[{resourcePoolId:'gpu',amount:1},{resourcePoolId:'vram',amount:GiB}],record:{resourcesSettled:false}};
 Object.assign(host,{config:{connection:{domain:'SIMULATED'},contribution:{ownerMode:'dedicated',maxCpuThreads:4,maxMemoryBytes:GiB,reserveMemoryBytes:0,maxVramBytes:8*GiB},imageEncoder:{gpu:{totalBytes:8*GiB,limit:8*GiB,pipelineSlots:4,freeBytes:async()=>6*GiB}}},clockOffset:0,packs:[],stopped:false,
 relayLinks:{sample:async()=>[]},ledger:{snapshot:()=>({entries:[entry],grant:{},deviceId:'device',holderInstanceId:'holder',ledgerEpoch:1}),pendingMessages:()=>[],inFlight:()=>null},
 agent:{ready:true,updateResources:async(limits)=>updates.push(limits),scheduler:{capacityCredits:()=>[],queuedFacts:()=>[]},publishProfile:async p=>profiles.push(p)},onError:e=>{throw e;}});
 await host.sample(false);let profile=profiles.at(-1),gpu=profile.pools.find(p=>p.kind==='GPU_SLOTS'),vram=profile.pools.find(p=>p.kind==='VRAM_BYTES');
 assert.equal(gpu.total.value,4);assert.equal(gpu.exclusive,false);assert.equal(gpu.occupied.value,1);
 assert.equal(vram.admissionLimit.value,7*GiB);assert.equal(vram.admissionLimit.value-vram.occupied.value,6*GiB,'free bytes are not charged again');
 host.config.imageEncoder.gpu.pipelineSlots=undefined;await host.sample(false);gpu=profiles.at(-1).pools.find(p=>p.kind==='GPU_SLOTS');assert.equal(gpu.total.value,1);assert.equal(gpu.exclusive,true,'non opted-in CUDA/old executor stays serial');
 host.config.contribution.maxVramBytes=2*GiB;await host.sample(false);assert.equal(profiles.at(-1).pools.find(p=>p.kind==='VRAM_BYTES').admissionLimit.value,2*GiB);
 host.config.contribution.ownerMode='paused';await host.sample(false);assert.ok(updates.at(-1).every(x=>x.amount===0));
 });

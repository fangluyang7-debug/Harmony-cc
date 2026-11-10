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

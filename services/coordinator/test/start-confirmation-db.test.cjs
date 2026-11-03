const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {runtime}=require('./helpers.cjs'),{DurableLedger}=require('../../pc-agent/dist/durable-ledger'),{CpuJobs}=require('../dist/cpu-jobs');
test('explicit grant and delayed persisted ACK wake the waiter',async()=>{
 const r=await runtime();let ledger;
 try{
  const invite=await r.auth.invite('g','p','d',r.url),paired=await r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:'h'}),peer=paired.peer,capacity=[{resourcePoolId:'cpu',amount:1}];
  await r.allotments.confirmDevice('d',capacity,[{groupId:'g',holderInstanceId:'h',appInstanceId:null}]);
  const grant=await r.allotments.issue(peer,{ledgerEpoch:1,leaseRequestId:'req',leaseMs:30000,base:[],extra:capacity});
  ledger=await DurableLedger.open(path.join(r.config.dataDir,'holder'),{groupId:'g',deviceId:'d',holderInstanceId:'h',appInstanceId:null},r.identity.cert);ledger.requestGrant('req');ledger.installGrant(grant);
  const jobs=Object.create(CpuJobs.prototype);jobs.allotments=r.allotments;jobs.epoch=()=>r.epoch;jobs.owned=async()=>({deadlineAt:Date.now()+10000});jobs.db={cpuJob:{findUniqueOrThrow:async()=>({state:'WAITING_INPUT'})}};
  let wake;const registered=new Promise(resolve=>wake=resolve),watch=r.allotments.watch.bind(r.allotments);r.allotments.watch=(...args)=>{const stop=watch(...args);wake();return stop;};
  const pending=jobs.confirmedGrant(peer,'d','h',{until:Date.now()+2500,jobId:'job'});await registered;
  const signed=ledger.acknowledgement(paired.credential);await r.allotments.acknowledge(peer,signed.ack,signed.signature);
  assert.equal((await pending).version,grant.version);assert.equal((await r.allotments.reservations('d'))[0].ack.version,grant.version);
 }finally{await ledger?.close();await r.close();}
});

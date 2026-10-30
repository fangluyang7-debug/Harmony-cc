const {test}=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path'),fs=require('node:fs');
const {runtime}=require('./helpers.cjs');
const {AllotmentIssuer}=require('../dist/allotments');
const {DurableLedger}=require('../../pc-agent/dist/durable-ledger');
const template=require('../../../contracts/scheduling/v2/fixtures/t2/valid/DispatchOffer.json');
const {vectorSumV2}=require('@harmony/scheduler-core');
async function pair(r,holder){const invite=await r.auth.invite('g1','p1','device1',r.url);return r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:holder});}
test('same-device budget stays reserved across expiry, restart and shrink until authenticated persisted settlement',async()=>{
 const r=await runtime();let ledger;
 try{
  const a=await pair(r,'holder1'),b=await pair(r,'holder2');const capacity=[{resourcePoolId:'memory1',amount:100},{resourcePoolId:'cpu1',amount:1}];
  const request={ledgerEpoch:1,leaseRequestId:'r1',leaseMs:1000,base:[],extra:capacity};
  await assert.rejects(r.allotments.issue(a.peer,request),/IDENTITY_UNRESOLVED/);
  await r.allotments.confirmDevice('device1',capacity,[{groupId:'g1',holderInstanceId:'holder1',appInstanceId:null},{groupId:'g1',holderInstanceId:'holder2',appInstanceId:null}]);
  const grant=await r.allotments.issue(a.peer,request);assert.deepEqual(await r.allotments.issue(a.peer,request),grant);
  await assert.rejects(r.allotments.issue(a.peer,{...request,extra:[]}),/REQUEST_CONFLICT/);
  ledger=await DurableLedger.open(fs.mkdtempSync(path.join(r.config.dataDir,'agent-')),{groupId:'g1',deviceId:'device1',holderInstanceId:'holder1',appInstanceId:null},r.identity.cert,()=>0);
  ledger.requestGrant('r1');ledger.installGrant(grant);const offer=structuredClone(template);offer.allotmentId=grant.allotmentId;
  const entry=ledger.admit(offer,{coordinatorEpoch:1,online:true,ownerIdle:true,admissionLimit:capacity});ledger.begin(offer.task.attemptId);
  const acknowledge=async(issuer=r.allotments)=>{const signed=ledger.acknowledgement(a.credential);await issuer.acknowledge(a.peer,signed.ack,signed.signature);return signed;};
  const firstAck=await acknowledge();await assert.rejects(r.allotments.acknowledge(a.peer,firstAck.ack,'AAAA'),/SIGNATURE/);
  await assert.rejects(r.allotments.issue(b.peer,request),/BUDGET_UNAVAILABLE/);
  const shrink=await r.allotments.issue(a.peer,{...request,leaseRequestId:'r2',extra:[]});ledger.requestGrant('r2');ledger.installGrant(shrink);ledger.cancel(offer.task.attemptId);await acknowledge();
  await assert.rejects(r.allotments.issue(b.peer,request),/BUDGET_UNAVAILABLE/);
  // A new coordinator epoch retains every old reservation, even if its lease has elapsed.
  const restarted=new AllotmentIssuer(r.db,r.identity.key,()=>2);await assert.rejects(restarted.issue(b.peer,request),/BUDGET_UNAVAILABLE/);
  await assert.rejects(restarted.confirmDevice('device1',[],[{groupId:'g1',holderInstanceId:'holder2',appInstanceId:null}]),/BUDGET_INVALID/);
  ledger.settle({attemptId:entry.record.attemptId,coordinatorEpoch:1,planRevision:1,fence:entry.record.fence,state:'CANCELLED_SETTLED',resourcesSettled:true,outputs:[],actualTarget:offer.target,actualConfiguration:'default',errorCode:null});await acknowledge(restarted);
  const grantedB=await restarted.issue(b.peer,request);assert.equal(grantedB.coordinatorEpoch,2);
  assert.deepEqual(vectorSumV2(...(await restarted.reservations('device1')).map(x=>x.reserved)),capacity);
  await assert.rejects(restarted.acknowledge(a.peer,firstAck.ack,firstAck.signature),/ACK_VERSION/);
 }finally{if(ledger)await ledger.close();await r.close();}
});
test('offline base always reserves physical capacity; duplicate installation binding and agent base are rejected',async()=>{
 const r=await runtime();try{
  const a=await pair(r,'h1'),b=await pair(r,'h2'),capacity=[{resourcePoolId:'ram',amount:100}];
  await assert.rejects(r.allotments.confirmDevice('device1',capacity,[{groupId:'g1',holderInstanceId:'h1',appInstanceId:'app1'},{groupId:'g1',holderInstanceId:'h2',appInstanceId:'app1'}]),/BUDGET_INVALID/);
  await r.allotments.confirmDevice('device1',capacity,[{groupId:'g1',holderInstanceId:'h1',appInstanceId:'app1'},{groupId:'g1',holderInstanceId:'h2',appInstanceId:null}]);
  const input={ledgerEpoch:1,leaseRequestId:'r1',leaseMs:1,base:capacity,extra:[]};await r.allotments.issue(a.peer,input);
  await assert.rejects(r.allotments.issue(b.peer,input),/AGENT_BASE_FORBIDDEN/);
  await assert.rejects(r.allotments.issue(b.peer,{...input,base:[],extra:capacity}),/BUDGET_UNAVAILABLE/);
  await assert.rejects(r.allotments.confirmDevice('device1',capacity,[{groupId:'g1',holderInstanceId:'h2',appInstanceId:null}]),/BINDING_HAS_UNSETTLED/);
 }finally{await r.close();}
});

const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {fixture}=require('./native-coordinator-fixture.cjs');
function socket(){return {open:true,sent:[],isOpen(){return this.open},async send(v){this.sent.push(JSON.parse(v))},async ping(){},async close(){this.open=false;this.onClosed?.()},disconnected(){this.open=false;this.onClosed?.()}};}
async function setup(){const f=fixture(),root='apps/harmony/scheduler/src/main/ets/v2/coordinator/';f.device('device1','h1');const c=new (f.load(root+'CoordinatorCredentials.ets').CoordinatorCredentials)(f.database,'REAL'),identity=await c.issueDevice('g','p','device1','h1'),channel=new (f.load(root+'CoordinatorChannel.ets').CoordinatorChannel)(f.database,c,'center',7),s=socket();await channel.upgrade({authorization:'Bearer '+identity.credential},s);return {...f,channel,s,c,identity};}
const envelope=(id,type,seq,payload)=>({protocolVersion:2,messageId:id,type,groupId:'g',senderInstanceId:'h1',coordinatorEpoch:7,seq,ackOf:null,traceId:'trace',payload:JSON.stringify(payload),extensions:[]});
test('native channel negotiates, acknowledges durably, preserves duplicate/order semantics and live presence',async()=>{
 const f=await setup();try{
  const send=m=>f.s.onText(JSON.stringify(m));
  await send(envelope('hello','Hello',10,{versions:[2],extensions:[]}));
  await send(envelope('recover','RecoveryRequest',1,{}));
  const p=JSON.parse(fs.readFileSync('contracts/scheduling/v2/fixtures/t2/valid/DeviceProfile.json'));p.domain='REAL';
  function measured(v){if(!v||typeof v!=='object')return;if('sampledAt' in v){v.sampledAt=Date.now()-50;v.ttlMs=60000;if(v.source==='SIMULATED')v.source='MEASURED';}else Object.values(v).forEach(measured);}measured(p);
  const profile=envelope('profile','DeviceProfile',2,p);await send(profile);await send(profile);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM DeviceInstance').get().n,1);
  assert.equal(f.channel.linkState('g','h1','instance1',1),'ONLINE');
  assert.equal(f.s.sent.length,4);assert.equal(f.s.sent[3].ackOf,'profile');
  await assert.rejects(send({...profile,payload:JSON.stringify({...p,sequence:9})}),/MESSAGE_CONFLICT/);
  await assert.rejects(send(envelope('late','RecoveryRequest',1,{})),/SEQUENCE_REORDERED/);
  // A replay must be acknowledged without replacing the newer live ledger binding.
  const newer=structuredClone(p);newer.ledgerEpoch=2;newer.deviceInstanceId='instance2';newer.sequence++;
  await send(envelope('new-profile','DeviceProfile',3,newer));
  await send(profile);
  assert.equal(f.channel.linkState('g','h1','instance2',2),'ONLINE');
  assert.equal(f.channel.linkState('g','h1','instance1',1),'RECONCILING');
  await f.s.close();assert.equal(f.channel.linkState('g','h1','instance1',1),'OFFLINE');
 }finally{await f.channel.close();}
});
test('native channel never acknowledges rejected state, unsettled recovery or revoked credentials',async()=>{
 const f=await setup();try{
  await assert.rejects(f.s.onText(JSON.stringify(envelope('early','RecoveryRequest',1,{}))),/HELLO_REQUIRED/);
  await f.s.onText(JSON.stringify(envelope('hello','Hello',2,{versions:[2],extensions:[]})));
  f.sql.prepare('INSERT INTO Attempt (id,groupId,workflowId,nodeId,executionDigest,state,holderInstanceId,taskJson) VALUES (?,?,?,?,?,?,?,?)').run('a','g','w','n','digest','RUNNING','h1','{}');
  await assert.rejects(f.s.onText(JSON.stringify(envelope('recovery','RecoveryRequest',3,{}))),/RECOVERY_PENDING/);
  assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM ChannelInbox').get().n,1);
  await f.c.revoke(f.identity.peer.credentialId);await assert.rejects(f.s.onText(JSON.stringify(envelope('next','Hello',4,{versions:[2],extensions:[]}))),/CREDENTIAL_REVOKED/);
 }finally{await f.channel.close();}
});

test('busy dispatch is sent once per live connection, and recovery can redeliver unacknowledged intent',async()=>{
 const f=await setup();try{
  await f.s.onText(JSON.stringify(envelope('hello','Hello',10,{versions:[2],extensions:[]})));
  await f.s.onText(JSON.stringify(envelope('recover','RecoveryRequest',1,{})));
  f.sql.prepare('INSERT INTO Attempt (id,groupId,workflowId,nodeId,executionDigest,state,holderInstanceId,taskJson,recordJson) VALUES (?,?,?,?,?,?,?,?,?)').run('offer-a','g','w','n','digest','SUCCEEDED','h1','{}',JSON.stringify({resourcesSettled:true}));
  await f.database.transaction(tx=>f.channel.enqueue(tx,'g','offer-a','DispatchOffer',{test:'payload'},'trace'));
  for(let i=0;i<100;i++)await f.channel.pump();
  const offers=f.s.sent.filter(m=>m.type==='DispatchOffer');assert.equal(offers.length,1,'repeated scheduler wakeups must not flood the holder ledger');
  await f.s.close();const s2=socket();await f.channel.upgrade({authorization:'Bearer '+f.identity.credential},s2);
  await s2.onText(JSON.stringify(envelope('hello2','Hello',11,{versions:[2],extensions:[]})));
  await s2.onText(JSON.stringify(envelope('recover2','RecoveryRequest',2,{})));await f.channel.pump();
  assert.equal(s2.sent.filter(m=>m.type==='DispatchOffer').length,1);assert.equal(s2.sent.find(m=>m.type==='DispatchOffer').messageId,offers[0].messageId);
  const ack={...envelope('ack','Ack',3,{messageId:offers[0].messageId}),ackOf:offers[0].messageId};await s2.onText(JSON.stringify(ack));await f.channel.pump();
  assert.equal(f.sql.prepare('SELECT acked FROM Outbox').get().acked,1);assert.equal(s2.sent.filter(m=>m.type==='DispatchOffer').length,1);
 }finally{await f.channel.close();}
});

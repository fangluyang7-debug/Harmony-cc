const {test}=require('node:test'),assert=require('node:assert/strict');
const {once}=require('node:events');
const {WebSocket}=require('ws');
const {runtime}=require('./helpers.cjs');
const {attempt}=require('./fixtures.cjs');
const {qualifySimulated}=require('./fixtures.cjs');
const {ProfilePublisher}=require('../../pc-agent/dist/profile-publisher');
const peer={groupId:'g1',holderInstanceId:'h1',deviceId:'device1',principalId:'p1',credentialId:'credential1'};
const authenticate=async token=>{if(token!=='test-token')throw Error('UNAUTHORIZED');return peer;};
function envelope(r,id,seq,type='Hello',payload={versions:[2],extensions:[]}){return {protocolVersion:2,messageId:id,type,groupId:'g1',senderInstanceId:'h1',coordinatorEpoch:r.epoch,seq,ackOf:null,traceId:'trace1',payload:JSON.stringify(payload),extensions:[]};}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('yielding reference calibration is acknowledged without settling it or poisoning reconnect',async()=>{
 const r=await runtime({authenticate});let ws;
 try{
  await r.db.evaluationDispatch.create({data:{id:'eval-yield',groupId:'g1',holderInstanceId:'h1',deviceId:'device1',epoch:r.epoch,state:'CLAIMED',expiresAt:Date.now()+15000,workJson:'{}'}});
  ws=await connect(r);ws.send(JSON.stringify(envelope(r,'hello-eval',1)));await ws.next();
  const notice={attemptId:'eval-yield',kind:'RESTART',releaseMs:{value:null,source:'UNKNOWN',sampledAt:Date.now(),ttlMs:1000,unit:'ms'},checkpoint:null,reasonCode:'OWNER_ACTIVE'};
  const message=envelope(r,'yield-eval',2,'YieldNotice',notice);
  ws.send(JSON.stringify(message));assert.equal((await ws.next()).ackOf,'yield-eval');
  ws.send(JSON.stringify(message));assert.equal((await ws.next()).ackOf,'yield-eval');
  const row=await r.db.evaluationDispatch.findUniqueOrThrow({where:{id:'eval-yield'}});
  assert.equal(row.state,'CANCEL_REQUESTED');assert.equal(row.resultJson,null);
  ws.send(JSON.stringify(envelope(r,'still-connected',3)));assert.equal((await ws.next()).ackOf,'still-connected');
  await r.db.evaluationDispatch.update({where:{id:'eval-yield'},data:{holderInstanceId:'another-holder'}});
  const closed=once(ws,'close');ws.send(JSON.stringify(envelope(r,'wrong-owner',4,'YieldNotice',notice)));
  const [code,reason]=await closed;assert.equal(code,1008);assert.equal(reason.toString(),'YIELD_SCOPE');
 }finally{ws?.terminate();await r.close();}
});
async function connect(r,token='test-token',autoPong=true){
  const ws=new WebSocket(r.url.replace('https:','wss:')+'/v2/channel',{ca:r.identity.cert,family:4,autoPong,headers:{Authorization:'Bearer '+token}});
  const queue=[],waiters=[];ws.on('message',b=>{const m=JSON.parse(b.toString());if(waiters.length)waiters.shift()(m);else queue.push(m);});
  ws.next=()=>queue.length?Promise.resolve(queue.shift()):Promise.race([new Promise(resolve=>waiters.push(resolve)),new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('MESSAGE_TIMEOUT')),5000);t.unref();})]);
  await once(ws,'open');return ws;
}

test('disconnect during a durable handler is transport loss; reconnect ACKs without executing twice',{timeout:20000},async()=>{
  const errors=[],r=await runtime({authenticate,onError:e=>errors.push(e.message)}),entered=deferred(),release=deferred(),finished=deferred();let ws,count=0;
  r.channel.register('Paused',{validate:p=>Object.keys(p).length===0,handle:async()=>{count++;entered.resolve();await release.promise;}});
  const send=r.channel.send.bind(r.channel);r.channel.send=async(s,m)=>{try{return await send(s,m);}finally{if(m.ackOf==='paused')finished.resolve();}};
  try{
    ws=await connect(r);ws.send(JSON.stringify(envelope(r,'hello',1)));await ws.next();
    const m=envelope(r,'paused',2,'Paused',{});ws.send(JSON.stringify(m));await entered.promise;
    const disconnected=once(ws,'close');ws.close();await disconnected;release.resolve();await finished.promise;
    ws=await connect(r);ws.send(JSON.stringify(envelope(r,'hello-again',3)));await ws.next();ws.send(JSON.stringify(m));assert.equal((await ws.next()).ackOf,'paused');
    assert.equal(count,1);assert.deepEqual(errors,['CONTROL_DISCONNECTED']);
  }finally{release.resolve();ws?.terminate();await r.close();}
});

test('shutdown drains a disconnected session handler before disconnecting storage',{timeout:20000},async()=>{
  const r=await runtime({authenticate}),entered=deferred(),release=deferred();let ws,closing,completed=false;
  r.channel.register('Paused',{validate:p=>Object.keys(p).length===0,handle:async()=>{entered.resolve();await release.promise;await r.db.channelInbox.count();completed=true;}});
  try{
    ws=await connect(r);ws.send(JSON.stringify(envelope(r,'hello',1)));await ws.next();
    ws.send(JSON.stringify(envelope(r,'paused',2,'Paused',{})));await entered.promise;
    const disconnected=once(ws,'close');ws.close();await disconnected;
    // Wait for the server close event, so this session is absent from its live-session set.
    const deadline=Date.now()+5000;while(r.channel.sessions.size&&Date.now()<deadline)await new Promise(resolve=>setImmediate(resolve));assert.equal(r.channel.sessions.size,0);
    const original=r.db.$disconnect.bind(r.db);r.db.$disconnect=async()=>{assert.equal(completed,true);await original();};
    closing=r.close();release.resolve();await closing;assert.equal(completed,true);
  }finally{release.resolve();ws?.terminate();await (closing??r.close());}
});

test('malformed JSON, storage failures and unknown handler faults have distinct safe close reasons',{timeout:20000},async()=>{
  const r=await runtime({authenticate});let ws;
  r.channel.register('StorageFault',{validate:()=>true,handle:async()=>{const e=Error('private database detail');e.name='PrismaClientUnknownRequestError';throw e;}});
  r.channel.register('UnknownFault',{validate:()=>true,handle:async()=>{throw Error('private handler detail');}});
  try{
    let seq=0;
    for(const [type,reason] of [['Malformed','CONTROL_INVALID_JSON'],['StorageFault','CONTROL_STORAGE_ERROR'],['UnknownFault','CONTROL_INTERNAL_ERROR']]){
      ws=await connect(r);ws.send(JSON.stringify(envelope(r,'hello-'+(++seq),seq)));await ws.next();
      const closed=once(ws,'close');ws.send(type==='Malformed'?'{':JSON.stringify(envelope(r,'fault-'+(++seq),seq,type,{})));
      const [code,detail]=await closed;assert.equal(code,1008);assert.equal(detail.toString(),reason);
    }
  }finally{ws?.terminate();await r.close();}
});
test('duplicates, reconnect and out-of-order messages preserve durable message semantics',async()=>{
  const r=await runtime({authenticate});let count=0;
  r.channel.register('Probe',{validate:p=>p&&Object.keys(p).length===1&&p.value===1,handle:async()=>{count++;}});
  let ws;
  try{
    ws=await connect(r);const hello=envelope(r,'hello',1);ws.send(JSON.stringify(hello));assert.equal((await ws.next()).ackOf,'hello');
    const probe=envelope(r,'probe',2,'Probe',{value:1});ws.send(JSON.stringify(probe));await ws.next();ws.send(JSON.stringify(probe));await ws.next();assert.equal(count,1);
    const closed=once(ws,'close');ws.close();await closed;ws=await connect(r);ws.send(JSON.stringify(hello));await ws.next();ws.send(JSON.stringify(probe));await ws.next();assert.equal(count,1);
    const closing=once(ws,'close');ws.send(JSON.stringify(envelope(r,'reordered',1,'Probe',{value:1})));assert.equal((await closing)[0],1008);
  }finally{ws?.terminate();await r.close();}
});
test('outbox dispatch is pushed and resent on reconnect until holder ACK',async()=>{
  const r=await runtime({authenticate});let ws;
  try{
    const f=attempt();f.message.senderInstanceId=r.identity.id;await r.store.persistOffer(f.offer,'h1',f.message);
    ws=await connect(r);const hello=envelope(r,'hello',1);ws.send(JSON.stringify(hello));assert.equal((await ws.next()).type,'DispatchOffer');await ws.next();
    const closed=once(ws,'close');ws.close();await closed;ws=await connect(r);ws.send(JSON.stringify(hello));assert.equal((await ws.next()).type,'DispatchOffer');await ws.next();
    const ack=envelope(r,'ack',2,'Ack',{messageId:f.message.messageId});ack.ackOf=f.message.messageId;ws.send(JSON.stringify(ack));
    ws.send(JSON.stringify(envelope(r,'hello2',3)));await ws.next();
    const row=await r.db.outbox.findFirst();assert.equal(row.acked,true);assert.equal(row.deliveryCount,2);
  }finally{ws?.terminate();await r.close();}
});
test('unknown credential, old epoch, invalid payload and backpressure are rejected',async()=>{
  const r=await runtime({authenticate});let ws;
  try{
    await assert.rejects(connect(r,'bad-token'));
    ws=await connect(r);let closed=once(ws,'close');const stale=envelope(r,'old',1);stale.coordinatorEpoch=2;ws.send(JSON.stringify(stale));assert.equal((await closed)[0],1008);
    ws=await connect(r);closed=once(ws,'close');ws.send(JSON.stringify(envelope(r,'bad',2,'Hello',{versions:[99],extensions:[]})));assert.equal((await closed)[0],1008);
    r.channel.limits.bufferedBytes=1;ws=await connect(r);closed=once(ws,'close');ws.send(JSON.stringify(envelope(r,'bounded',3)));assert.equal((await closed)[0],1013);
  }finally{ws?.terminate();await r.close();}
});

test('profile events and heartbeat cross TLS/WS and ACK only after snapshot publication',async()=>{
  const fs=require('node:fs'),r=await runtime({authenticate});let ws,publisher,tick;
  try{
    const contribution={minimumBattery:20,maximumTemperature:3,allowMetered:false,priority:'REMOTE_INTERACTIVE',requireForeground:true};
    const policy={version:'p1',revoked:false,allowedTargetIds:['target1'],limits:{maxCandidates:8,lookahead:16,beamWidth:8,planningBudgetMs:20,switchCostMs:0,hysteresisMs:0}};
    await r.profiles.configure('g1',policy,contribution);
    ws=await connect(r);let sequence=1;ws.send(JSON.stringify(envelope(r,'hello',sequence)));await ws.next();
    const profile=JSON.parse(fs.readFileSync('../../contracts/scheduling/v2/fixtures/t2/valid/DeviceProfile.json'));
    const resample=value=>{if(value&&typeof value==='object'){if('sampledAt' in value){value.sampledAt=Date.now();value.ttlMs=10000;}else for(const v of Object.values(value))resample(v);}};
    resample(profile);
    let profileSequence=0;
    publisher=new ProfilePublisher({source:{collect:async()=>structuredClone(profile),subscribe:()=>()=>{}},nextSequence:async()=>++profileSequence,
      publish:async payload=>{const m=envelope(r,'profile'+(++sequence),sequence,'DeviceProfile',payload);ws.send(JSON.stringify(m));assert.equal((await ws.next()).ackOf,m.messageId);},
      onError:error=>{throw error;},every:(_ms,f)=>{tick=f;return ()=>{};}});
    await publisher.start();assert.equal((await r.snapshots.build('g1')).snapshot.devices.length,1);
    assert.equal((await r.snapshots.build('g1')).snapshot.candidates.length,0);
    await qualifySimulated(r.db,profile);await r.profiles.refresh('g1');
    assert.equal((await r.snapshots.build('g1')).snapshot.candidates.length,0,'hello and profile alone do not complete recovery');
    ws.send(JSON.stringify(envelope(r,'recover',++sequence,'RecoveryRequest',{})));await ws.next();await r.profiles.refresh('g1');
    assert.equal((await r.snapshots.build('g1')).snapshot.candidates.length,1);
    profile.ownerActivity.value='ACTIVE';await publisher.changed();
    assert.equal((await r.snapshots.build('g1')).snapshot.candidates.length,0);
    const version=(await r.snapshots.build('g1')).snapshot.version;
    tick();await publisher.changed();assert.ok((await r.snapshots.build('g1')).snapshot.version>version);
    await publisher.stop();publisher=null;
    const before=(await r.snapshots.build('g1')).snapshot.version;
    const bad={...profile,sequence:profileSequence+1,holderInstanceId:'other'};
    const closed=once(ws,'close');ws.send(JSON.stringify(envelope(r,'forged',++sequence,'DeviceProfile',bad)));assert.equal((await closed)[0],1008);
    assert.equal((await r.snapshots.build('g1')).snapshot.version,before);
    assert.equal(r.channel.linkState('g1','h1',profile.deviceInstanceId,profile.ledgerEpoch),'OFFLINE');
  }finally{await publisher?.stop();ws?.terminate();await r.close();}
});

test('busy socket with missing pongs stops being eligible while its ledger occupancy remains',async()=>{
 const r=await runtime({authenticate});let ws;
 try{
  ws=await connect(r,'test-token',false);
  ws.send(JSON.stringify(envelope(r,'hello',1)));await ws.next();
  ws.send(JSON.stringify(envelope(r,'recover',2,'RecoveryRequest',{})));await ws.next();
  const profile=structuredClone(require('../../../contracts/scheduling/v2/fixtures/t2/valid/DeviceProfile.json'));
  const now=Date.now();
  const update=v=>{if(v&&typeof v==='object'){if('sampledAt' in v){v.sampledAt=now;v.ttlMs=30000;}else Object.values(v).forEach(update);}};update(profile);
  const executor=profile.executors[0],sample={value:10,unit:'ms',source:'SIMULATED',sampledAt:now,ttlMs:30000};
  profile.inFlight=[{attemptId:'running',targetId:executor.target.targetId,state:'RUNNING',resources:executor.resources,elapsed:sample,remaining:sample}];
  const pool=profile.pools.find(p=>p.resourcePoolId===executor.resources[0].resourcePoolId);
  pool.occupied.value=executor.resources[0].amount;pool.draining=pool.occupied.value>pool.admissionLimit.value;
  ws.send(JSON.stringify(envelope(r,'profile',3,'DeviceProfile',profile)));await ws.next();
  const state=()=>r.channel.linkState('g1','h1',profile.deviceInstanceId,profile.ledgerEpoch);
  assert.equal(state(),'ONLINE');const end=Date.now()+5000;
  while(state()==='ONLINE'&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(state(),'SUSPECT');
  const policy={minimumBattery:null,maximumTemperature:null,allowMetered:true,priority:'REMOTE_INTERACTIVE',requireForeground:true};
  const snapshot=await r.directory.snapshot('g1','live',1,policy);
  assert.ok(snapshot.excludedTargets.some(t=>['CONTROL_SUSPECT','CONTROL_OFFLINE'].includes(t.code)));
  assert.equal(snapshot.candidates.length,0);
  assert.deepEqual((await r.directory.profiles('g1'))[0].inFlight,profile.inFlight);
 }finally{ws?.terminate();await r.close();}
});

test('a heartbeat publishes its new facts once and changes the automatic target policy only on discovery or removal',async()=>{
 const r=await runtime({cpuHost:true,authenticate});let ws;
 try{
  ws=await connect(r);ws.send(JSON.stringify(envelope(r,'hello-config',1)));await ws.next();
  const configure=r.profiles.configure.bind(r.profiles);let configured=0;
  r.profiles.configure=async(...args)=>{configured++;return configure(...args);};
  const p=structuredClone(require('../../../contracts/scheduling/v2/fixtures/t2/valid/DeviceProfile.json'));
  p.executors[0].contract.capability='text.count.v1';
  async function publish(id,seq){
   ws.send(JSON.stringify(envelope(r,id,seq,'DeviceProfile',p)));
   for(;;){const m=await ws.next();if(m.type==='ProtocolError')throw Error(m.payload);if(m.ackOf===id)return;}
  }
  await publish('first-profile',2);assert.equal(configured,1);
  p.sequence++;await publish('same-targets',3);assert.equal(configured,1);
  p.sequence++;p.executors=[];await publish('no-targets',4);assert.equal(configured,2);
  assert.deepEqual((await r.snapshots.build(peer.groupId)).policy.allowedTargetIds,[]);
 }finally{ws?.terminate();await r.close();}
});
test('a deliberate coordinator shutdown closes device channels with 4001 so devices drop the pairing',{timeout:20000},async()=>{
  const r=await runtime({authenticate});let ws,closed=false;
  try{
    ws=await connect(r);ws.send(JSON.stringify(envelope(r,'hello',1)));await ws.next();
    const done=once(ws,'close');await r.close();closed=true;const [code,reason]=await done;
    assert.equal(code,4001);assert.equal(reason.toString(),'COORDINATOR_SHUTDOWN');
  }finally{ws?.terminate();if(!closed)await r.close();}
});

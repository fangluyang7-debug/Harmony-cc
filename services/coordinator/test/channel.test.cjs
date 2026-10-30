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
async function connect(r,token='test-token'){
  const ws=new WebSocket(r.url.replace('https:','wss:')+'/v2/channel',{ca:r.identity.cert,family:4,headers:{Authorization:'Bearer '+token}});
  const queue=[],waiters=[];ws.on('message',b=>{const m=JSON.parse(b.toString());if(waiters.length)waiters.shift()(m);else queue.push(m);});
  ws.next=()=>queue.length?Promise.resolve(queue.shift()):Promise.race([new Promise(resolve=>waiters.push(resolve)),new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('MESSAGE_TIMEOUT')),5000);t.unref();})]);
  await once(ws,'open');return ws;
}
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
  }finally{await publisher?.stop();ws?.terminate();await r.close();}
});

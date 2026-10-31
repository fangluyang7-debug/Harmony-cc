const {test}=require('node:test'),assert=require('node:assert/strict');
const {RelayLinks}=require('../dist/relay-links');
const {validLinkV2}=require('@harmony/scheduler-core');
test('relay links remain unknown without valid observations; measured HTTP intervals expire and network changes discard them',async()=>{
  let network='first',calls=0;
  const request=async(_route,body)=>{calls++;return {relayId:'relay',padding:body.mode==='download'?'x'.repeat(body.bytes):''};};
  const links=new RelayLinks('device','SIMULATED',request,()=>network);
  assert.equal(links.state,'UNKNOWN');const first=await links.sample(100);
  assert.equal(first.length,2);assert.equal(calls,6);assert.ok(first.every(l=>validLinkV2(l)&&l.fixedMs.source==='SIMULATED'&&l.bytesPerSecond.value>0));
  await links.sample(200);assert.equal(calls,6);network='second';const second=await links.sample(300);
  assert.notEqual(first[0].networkEpoch,second[0].networkEpoch);assert.equal(calls,12);
  const unavailable=new RelayLinks('device','REAL',async()=>{throw Error('OFFLINE');},()=>network);
  assert.deepEqual(await unavailable.sample(100),[]);assert.equal(unavailable.state,'UNKNOWN');
  const changing=new RelayLinks('device','REAL',async(...args)=>{network+='x';return request(...args);},()=>network);
  assert.deepEqual(await changing.sample(100),[]);
});

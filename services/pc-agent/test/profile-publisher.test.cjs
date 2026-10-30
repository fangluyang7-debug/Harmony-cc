const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {ProfilePublisher}=require('../dist/profile-publisher');
const fixture=()=>JSON.parse(fs.readFileSync('../../contracts/scheduling/v2/fixtures/t2/valid/DeviceProfile.json'));
test('initial event, changes and heartbeat use persisted sequences without refreshing sample timestamps',async()=>{
 let event,tick,seq=4,unsubscribed=false,stopped=false;const sent=[],errors=[],p=fixture();
 const publisher=new ProfilePublisher({source:{collect:async()=>structuredClone(p),subscribe:f=>{event=f;return ()=>{unsubscribed=true;};}},
  nextSequence:async()=>++seq,publish:async v=>sent.push(v),onError:e=>errors.push(e),every:(_ms,f)=>{tick=f;return ()=>{stopped=true;};}});
 await publisher.start();assert.equal(sent[0].sequence,5);
 p.ownerActivity.value='ACTIVE';event();await publisher.changed();assert.equal(sent.at(-1).ownerActivity.value,'ACTIVE');
 const count=sent.length;tick();await publisher.changed();assert.ok(sent.length>count);
 assert.ok(sent.every(v=>v.ownerActivity.sampledAt===100));assert.ok(sent.every((v,i)=>v.sequence===5+i));
 await publisher.stop();event();tick();assert.equal(unsubscribed&&stopped,true);assert.deepEqual(errors,[]);
});
test('backpressure coalesces changes, invalid samples fail closed and persisted sequence failure prevents sending',async()=>{
 const p=fixture(),sent=[];let release,seq=0;
 const publisher=new ProfilePublisher({source:{collect:async()=>structuredClone(p),subscribe:()=>()=>{}},nextSequence:async()=>++seq,
  publish:async v=>{sent.push(v);if(sent.length===1)await new Promise(r=>{release=r;});},onError:()=>{},every:()=>()=>{}});
 const started=publisher.start();await new Promise(setImmediate);
 const changes=Array.from({length:100},()=>publisher.changed());assert.equal(sent.length,1);
 p.ownerActivity.value='ACTIVE';release();await started;await Promise.all(changes);
 assert.equal(sent.length,2);assert.equal(sent[1].ownerActivity.value,'ACTIVE');await publisher.stop();
 for(const failSequence of [false,true]){
  let sends=0;const invalid=fixture();invalid.battery.value=-1;
  const bad=new ProfilePublisher({source:{collect:async()=>failSequence?p:invalid,subscribe:()=>()=>{}},
   nextSequence:async()=>{if(failSequence)throw Error('DISK_FAILED');return 1;},publish:async()=>{sends++;},onError:()=>{},every:()=>()=>{}});
  await assert.rejects(bad.start(),failSequence?/DISK_FAILED/:/PROFILE_INVALID/);assert.equal(sends,0);await bad.stop();
 }
});

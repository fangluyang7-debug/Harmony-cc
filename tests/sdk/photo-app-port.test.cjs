const {test}=require('node:test'),assert=require('node:assert/strict');
test('photo App bridge preserves SDK binary payloads and keeps records on the dedicated authenticated route',async()=>{
 const {nativePhotoClient}=await import('../../apps/team-space-web/photo-app-port.mjs'),calls=[];
 const data=Uint8Array.from([0,1,127,255]),bridge={request:async raw=>{const v=JSON.parse(raw);calls.push(v);return JSON.stringify(v.method==='GET'?{mime:'image/png',data:Buffer.from(data).toString('base64')}:{uploaded:true});},sdkRequest:async(r,b)=>{calls.push({r,b});return '{}';},sdkWrite:async(t,b)=>{calls.push({ticket:JSON.parse(t),bytes:Buffer.from(b,'base64')});},sdkRead:async()=>Buffer.from(data).toString('base64')};
 const client=nativePhotoClient(bridge,'g1',async()=> 'hash'),port=client.port(),ticket={ref:{artifactId:'artifact'}};
 await client.fetch('/v2/spaces/g1/photo-runs/r/input?image=0',{method:'PUT',body:data});assert.equal(calls[0].route,'/photo-runs/r/input?image=0');assert.deepEqual(Buffer.from(calls[0].data,'base64'),Buffer.from(data));
 await port.write(ticket,data);assert.deepEqual(calls[1].bytes,Buffer.from(data));assert.deepEqual(await port.read(ticket),data);
 await port.request('/v2/sdk/jobs','{}');assert.equal(calls[2].r,'/v2/sdk/jobs');
 await port.request('/v2/sdk/jobs/job',null);assert.equal(calls[3].b,'');
 await assert.rejects(client.fetch('/v2/spaces/other/photo-runs'),/PHOTO_ROUTE_INVALID/);
 assert.match(await client.input('/v2/spaces/g1/photo-runs/r/input?image=0'),/^data:image\/png;base64,/);
});
test('display capture precedes SDK received acknowledgment and rejects corrupt bytes',async()=>{
 const {retainPhotoOutput}=await import('../../apps/team-space-web/photo-app-port.mjs');const events=[],data=new Uint8Array([1,2]);let released=false;
 const port=retainPhotoOutput({read:async()=>{events.push('read');return data;},digest:async()=> 'hash'},async()=>{assert.equal(released,false);events.push('capture');});
 await port.read({bytes:2,ref:{contentHash:'hash'}});released=true;events.push('received');assert.deepEqual(events,['read','capture','received']);
 await assert.rejects(port.read({bytes:3,ref:{contentHash:'hash'}}),/SDK_OUTPUT_INTEGRITY/);assert.equal(events.filter(e=>e==='capture').length,1);
});

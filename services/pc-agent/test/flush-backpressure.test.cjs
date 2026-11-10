const {test}=require('node:test'),assert=require('node:assert/strict');
const {RecoveryClient}=require('../dist/recovery-client');
test('slow control pump coalesces wake-ups and leaves room for incoming acknowledgements',async()=>{
 const client=Object.create(RecoveryClient.prototype);client.work=Promise.resolve();client.onError=e=>{throw e;};let release,pumps=0,ack=false;
 client.pumpCurrent=async()=>{pumps++;if(pumps===1)await new Promise(r=>{release=r;});};
 const first=client.flush();await new Promise(setImmediate);
 for(let i=0;i<100;i++)client.flush();
 client.work=client.work.then(()=>{ack=true;});release();await first;await client.work;
 assert.equal(pumps,1);assert.equal(ack,true);await client.flush();assert.equal(pumps,2);
});

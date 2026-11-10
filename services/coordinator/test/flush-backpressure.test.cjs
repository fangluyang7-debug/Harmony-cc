const {test}=require('node:test'),assert=require('node:assert/strict');
const {ControlChannel}=require('../dist/channel');
test('coordinator coalesces slow flush requests instead of delaying inbound receipts',async()=>{
 const channel=Object.create(ControlChannel.prototype),session={work:Promise.resolve()};channel.sessions=new Set([session]);channel.track=p=>p;channel.reject=(_,e)=>{throw e;};let release,pumps=0,receipt=false;
 channel.pump=async()=>{pumps++;if(pumps===1)await new Promise(r=>{release=r;});};
 const first=channel.flush();await new Promise(setImmediate);const pending=Array.from({length:100},()=>channel.flush());
 session.work=session.work.then(()=>{receipt=true;});release();await first;await Promise.all(pending);await session.work;
 assert.equal(pumps,1);assert.equal(receipt,true);await channel.flush();assert.equal(pumps,2);
});

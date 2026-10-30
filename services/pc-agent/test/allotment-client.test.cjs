const {test}=require('node:test'),assert=require('node:assert/strict');
const {AllotmentClient}=require('../dist/allotment-client');
test('renewal persists origin before request, installs before ACK, and serializes concurrent callers',async()=>{
 const events=[];let release;
 const gate=new Promise(r=>release=r),grant={version:2};
 const ledger={requestGrant:id=>{events.push('origin');return {leaseRequestId:id,ledgerEpoch:1};},installGrant:g=>{assert.equal(g,grant);events.push('install');},acknowledgement:()=>{events.push('ack');return {ack:{occupied:[{resourcePoolId:'ram',amount:5}]},signature:'signed'};}};
 const client=new AllotmentClient(ledger,'token',async(route,body)=>{events.push(route);if(route.endsWith('request')){await gate;return grant;}assert.equal(body.ack.occupied[0].amount,5);return {acknowledged:true};},()=>({base:[],extra:[],leaseMs:100}),assert.fail);
 const first=client.renew();assert.equal(client.renew(),first);release();await first;
 assert.deepEqual(events,['origin','/v2/allotments/request','install','ack','/v2/allotments/ack']);await client.close();await assert.rejects(client.renew(),/STOPPED/);
});
test('failed request cannot install or acknowledge a grant; ACK failure retains installed state',async()=>{
 let installs=0,ackCalls=0,failRequest=true;
 const ledger={requestGrant:id=>({leaseRequestId:id,ledgerEpoch:1}),installGrant:()=>installs++,acknowledgement:()=>{ackCalls++;return {};}};
 const client=new AllotmentClient(ledger,'token',async route=>{if(failRequest)throw Error('OFFLINE');if(route.endsWith('ack'))throw Error('LOST_ACK');return {};},()=>({base:[],extra:[],leaseMs:100}),assert.fail);
 await assert.rejects(client.renew(),/OFFLINE/);assert.equal(installs,0);assert.equal(ackCalls,0);
 failRequest=false;await assert.rejects(client.renew(),/LOST_ACK/);assert.equal(installs,1);assert.equal(ackCalls,1);await client.close();
});

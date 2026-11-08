const {test}=require('node:test'),assert=require('node:assert/strict'),dgram=require('node:dgram');
const {advertiseCoordinator}=require('../dist/discovery');
test('discovery returns only an address hint, ignores unknown probes and closes its listener',async()=>{
 const reservation=dgram.createSocket('udp4');await new Promise(r=>reservation.bind(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 let serverError=false;const close=advertiseCoordinator('https://127.0.0.1:7443',()=>{serverError=true;},port),client=dgram.createSocket('udp4');
 try{
  await new Promise(r=>client.bind(0,'127.0.0.1',r));const received=[];client.on('message',b=>received.push(JSON.parse(b)));
  client.send('invalid probe',port,'127.0.0.1');await new Promise(r=>setTimeout(r,80));assert.deepEqual(received,[]);
  client.send('HARMONY_DISCOVER_V1\n',port,'127.0.0.1');const end=Date.now()+2000;while(!received.length&&Date.now()<end)await new Promise(r=>setTimeout(r,20));
  assert.equal(serverError,false);assert.deepEqual(received,[{version:1,service:'harmony-coordinator',address:'https://127.0.0.1:7443'}]);
 }finally{client.close();close();}
});

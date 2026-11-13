const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{transformSync}=require('esbuild');
function setup(fail=false){const sent=[],events={};let closed=false;const server={on:(name,fn)=>events[name]=fn,bind:async()=>{if(fail)throw Error('BIND_FAILED');},send:async message=>sent.push(message),close:async()=>{closed=true;}};
 const m={exports:{}};new Function('require','module','exports',transformSync(fs.readFileSync('apps/harmony/scheduler/src/main/ets/v2/coordinator/CoordinatorDiscovery.ets','utf8'),{loader:'ts',format:'cjs'}).code)(name=>name.includes('NativeTransport')?{monotonic:()=>performance.now()}:name.includes('NetworkKit')?{socket:{constructUDPSocketInstance:()=>server}}:{util:{TextDecoder:{create:()=>({decodeToString:b=>Buffer.from(b).toString()})}}},m,m.exports);
 return {host:new m.exports.CoordinatorDiscovery(),sent,closed:()=>closed,message:(text,address='192.168.1.2')=>events.message({message:Buffer.from(text),remoteInfo:{address,port:32100}})};
}
test('native discovery responds with the Windows wire format and rate limits repeated probes',async()=>{const s=setup();await s.host.start('https://192.168.1.4:7443');s.message('invalid');assert.equal(s.sent.length,0);s.message('HARMONY_DISCOVER_V1\n');assert.deepEqual(JSON.parse(s.sent[0].data),{version:1,service:'harmony-coordinator',address:'https://192.168.1.4:7443'});assert.equal(s.sent[0].address.port,32100);s.message('HARMONY_DISCOVER_V1\n');assert.equal(s.sent.length,1);s.message('HARMONY_DISCOVER_V1\n','192.168.1.3');assert.equal(s.sent.length,2);await s.host.close();assert.equal(s.closed(),true);});
test('failed discovery bind releases its socket',async()=>{const s=setup(true);await assert.rejects(s.host.start('https://192.168.1.4:7443'),/BIND_FAILED/);assert.equal(s.closed(),true);});

test('discovery rebinds after socket error and replies to a new scanner on the same device',async()=>{
 const sockets=[];let retry=null;const m={exports:{}};
 const socket={constructUDPSocketInstance:()=>{const s={events:{},sent:[],closed:false,on(n,f){this.events[n]=f;},async bind(){},async send(v){this.sent.push(v);},async close(){this.closed=true;}};sockets.push(s);return s;}};
 new Function('require','module','exports','setInterval','clearInterval',transformSync(fs.readFileSync('apps/harmony/scheduler/src/main/ets/v2/coordinator/CoordinatorDiscovery.ets','utf8'),{loader:'ts',format:'cjs'}).code)(name=>name.includes('NativeTransport')?{monotonic:()=>performance.now()}:name.includes('NetworkKit')?{socket}:{util:{TextDecoder:{create:()=>({decodeToString:b=>Buffer.from(b).toString()})}}},m,m.exports,f=>{retry=f;return 1;},()=>{retry=null;});
 const host=new m.exports.CoordinatorDiscovery();await host.start('https://192.168.1.4:7443');
 const message=port=>({message:Buffer.from('HARMONY_DISCOVER_V1\n'),remoteInfo:{address:'192.168.1.8',port}});
 sockets[0].events.message(message(1234));sockets[0].events.message(message(1235));assert.equal(sockets[0].sent.length,2);
 sockets[0].events.error();assert.equal(sockets[0].closed,true);retry();await new Promise(r=>setImmediate(r));
 assert.equal(sockets.length,2);sockets[1].events.message(message(1234));assert.equal(sockets[1].sent.length,1);
 await host.close();assert.equal(retry,null);assert.equal(sockets[1].closed,true);
});

const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{transformSync}=require('esbuild');
function load(){const cache=new Map();function read(file){file=path.resolve(file);if(cache.has(file))return cache.get(file);const m={exports:{}};new Function('require','module','exports',transformSync(fs.readFileSync(file,'utf8'),{loader:'ts',format:'cjs'}).code)(name=>name.includes('ArkTS')?{util:{TextDecoder:{create:()=>({decodeToString:b=>Buffer.from(b).toString()})},TextEncoder:class{encodeInto(s){return new Uint8Array(Buffer.from(s))}}}}:name.startsWith('.')?read(path.join(path.dirname(file),name+'.ets')):{},m,m.exports);cache.set(file,m.exports);return m.exports;}return read('apps/harmony/scheduler/src/main/ets/v2/coordinator/CoordinatorSocket.ets').CoordinatorSocket;}
function frame(op,value){const b=Buffer.from(value),mask=Buffer.from([1,2,3,4]);return Buffer.concat([Buffer.from([128|op,128|b.length]),mask,Buffer.from(b.map((v,i)=>v^mask[i%4]))]);}
const turn=()=>new Promise(r=>setImmediate(r));
test('native Pong bypasses stalled durable messages while text order and errors remain enforced',async()=>{
 const sent=[],s=new (load())({clientId:1,send:async b=>sent.push(Buffer.from(b))}),events=[];let release;
 s.onText=async text=>{events.push('start:'+text);if(text==='slow')await new Promise(r=>release=r);events.push('end:'+text);};s.onPong=p=>events.push('pong:'+p);
 await s.receive(frame(1,'slow'));await turn();await s.receive(Buffer.concat([frame(1,'next'),frame(10,'alive')]));
 assert.deepEqual(events,['start:slow','pong:alive'],'slow DB work must not masquerade as device heartbeat failure');
 release();await turn();assert.deepEqual(events,['start:slow','pong:alive','end:slow','start:next','end:next']);
 s.onText=async()=>{throw Error('ENVELOPE_INVALID');};await s.receive(frame(1,'invalid'));await turn();assert.equal(s.isOpen(),false);assert.equal(sent.at(-1)[0]&15,8);
});
test('native control queue remains bounded under a stalled consumer',async()=>{
 const s=new (load())({clientId:1,send:async()=>{}});let release;s.onText=async()=>{await new Promise(r=>release=r);};
 await s.receive(frame(1,'first'));await turn();for(let i=0;i<63;i++)await s.receive(frame(1,'queued'));await assert.rejects(s.receive(frame(1,'overflow')),/BACKPRESSURE/);s.disconnected();release();await turn();
});

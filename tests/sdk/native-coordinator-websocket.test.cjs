const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{transformSync}=require('esbuild');
const m={exports:{}};new Function('module','exports',transformSync(fs.readFileSync('apps/harmony/scheduler/src/main/ets/v2/coordinator/CoordinatorWebSocket.ets','utf8'),{loader:'ts',format:'cjs'}).code)(m,m.exports);const {CoordinatorWebSocketParser:Parser,coordinatorWsFrame:encode}=m.exports;
function masked(op,body,final=true){const data=Buffer.from(body),mask=Buffer.from([1,2,3,4]);return Buffer.concat([Buffer.from([(final?128:0)|op,128|data.length]),mask,Buffer.from(data.map((n,i)=>n^mask[i%4]))]);}
test('masked fragmented message survives fragmented transport and interleaved ping',()=>{
 const p=new Parser(),wire=Buffer.concat([masked(1,'hello ',false),masked(9,'ping'),masked(0,'world')]),out=[];
 for(const byte of wire)out.push(...p.push(Buffer.from([byte])));
 assert.deepEqual(out.map(f=>[f.opcode,Buffer.from(f.payload).toString()]),[[9,'ping'],[1,'hello world']]);
});
test('unmasked clients, stray continuations and fragmented control frames fail',()=>{
 assert.throws(()=>new Parser().push(encode(1,Buffer.from('x'))),/INVALID/);
 assert.throws(()=>new Parser().push(masked(0,'x')),/CONTINUATION/);
 assert.throws(()=>new Parser().push(masked(9,'x',false)),/CONTROL/);
});
test('server frames use correct large-length encoding',()=>{const frame=encode(2,Buffer.alloc(65536));assert.equal(frame[1],127);assert.equal(Buffer.from(frame).readBigUInt64BE(2),65536n);assert.equal(frame.length,65546);});

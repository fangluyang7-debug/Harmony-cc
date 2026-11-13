const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{transformSync}=require('esbuild');
const m={exports:{}};new Function('module','exports',transformSync(fs.readFileSync('apps/harmony/scheduler/src/main/ets/v2/coordinator/CoordinatorHttpParser.ets','utf8'),{loader:'ts',format:'cjs'}).code)(m,m.exports);const Parser=m.exports.CoordinatorHttpParser;
test('HTTP framing waits for fragmented UTF-8 bodies and retains bearer header',()=>{
 const p=new Parser(),body=Buffer.from('{"text":"商品"}'),head=Buffer.from('POST /v2/jobs HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer token\r\nContent-Length: '+body.length+'\r\n\r\n'),wire=Buffer.concat([head,body]);
 for(let i=0;i<wire.length-1;i++)assert.equal(p.push(wire.subarray(i,i+1)),null);
 const result=p.push(wire.subarray(-1));assert.equal(result.authorization,'Bearer token');assert.equal(Buffer.from(result.body).toString(),body.toString());
});
test('ambiguous HTTP framing and oversized headers are rejected',()=>{
 for(const headers of ['Content-Length: 0\r\nContent-Length: 0','Transfer-Encoding: chunked','Content-Length: -1'])assert.throws(()=>new Parser().push(Buffer.from('POST / HTTP/1.1\r\n'+headers+'\r\n\r\n')));
 assert.throws(()=>new Parser().push(Buffer.alloc(16385,65)),/HEADERS_TOO_LARGE/);
 assert.throws(()=>new Parser().push(Buffer.from('GET / HTTP/1.1\r\n\r\nextra')),/PIPELINING/);
});

 test('fragmented multi-megabyte uploads allocate the body once and reject trailing data',()=>{
 const size=4*1024*1024,body=Buffer.alloc(size,173),header=Buffer.from('PUT /v2/artifacts/photo/1 HTTP/1.1\r\nContent-Length: '+size+'\r\n\r\n');
 const Native=global.Uint8Array;let allocated=0;global.Uint8Array=new Proxy(Native,{construct(target,args){if(typeof args[0]==='number')allocated+=args[0];return new target(...args);}});
 let parser,result;try{parser=new Parser();assert.equal(parser.push(header),null);for(let i=0;i<size;i+=1024)result=parser.push(body.subarray(i,i+1024));}finally{global.Uint8Array=Native;}
 assert.deepEqual(Buffer.from(result.body),body);assert.ok(allocated<=size+20000,'allocation stays linear instead of copying each accumulated prefix');assert.throws(()=>parser.push(Buffer.from('x')),/PIPELINING/);
 });

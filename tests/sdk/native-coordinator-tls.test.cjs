const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{transformSync}=require('esbuild');
function load(native){const cache=new Map();function read(file){file=path.resolve(file);if(cache.has(file))return cache.get(file);const m={exports:{}};new Function('require','module','exports',transformSync(fs.readFileSync(file,'utf8'),{loader:'ts',format:'cjs'}).code)(name=>{if(name==='libharmony_coordinator_tls.so')return native;if(name.includes('ArkTS'))return {util:{TextEncoder:class{encodeInto(s){return new Uint8Array(Buffer.from(s))}},TextDecoder:{create:()=>({decodeToString:b=>Buffer.from(b).toString()})}}};if(name.includes('Performance'))return {hilog:{error(){}}};if(name.startsWith('.'))return read(path.join(path.dirname(file),name+'.ets'));return {};},m,m.exports);cache.set(file,m.exports);return m.exports;}return read('apps/harmony/scheduler/src/main/ets/v2/coordinator/CoordinatorTlsServer.ets').CoordinatorTlsServer;}
test('native TLS adapter preserves fragmented binary HTTP bodies above the platform 8 KiB crash boundary',async()=>{
 let callback,stopped=false;const sent=[];
 const native={start:(_cert,_key,_port,cb)=>{callback=cb},send:(clientId,data,requestId)=>{sent.push(Buffer.from(data));queueMicrotask(()=>callback({type:'sent',clientId,requestId}));},closeClient:clientId=>queueMicrotask(()=>callback({type:'close',clientId})),stop:()=>{stopped=true}};
 const server=new (load(native))();let request;
 await server.start({certificate:'cert',privateKey:'key'},7443,async value=>{request=value;return {status:200,body:'{}'}});
 callback({type:'connect',clientId:1,remoteAddress:'192.168.1.2'});
 const data=Buffer.alloc(32768,120);data[8191]=0;data[16000]=255;
 const raw=Buffer.concat([Buffer.from('POST /v2/test HTTP/1.1\r\nContent-Length: '+data.length+'\r\n\r\n'),data]);
 for(let n=0;n<raw.length;n+=4096)callback({type:'data',clientId:1,data:Uint8Array.from(raw.subarray(n,n+4096)).buffer});
 for(let n=0;n<5;n++)await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(Buffer.from(request.body),data);assert.equal(request.remoteAddress,'192.168.1.2');assert.match(sent[0].toString(),/^HTTP\/1.1 200/);
 await server.close();assert.equal(stopped,true);
});

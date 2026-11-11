const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto'),{transformSync}=require('esbuild');
const bytes=t=>Buffer.from(t),text=b=>Buffer.from(b).toString(),hash=b=>crypto.createHash('sha256').update(b).digest('hex'),base64={encodeToStringSync:b=>Buffer.from(b).toString('base64')};
function runner(executePhoto){const code=transformSync(fs.readFileSync('apps/harmony/scheduler/src/main/ets/v2/host/executors/PhotoLocal.ets','utf8'),{loader:'ts',format:'cjs'}).code,m={exports:{}};new Function('require','module','exports',code)(name=>name==='./Photo'?{executePhoto}:{bytes,text,hash,base64},m,m.exports);return m.exports.enhancePhotoLocally;}
test('offline photo pipeline keeps collaborative tile geometry, bounds parallel inference and needs no registration/network',async()=>{
 const {tilePlan}=await import('../../apps/team-space-web/photo-workflow.mjs');let active=0,max=0;const calls=[],progress=[];
 const run=runner(async(cap,r)=>{calls.push({cap,parameters:JSON.parse(r.parameters)});let data;
  if(cap==='photo.analyze.v1')data=bytes('{"width":192,"height":128}');
  else if(cap==='photo.enhance.v1'){active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,5));active--;data=r.input;}
  else if(cap==='photo.assemble.v1'){const bundle=JSON.parse(text(r.input));assert.equal(bundle.parts.length,4);assert.equal(new Set(bundle.parts.map(p=>p.nodeId)).size,4);for(const p of bundle.parts){assert.equal(p.contentHash,hash(Buffer.from(p.data,'base64')));}data=bytes('assembled');}
  else data=bytes(JSON.stringify({parameters:r.parameters}));
  return {data,schemaId:cap};
 });
 await run({},bytes('input'),{cancelled:()=>false,progress:p=>progress.push(p)});
 assert.deepEqual(calls.filter(c=>c.cap==='photo.prepare.v1').map(c=>c.parameters),tilePlan(192,128).tiles);
 assert.equal(calls.length,11);assert.equal(max,2);assert.equal(active,0);assert.equal(progress.at(-1).completed,11);assert.equal(progress.at(-1).total,11);
 assert.deepEqual(calls.at(-1).parameters,{width:768,height:512});
});
test('offline cancellation waits for admitted inference siblings and does not assemble incomplete tiles',async()=>{
 let active=0,completed=0,cancel=false,assembled=false;
 const run=runner(async(cap,r)=>{
  if(cap==='photo.analyze.v1')return {data:bytes('{"width":192,"height":128}'),schemaId:'source'};
  if(cap==='photo.enhance.v1'){active++;await new Promise(r=>setTimeout(r,10));active--;completed++;cancel=true;throw Error('CANCELLED_SETTLED');}
  if(cap==='photo.assemble.v1')assembled=true;
  return {data:r.input,schemaId:'tile'};
 });
 await assert.rejects(run({},bytes('input'),{cancelled:()=>cancel,progress:()=>{}}),/CANCELLED_SETTLED/);
 assert.equal(active,0);assert.equal(completed,2);assert.equal(assembled,false);
});

test('parallel first-use tiles share model preparation; failed preparation can be retried',async()=>{
 const files=new Map(),opens=new Map();let serial=0,copies=0,fail=true;
 const param='35330ececcea33b6c397a72548e788d5d53becee4734c50b7fada36e89f10a86',weights='713ee713b0353afaa27976f0563a64a5043bd70b9bd8936c2e26e25ebcdbcddf';
 const fileIo={OpenMode:{CREATE:1,WRITE_ONLY:2,TRUNC:4,READ_ONLY:0},accessSync:p=>files.has(p),openSync:p=>{const fd=++serial;opens.set(fd,p);return {fd};},closeSync:()=>{},writeSync:(fd,b)=>{copies++;files.set(opens.get(fd),Buffer.from(b));},statSync:fd=>({size:files.get(opens.get(fd)).length}),readSync:(fd,b)=>new Uint8Array(b).set(files.get(opens.get(fd)))};
 const code=transformSync(fs.readFileSync('apps/harmony/scheduler/src/main/ets/v2/host/executors/Photo.ets','utf8')+'\nexport {prepareModel};',{loader:'ts',format:'cjs'}).code,m={exports:{}};
 new Function('require','module','exports',code)(name=>name==='@kit.CoreFileKit'?{fileIo}:name==='../NativePlatform'?{hash:b=>text(b)==='param'?param:text(b)==='bin'?weights:'invalid'}:{},m,m.exports);
 const r={context:{filesDir:'/private',resourceManager:{getRawFileContent:async name=>{await new Promise(r=>setTimeout(r,5));if(fail)throw Error('resource unavailable');return new Uint8Array(bytes(name.endsWith('param')?'param':'bin'));}}}};
 await assert.rejects(m.exports.prepareModel(r),/resource unavailable/);fail=false;
 assert.deepEqual(await Promise.all([m.exports.prepareModel(r),m.exports.prepareModel(r)]),['/private/realesrgan-x4plus','/private/realesrgan-x4plus']);
 assert.equal(copies,2,'each model asset is written once, not once per admitted tile');
 await m.exports.prepareModel(r);assert.equal(copies,2);
});

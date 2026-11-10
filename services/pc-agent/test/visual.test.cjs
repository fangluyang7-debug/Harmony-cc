const {test}=require('node:test'),assert=require('node:assert/strict');
const {execute}=require('../dist/executors/visual'),{executeCpu}=require('../dist/cpu-engine');
const {builtinCpuPacks,validateCoverage}=require('@harmony/reference-capabilities');
const {encodeGraph,allPairs,partitionPairs,mergeGraph}=require('../../../scripts/lib/visual-input.cjs');
test('exact distance pruning cannot discard a better match (independent scalar oracle)',()=>{
 const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
 const directory=path.resolve(__dirname,'../../../.test/visual-distance');fs.mkdirSync(directory,{recursive:true});
 const binary=path.join(directory,process.platform==='win32'?'test.exe':'test');
 execFileSync(process.env.CXX||'g++',['-O3','-std=c++17',...(process.platform==='win32'?['-static-libgcc','-static-libstdc++']:[]),path.resolve(__dirname,'../native/visual-distance-test.cpp'),'-o',binary],{windowsHide:true});
 execFileSync(binary,[],{windowsHide:true,timeout:15000});
});
test('gallery tiling covers 435 distinct pairs once and transports only the referenced images',()=>{
 const images=Array.from({length:30},(_,i)=>({id:'p'+i,width:32,height:32,rgb:Buffer.alloc(3072,i)})),batches=partitionPairs(images,64);
 assert.equal(batches.flat().length,435);assert.equal(new Set(batches.flat().map(p=>p.join(':'))).size,435);
 for(const batch of batches){assert.ok(batch.length<=64);const bytes=encodeGraph(images,batch),raw=require('node:zlib').inflateSync(bytes.subarray(8));assert.equal(raw.readUInt32LE(0),new Set(batch.flat()).size);assert.ok(raw.readUInt32LE(0)<=16);}
});
test('Windows Electron host loads the same native binary without importing node.exe', {skip:process.platform!=='win32'},()=>{
 const {spawnSync}=require('node:child_process'),path=require('node:path');
 const binary=path.resolve(__dirname,'../dist/visual.node');
 const child=spawnSync(require('electron'),['-e','const v=require(process.argv[1]);try{v.match(Buffer.from("bad"));process.exitCode=2;}catch(e){if(e.message!=="VISUAL_INVALID")throw e;console.log("NAPI_OK");}',binary],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},encoding:'utf8',timeout:15000,windowsHide:true});
 assert.equal(child.status,0,child.stderr);assert.match(child.stdout,/NAPI_OK/);
});
test('visual native executor passes independent known texture, uniform, size, count and rejection references',async()=>{
 const pack=builtinCpuPacks().find(p=>p.manifest.packId==='image.visual-match.v1');validateCoverage(pack.manifest,pack.cases);
 for(const c of pack.cases){if(c.expect.kind==='REJECT')await assert.rejects(execute(c.input,{},c.config),{message:c.expect.errorCode});else{const r=await execute(c.input,{},c.config);assert.equal(r.schemaId,'image.visual-evidence');assert.equal(await pack.evaluate(c,r.output),1,c.id);}}
});
test('visual graph computes every unordered pair once regardless of partitioning and rejects missing/duplicate evidence',async()=>{
 const images=Array.from({length:7},(_,n)=>({id:'im'+n,width:32,height:32,rgb:Buffer.from(Array.from({length:32*32*3},(_,i)=>(Math.floor(i/3)*17+n*61)%256))}));
 const whole=JSON.parse((await execute(encodeGraph(images,allPairs(images.length)),{},{})).output),parts=[];
 for(const pairs of partitionPairs(images,4))parts.push(JSON.parse((await execute(encodeGraph(images,pairs),{},{})).output));
 assert.deepEqual(mergeGraph(images.map(i=>i.id),parts),whole.pairs);assert.equal(whole.pairs.length,21);assert.throws(()=>mergeGraph(images.map(i=>i.id),parts.slice(1)),/INCOMPLETE/);assert.throws(()=>mergeGraph(images.map(i=>i.id),parts.concat(parts[0])),/INVALID/);
 // Compare nontrivial gradients against a separately expressed 32x32 oracle.
 function feature(im){const grey=Array.from({length:1024},(_,i)=>Math.floor((77*im.rgb[i*3]+150*im.rgb[i*3+1]+29*im.rgb[i*3+2]+128)/256)),bins=Array(128).fill(0);for(let y=1;y<31;y++)for(let x=1;x<31;x++){let dx=grey[y*32+x+1]-grey[y*32+x-1],dy=grey[(y+1)*32+x]-grey[(y-1)*32+x],ax=Math.abs(dx),ay=Math.abs(dy);let bin=dy>=0?(dx>=0?(ax>=ay?0:1):(ay>=ax?2:3)):(dx<0?(ax>=ay?4:5):(ay>=ax?6:7));bins[(Math.floor(y/8)*4+Math.floor(x/8))*8+bin]+=ax+ay;}const norm=Math.floor(Math.sqrt(bins.reduce((s,v)=>s+v*v,0)));return bins.map(v=>Math.min(255,Math.floor((v*512+Math.floor(norm/2))/norm)));}
 const a=feature(images[0]),b=feature(images[1]),distance=a.reduce((s,v,i)=>s+(v-b[i])**2,0);assert.equal(whole.pairs[0].textureMillion,1000000-Math.floor(2*Math.min(524288,distance)*1000000/1048576));
});
test('visual CPU cancellation terminates the owned compute process',async()=>{
 const im={id:'a',width:512,height:512,rgb:Buffer.from(Array.from({length:512*512*3},(_,i)=>(i*17+(i>>8))%256))},images=Array.from({length:8},(_,i)=>({...im,id:'p'+i})),controller=new AbortController();
 const task=executeCpu('image.visual-match.v1',encodeGraph(images,allPairs(8)),{}, {id:'standard',threads:1,batchSize:1,quality:'standard'},controller.signal);const timer=setTimeout(()=>controller.abort(),500);try{await assert.rejects(task,/CANCELLED_SETTLED/);}finally{clearTimeout(timer);}
});

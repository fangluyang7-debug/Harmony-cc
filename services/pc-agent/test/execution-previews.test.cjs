const {test}=require('node:test'),assert=require('node:assert/strict'),sharp=require('sharp'),crypto=require('node:crypto');
const {tilePreviews}=require('../dist/execution-preview-worker'),{ExecutionPreviews}=require('../dist/execution-previews');
const {ExecutionPreviewCache}=require('../../../scripts/execution-preview-cache.cjs');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
async function sample(){const before=await sharp({create:{width:112,height:80,channels:3,background:'#d86528'}}).png().toBuffer(),after=await sharp({create:{width:384,height:256,channels:3,background:'#125ed2'}}).png().toBuffer();
 const a={stage:'prepared',width:192,height:128,rect:{x:0,y:0,width:96,height:64},crop:{left:0,top:0,width:384,height:256},image:before.toString('base64'),hash:hash(before)};
 const b={...a,stage:'enhanced',scale:4,backend:'VULKAN',image:after.toString('base64'),hash:hash(after)};
 return {input:Buffer.from(JSON.stringify(a)),output:Buffer.from(JSON.stringify(b)),hash:b.hash};}
test('preview comes from actual input/output bytes, crops halo, and never substitutes a finished image',async()=>{
 const s=await sample(),p=await tilePreviews(s.input,s.output);assert.equal(p.outputHash,s.hash);assert.equal(p.outputWidth,384);assert.equal(p.outputHeight,256);assert.deepEqual(p.region,{x:0,y:0,width:96,height:64});
 assert.equal(p.input.width,96);assert.equal(p.output.width,256);assert.equal(p.output.height,171);
 const pixel=await sharp(Buffer.from(p.output.image,'base64')).raw().toBuffer();assert.ok(pixel[2]>150&&pixel[0]<40,'preview is output blue, not the orange input');
 const invalid=JSON.parse(s.output);invalid.hash='0'.repeat(64);await assert.rejects(tilePreviews(s.input,Buffer.from(JSON.stringify(invalid))),/HASH/);
});
test('no viewer means zero capture; active preview is deferred, bounded, and uses a child process',async t=>{
 const s=await sample(),events=[],published=[];const v=new ExecutionPreviews(id=>id!=='reference',(id,p)=>events.push({id,...p}),(id,p)=>published.push({id,p}));t.after(()=>v.close());
 assert.equal(v.capture('off',s.input,s.output),undefined);assert.equal(v.queue.length,0);assert.equal(v.child,null);
 v.interest();v.capture('reference',s.input,s.output);assert.equal(v.queue.length,0);
 const begin=performance.now();for(let i=0;i<40;i++)assert.equal(v.capture('tile-'+i,s.input,s.output),undefined);const captureMs=performance.now()-begin;
 assert.equal(v.queue.length,4);assert.equal(v.child,null,'generation cannot run inline before yielding');assert.equal(published.length,0);
 for(let i=0;i<100&&published.length<4;i++)await new Promise(r=>setTimeout(r,30));
 assert.equal(published.length,4);assert.ok(v.child.pid&&v.child.pid!==process.pid);assert.equal(events.filter(e=>e.state==='SKIPPED').length,36);
 assert.ok(published.every(x=>x.p.outputHash===s.hash));console.log('PREVIEW_CAPTURE_40_CALLS_MS',captureMs.toFixed(3));
});
test('thumbnail cache caps memory and rejects malformed thumbnails, status contains only IDs',async()=>{
 const s=await sample(),p=await tilePreviews(s.input,s.output),cache=new ExecutionPreviewCache();
 assert.equal(cache.put('../bad',p),false);assert.equal(cache.put('bad',{input:{image:'xx'},output:{}}),false);
 for(let i=0;i<100;i++)assert.equal(cache.put('tile-'+i,p),true);
 assert.equal(cache.ids().length,32);assert.equal(cache.get('tile-0','output'),undefined);assert.ok(Buffer.isBuffer(cache.get('tile-99','output')));
 assert.ok(JSON.stringify(cache.ids()).length<512);
});

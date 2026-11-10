const {test}=require('node:test'),assert=require('node:assert/strict'),{modes,workload}=require('./benchmark-device-scaling.cjs');
test('scaling covers every single, pair and trio without silently removing the fastest baseline',()=>{
 const sets=modes(['A','B','C'].map(name=>({name})));assert.deepEqual(sets.map(m=>m.name),['A','B','C','A+B','A+C','B+C','A+B+C']);
 assert.deepEqual(sets.map(m=>m.targets.length),[1,1,1,2,2,2,3]);
});
test('render workload covers the canvas once and assembly preserves each tile position',async()=>{
 const w=await workload('render',{iterations:8}),outputs=new Map(),occupied=new Set();
 for(const [i,d] of w.documents.entries()){
  const r=d.region;assert.ok(!occupied.has(r.offsetX+','+r.offsetY));occupied.add(r.offsetX+','+r.offsetY);
  const b=require('@harmony/reference-capabilities').referenceFractal(r);await d.verify(b);
  const changed=Buffer.from(b);changed[12]^=1;await assert.rejects(d.verify(changed),/RENDER_PIXEL_MISMATCH/);
  // Deliberately distinct solid tiles make offset and row-stride bugs visible.
  b.fill(i+1,12);outputs.set(i,b);
 }
 assert.equal(w.documents.length*512*512,w.canvasWidth*w.canvasHeight);
 const raw=await require('sharp')(await w.assemble(outputs)).raw().toBuffer();
 for(const [i,d] of w.documents.entries())for(const [x,y] of [[0,0],[511,511]]){
  const offset=((d.region.offsetY+y)*w.canvasWidth+d.region.offsetX+x)*3;
  assert.deepEqual([...raw.subarray(offset,offset+3)],[i+1,i+1,i+1]);
 }
});
test('document workload has independent expected counts and rejects a wrong result',async()=>{
 const w=await workload('text'),text=JSON.parse(w.bytes).text;
 await w.verify(Buffer.from(JSON.stringify({characters:text.length,words:text.match(/\S+/g).length,lines:text.split('\n').length})));
 await assert.rejects(w.verify(Buffer.from('{"characters":0,"words":0,"lines":0}')));
});

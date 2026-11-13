const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{transformSync}=require('esbuild');
function load(){const m={exports:{}};new Function('module','exports',transformSync(fs.readFileSync('apps/harmony-photo/entry/src/main/ets/PhotoTilePlan.ets','utf8'),{loader:'ts',format:'cjs'}).code)(m,m.exports);return m.exports;}
test('full resolution tile plans cover camera pixels exactly once with original-coordinate overlap',()=>{
 const {photoTiles}=load();for(const [w,h] of [[192,128],[4000,3000],[3072,4096],[8192,6144],[257,513],[1,3000]]){
  const ts=photoTiles(w,h);assert.equal(ts.reduce((s,t)=>s+t.width*t.height,0),w*h);assert.equal(ts.length,Math.ceil(w/256)*Math.ceil(h/256));
  for(const t of ts){assert.equal(t.x,t.index%Math.ceil(w/256)*256);assert.equal(t.y,Math.floor(t.index/Math.ceil(w/256))*256);assert.ok(t.inputWidth<=288&&t.inputHeight<=288);assert.ok(t.left<=t.x&&t.top<=t.y);assert.ok(t.left+t.inputWidth<=w&&t.top+t.inputHeight<=h);assert.ok((t.x-t.left+t.width)*4<=t.inputWidth*4);}
 }
 assert.deepEqual(photoTiles(192,128)[0],{index:0,x:0,y:0,width:192,height:128,left:0,top:0,inputWidth:192,inputHeight:128});
});

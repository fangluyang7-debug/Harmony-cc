const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{createHash}=require('node:crypto'),{transformSync}=require('esbuild');
test('native input store reads multi-megabyte image bundles through bounded RDB windows and checks integrity',async()=>{
 const data=Buffer.alloc(3*1024*1024+17,91),hash=b=>createHash('sha256').update(b).digest('hex'),digest=hash(data);let corrupt=false,max=0;
 const db={querySql:async(sql,args)=>{const length=sql.includes('length(data)'),slice=length?null:data.subarray(args[0]-1,args[0]-1+131072);if(slice)max=Math.max(max,slice.length);return {rowCount:1,goToFirstRow:()=>true,getLong:()=>data.length,getBlob:()=>{const copy=Uint8Array.from(slice);if(corrupt)copy[0]^=1;return copy;},close(){}};}};
 const code=transformSync(fs.readFileSync('apps/harmony/scheduler/src/main/ets/v2/platform/NativeInputStore.ets','utf8'),{loader:'ts',format:'cjs'}).code,m={exports:{}};
 new Function('require','module','exports',code)(name=>name==='./NativeTransport'?{hash}:{},m,m.exports);
 const store=new m.exports.NativeInputStore(db);assert.deepEqual(Buffer.from(await store.read(digest)),data);assert.ok(max<=131072);corrupt=true;await assert.rejects(store.read(digest),/INPUT_HASH/);
});

const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {execute}=require('../dist/executors/catalog');
const {filterCatalog}=require('../dist/executors/catalog-kernel');
const {builtinCpuPacks,validateCoverage}=require('@harmony/reference-capabilities');
test('catalog executor passes independent boundary, currency, budget and ordering cases',async()=>{
 const pack=builtinCpuPacks().find(p=>p.manifest.packId==='catalog.filter.v1');
 validateCoverage(pack.manifest,pack.cases);
 for(const c of pack.cases)assert.ok(c.maxOutputBytes<=require('@harmony/resource-transport').evaluationOutputLimit,'reference case must fit the calibration transport');
 for(const c of pack.cases){if(c.expect.kind==='REJECT')await assert.rejects(execute(c.input,{},c.config),{message:c.expect.errorCode});else{const r=await execute(c.input,{},c.config);assert.equal(r.schemaId,'catalog.ranked');assert.equal(await pack.evaluate(c,r.output),1);}}
});
test('partitioning preserves all eligible IDs and global price order without duplicated work',()=>{
 const items=Array.from({length:137},(_,i)=>({id:'item-'+i,price:((i*137)%70000/100).toFixed(2),currency:i%9?'CNY':'USD',rank:i}));
 const parts=[0,1,2].map(s=>filterCatalog({currency:'CNY',maxPriceMinor:50000,items:items.filter((_,i)=>i%3===s)}));
 const actual=parts.flatMap(p=>p.items).sort((a,b)=>a.priceMinor-b.priceMinor||a.rank-b.rank);
 const expected=items.filter(i=>i.currency==='CNY'&&Number(i.price)<=500).sort((a,b)=>Number(a.price)-Number(b.price)||a.rank-b.rank).map(i=>i.id);
 assert.deepEqual(actual.map(i=>i.id),expected);assert.equal(parts.reduce((s,p)=>s+p.scanned,0),items.length);assert.equal(new Set(actual.map(i=>i.id)).size,actual.length);
});
test('native and PC use the identical pure catalog kernel',()=>{
 assert.equal(fs.readFileSync('src/executors/catalog-kernel.ts','utf8'),fs.readFileSync('../../apps/harmony/scheduler/src/main/ets/v2/host/executors/CatalogKernel.ets','utf8'));
});

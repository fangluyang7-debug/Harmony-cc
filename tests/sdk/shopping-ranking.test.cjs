const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{transformSync}=require('esbuild');
const {filterCatalog}=require('../../services/pc-agent/dist/executors/catalog-kernel');
function load(sdk){const m={exports:{}},code=transformSync(fs.readFileSync('apps/harmony/entry/src/main/ets/services/ShoppingBusinessCompute.ets','utf8'),{loader:'ts',format:'cjs'}).code;
 new Function('require','module','exports',code)(name=>name==='./CooperativeSession'?{cooperative:{availableClient:async()=>sdk}}:name==='@kit.ArkTS'?{util:{generateRandomUUID:()=>require('node:crypto').randomUUID()}}:{bytes:s=>Buffer.from(s),text:b=>Buffer.from(b).toString(),monotonic:()=>performance.now()},m,m.exports);return m.exports.shoppingBusiness;}
test('ordinary product ranking submits actual prices without pinning a device and records trace',async()=>{
 let payload,released=0,submitted;
 const sdk={registerInput:async(data,schema)=>{assert.equal(schema,'catalog.items');payload=JSON.parse(data);return {id:'input'};},releaseInput:()=>released++,submit:async workflow=>{submitted=workflow;return {cancel:async()=>{},result:async()=>({output:Buffer.from(JSON.stringify(filterCatalog(payload))),status:{deviceId:'remote-pc',traceId:'trace',state:'SUCCEEDED'}})};}};
 const products=[{price:'20',currency:'CNY'},{price:'10.50',currency:'CNY'}],audit={taskId:'phone-123',jobs:[],jobIds:[],traceIds:[],actualDevices:[]};
 await load(sdk).rankProducts(products,{isCancellationRequested:false},performance.now()+30000,audit);
 assert.deepEqual(products.map(p=>p.comparisonRank),[1,0]);assert.equal(submitted.nodes[0].targetId,undefined);assert.ok(submitted.id.startsWith('phone-123-'));assert.deepEqual(audit.actualDevices,['remote-pc']);assert.deepEqual(audit.traceIds,['trace']);assert.equal(released,1);
});
test('invalid business prices are not silently changed to make a task schedulable',async()=>{
 const sdk={registerInput:()=>{throw Error('must not submit');}},audit={};
 await load(sdk).rankProducts([{price:'面议',currency:'CNY'}],{isCancellationRequested:false},performance.now()+1000,audit);
 assert.equal(audit.reason,'PRICE_FORMAT_REQUIRES_BUSINESS_HANDLING');
});

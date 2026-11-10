const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),zlib=require('node:zlib');
const {transformSync}=require('esbuild'),{performance}=require('node:perf_hooks');
const review=require('../../scripts/lib/visual-review-core.cjs');
const {execute}=require('../../services/pc-agent/dist/executors/visual');
function load(){const code=transformSync(fs.readFileSync('apps/harmony/entry/src/main/ets/services/ShoppingComputeFlow.ets','utf8'),{loader:'ts',format:'cjs'}).code,m={exports:{}};new Function('require','module','exports',code)(()=>review,m,m.exports);return m.exports;}
const {shoppingDecision,shoppingPairs,matchShoppingPhoto}=load();
const images=Array.from({length:18},(_,n)=>({id:n?'p'+(n-1):'query',width:32,height:32,rgb:Uint8Array.from({length:3072},(_,i)=>(i*13+n*17)%256)}));
function pack(raw){const header=Buffer.alloc(8);header.write('HVG1');header.writeUInt32LE(raw.length,4);return Buffer.concat([header,zlib.deflateSync(raw)]);}
function port(){return {sdk:null,originTarget:null,originDevice:'fixture-phone',localConcurrency:2,now:()=>performance.now(),id:()=>crypto.randomUUID(),encode:s=>Buffer.from(s),decode:b=>Buffer.from(b).toString(),pack:async raw=>pack(raw),local:async data=>(await execute(Buffer.from(data),{},{})).output,cancelled:()=>false,deadline:performance.now()+30000};}
test('unknown, light, single-part and no-capacity cases do not force cooperation',()=>{
 assert.equal(shoppingDecision(4,null).collaborate,false);
 assert.equal(shoppingDecision(4,{localMs:0,dispatchRoundTripMs:1,remoteAvailable:true}).reason,'COST_UNKNOWN');
 assert.equal(shoppingDecision(4,{localMs:100,dispatchRoundTripMs:10,remoteAvailable:true}).collaborate,false);
 assert.equal(shoppingDecision(1,{localMs:10000,dispatchRoundTripMs:1,remoteAvailable:true}).collaborate,false);
 assert.equal(shoppingDecision(4,{localMs:10000,dispatchRoundTripMs:10,remoteAvailable:true}).collaborate,true);
});
test('normal photo work compares only the query with every candidate once',()=>{
 const pairs=shoppingPairs(31).flat();assert.equal(pairs.length,30);assert.equal(new Set(pairs.map(p=>p.join(':'))).size,30);assert.ok(pairs.every(p=>p[0]===0&&p[1]>0));
 assert.throws(()=>shoppingPairs(33));
});
test('local native and SDK adapter outputs are identical, same fresh inputs and budgets, with source affinity only on first shard',async()=>{
 const local=await matchShoppingPhoto(images,port(),null),p=port(),inputs=new Map(),submissions=[];let released=0;
 p.originTarget='fixture-source';p.sdk={
  registerInput:async data=>{const key=require('node:crypto').createHash('sha256').update(data).digest('hex');inputs.set(key,data);return {contentHash:key,bytes:data.length};},
  releaseInput:input=>{inputs.delete(input.contentHash);released++;},
  submit:async(workflow,options)=>{submissions.push({workflow,options});const data=inputs.get(workflow.nodes[0].input.contentHash);const output=(await execute(Buffer.from(data),{},{})).output;return {cancel:async()=>{},result:async()=>({output,status:{state:'SUCCEEDED',deviceId:workflow.nodes[0].targetId?'fixture-phone':'fixture-computer',traceId:'trace-'+submissions.length}})};}
 };
 const remote=await matchShoppingPhoto(images,p,{localMs:10000,dispatchRoundTripMs:10,remoteAvailable:true});
 assert.deepEqual(remote.pairs,local.pairs);assert.equal(remote.pairs.length,17);assert.equal(submissions.length,3);assert.equal(released,3);assert.equal(inputs.size,0);
 assert.equal(submissions[0].workflow.nodes[0].targetId,'fixture-source');assert.ok(submissions.slice(1).every(s=>s.workflow.nodes[0].targetId===undefined));
 assert.ok(submissions.every(s=>s.options.budgetMs>0&&s.options.budgetMs<=30000&&s.options.inputLocation==='ORIGIN'));
});
test('ambiguous submission never silently repeats the work on the phone',async()=>{
 const p=port();let localCalls=0,releases=0;p.local=async()=>{localCalls++;throw Error('unexpected');};p.originTarget='source';
 p.sdk={registerInput:async()=>({contentHash:'a'}),releaseInput:()=>{releases++;},submit:async()=>{throw Error('SDK_REQUEST_TIMEOUT');}};
 await assert.rejects(matchShoppingPhoto(images,p,{localMs:10000,dispatchRoundTripMs:1,remoteAvailable:true}),/SDK_REQUEST_TIMEOUT/);assert.equal(localCalls,0);assert.ok(releases>0);
});
test('cancelled and exhausted work does not begin computation or submit',async()=>{
 const p=port();p.local=async()=>{throw Error('SHOULD_NOT_RUN');};p.cancelled=()=>true;
 await assert.rejects(matchShoppingPhoto(images,p,null),/SHOPPING_CANCELLED/);p.cancelled=()=>false;p.deadline=0;
 await assert.rejects(matchShoppingPhoto(images,p,null),/SHOPPING_BUDGET_EXHAUSTED/);
});

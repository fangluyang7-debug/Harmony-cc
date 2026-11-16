const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{transformSync}=require('esbuild');
test('stalled control handshake resets only the socket and preserves ledger/outbox for recovery',async()=>{
 const source=fs.readFileSync('apps/harmony/scheduler/src/main/ets/v2/host/NativeAgent.ets','utf8');
 const method=source.slice(source.indexOf(' private recoverHandshake()'),source.indexOf(' private async connect()'));
 const m={exports:{}},code=transformSync('class Host {'+method+'} module.exports=Host;',{loader:'ts',format:'cjs'}).code;
 let now=10000;new Function('module','monotonic',code)(m,()=>now);
 const h=new m.exports(),journal={outbox:[{type:'RecoveryRequest'}]};let closed=0,invalidated=0;const errors=[];
 Object.assign(h,{stopped:false,ready:false,handshakeAt:0,socket:{close:async()=>{closed++;}},sent:new Set(['message']),peerLinks:{invalidate:()=>invalidated++},store:journal,error:e=>errors.push(e.message)});
 h.recoverHandshake();assert.equal(closed,0);now=20000;h.recoverHandshake();assert.equal(closed,1);assert.equal(h.socket,null);assert.equal(h.sent.size,0);assert.equal(invalidated,1);assert.equal(h.store,journal);assert.equal(journal.outbox.length,1);assert.deepEqual(errors,['CONTROL_HANDSHAKE_TIMEOUT']);
 h.socket={close:async()=>{closed++;}};h.ready=true;now=50000;h.recoverHandshake();assert.equal(closed,1);
});
test('readiness HTTP has a hard deadline and destroys a stuck request without touching photo uploads',async()=>{
 const source=fs.readFileSync('apps/harmony/scheduler/src/main/ets/v2/platform/NativeTransport.ets','utf8');
 const m={exports:{}},code=transformSync(source,{loader:'ts',format:'cjs'}).code;let deadline,deleted=0;
 const http={RequestMethod:{GET:'GET',POST:'POST'},HttpDataType:{ARRAY_BUFFER:1},createHttp:()=>({request:()=>new Promise(()=>{}),destroy:()=>deleted++})};
 new Function('require','module','exports','setTimeout','clearTimeout',code)(name=>name==='@kit.NetworkKit'?{http}:name==='@kit.ArkTS'?{util:{Base64Helper:class {}}}:{},m,m.exports,(fn,ms)=>{assert.equal(ms,12000);deadline=fn;return 1;},()=>{});
 const transport=Object.create(m.exports.NativeTransport.prototype);Object.assign(transport,{address:'https://center',credential:'test',caPath:'test'});
 const result=transport.request('/v2/qualification/photo-target');deadline();await assert.rejects(result,/READINESS_REQUEST_TIMEOUT/);assert.equal(deleted,1);
 assert.match(source,/const probe=route.startsWith\('\/v2\/qualification\/'\)\|\|route==='\/v2\/apps\/me'/);
});

test('lost evaluation claim response closes only proven unadmitted same-host work and persists retries',async()=>{
 const source=fs.readFileSync('apps/harmony/scheduler/src/main/ets/v2/host/NativeAgent.ets','utf8');
 const method=source.slice(source.indexOf(' private async reconcileUnadmittedEvaluation('),source.indexOf(' private async calibrate()'));
 const m={exports:{}},code=transformSync('class Host {'+method+'} module.exports=Host;',{loader:'ts',format:'cjs'}).code;
 new Function('module',code)(m);const h=new m.exports(),state={ledgerEpoch:3,entries:[]},saved=new Map(),reports=[];
 Object.assign(h,{instance:'live',launching:false,running:new Set(),store:{read:()=>({state})},db:{get:async k=>saved.get(k)??null,put:async(k,v)=>saved.set(k,v)},transport:{json:async(r,v)=>{reports.push(v);}}});
 const work={mode:'RECONCILE',ledgerEpoch:3,deviceInstanceId:'live',permit:{id:'lost',domain:'REAL'}};
 assert.equal(await h.reconcileUnadmittedEvaluation({...work,deviceInstanceId:'other'}),false);
 h.running.add('lost');assert.equal(await h.reconcileUnadmittedEvaluation(work),false);h.running.clear();
 state.entries=[{record:{attemptId:'lost',resourcesSettled:false}}];assert.equal(await h.reconcileUnadmittedEvaluation(work),false);state.entries=[];
 assert.equal(await h.reconcileUnadmittedEvaluation(work),true);assert.equal(reports[0].notRun,true);assert.equal(reports[0].output,'');assert.equal(saved.size,1);
 assert.equal(await h.reconcileUnadmittedEvaluation(work),false,'saved decline goes through the existing durable retry path');
});

const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path');
const source=fs.readFileSync(path.join(__dirname,'../../apps/harmony/scheduler/src/main/ets/v2/host/NativeAgent.ets'),'utf8');
class HostChange{constructor(apply){this.apply=apply;}}
function method(name,next,globals={}){
 const start=source.indexOf(' private async '+name+'('),end=source.indexOf(' private async '+next+'(',start);assert.ok(start>=0&&end>start);
 const js=require('esbuild').transformSync('class Host {'+source.slice(start,end)+'} module.exports=Host;',{loader:'ts',format:'cjs'}).code,module={exports:{}};
 new Function('module','HostChange','HostJournalChange',...Object.keys(globals),js)(module,HostChange,HostChange,...Object.values(globals));const host=new module.exports();host.flushTail=Promise.resolve();return host;
}
test('failed native send retains outbox, clears sent marker and reconnects without platform close callback',async()=>{
 const host=method('flush','connect'),m={messageId:'receipt',type:'ExecutionReceipt'},state={journal:{outbox:[m]}};let closed=0,invalidated=0;
 Object.assign(host,{store:{read:()=>state,readJournal:()=>state.journal,changeJournal:async c=>c.apply(state.journal),change:async c=>c.apply(state)},socket:{send:async()=>{throw Error('platform failure');},close:async()=>{closed++;}},sent:new Set(),ready:true,welcomed:true,peerLinks:{invalidate(){invalidated++;}}});
 await assert.rejects(host.flush(),/CONTROL_SEND_FAILED/);assert.equal(host.socket,null);assert.equal(host.ready,false);assert.equal(host.sent.size,0);assert.deepEqual(state.journal.outbox,[m]);assert.equal(closed,1);assert.equal(invalidated,1);
 const delivered=[];host.socket={send:async text=>delivered.push(JSON.parse(text))};host.welcomed=true;await host.flush();assert.deepEqual(delivered,[m]);
});
test('an old socket send failure cannot invalidate its replacement connection',async()=>{
 const host=method('flush','connect'),newSocket={},state={journal:{outbox:[{messageId:'old',type:'ExecutionReceipt'}]}};
 Object.assign(host,{store:{read:()=>state,readJournal:()=>state.journal},sent:new Set(),welcomed:true,ready:true,socket:{send:async()=>{host.socket=newSocket;host.sent=new Set(['new']);throw Error('old failure');},close:async()=>{}}});
 await assert.rejects(host.flush(),/CONTROL_SEND_FAILED/);assert.equal(host.socket,newSocket);assert.equal(host.ready,true);assert.deepEqual([...host.sent],['new']);
});
for(const failure of ['REJECTED','NEVER_RESOLVES'])test('accepted native work settles despite '+failure+' admission send; duplicate offer does not recompute',async()=>{
 const offer={task:{attemptId:'job',groupId:'g',contract:{capability:'catalog.filter.v1'}},target:{targetId:'target'},resources:[],allowedConfigs:[{id:'c'}]},state={state:{entries:[]},journal:{outbox:[]}};
 const local={target:offer.target,contract:offer.task.contract,resources:[],configurations:offer.allowedConfigs},evidence={executor:local,admission:{domain:'REAL',groupId:'g',holderInstanceId:'h',state:'ACTIVE',quality:{value:1,sampledAt:0,ttlMs:10000},identity:'digest'}};
 class NativeTrace{add(){} async segment(_name,work){return work();}}
 const host=method('dispatch','admit',{validateAgentOfferV2:m=>m.payload,monotonic:()=>1,canonical:JSON.stringify,NativeTrace,validCapabilityAdmissionV2:()=>true});let executes=0,flushes=0;
 Object.assign(host,{offered:new Set(),running:new Set(),queueStarted:new Set(),waitReasons:new Map(),ready:true,idle:()=>true,waitTurn:async()=>{},store:{read:()=>state,readJournal:()=>state.journal},transport:{now:()=>1,json:async route=>route.includes('/authorize')?{offer,inputTicket:{},snapshotVersion:1}:evidence},installation:{bootstrap:{domain:'REAL'},paired:{peer:{holderInstanceId:'h'}}},executors:()=>[local],executorDigest:()=> 'digest',digest:()=> 'execution',queue:{start(){},settle(){},removeWaiting(){}},pumpQueue(){},error(){},flush:async()=>{if(++flushes===1)throw Error('CONTROL_SEND_FAILED');},admit:async()=>{if(!state.state.entries.length)state.state.entries.push({offer,record:{attemptId:'job',executionDigest:'execution',resourcesSettled:false}});},execute:async()=>{executes++;state.state.entries[0].record.resourcesSettled=true;state.state.entries[0].record.receipt={state:'SUCCEEDED'};}});
 if(failure==='NEVER_RESOLVES')host.flush=async()=>{if(++flushes===1)await new Promise(()=>{});};
 const message={payload:offer,traceId:'trace'};await host.dispatch(message);assert.equal(executes,1);assert.equal(state.state.entries[0].record.resourcesSettled,true);assert.equal(host.queueStarted.size,0);await host.dispatch(message);assert.equal(executes,1);
});

test('concurrent native flushes preserve wire sequence despite different pending snapshots',async()=>{
 const host=method('flush','connect'),state={journal:{outbox:[{messageId:'a',seq:1,type:'ExecutionReceipt'},{messageId:'b',seq:2,type:'TraceBatch'}]}};const sent=[];let release;const gate=new Promise(r=>release=r);
 Object.assign(host,{store:{read:()=>JSON.parse(JSON.stringify(state)),readJournal:()=>JSON.parse(JSON.stringify(state.journal))},sent:new Set(),welcomed:true,socket:{send:async raw=>{const m=JSON.parse(raw);if(m.seq===1)await gate;sent.push(m.seq);}}});
 const first=host.flush();await new Promise(r=>setImmediate(r));state.journal.outbox.push({messageId:'c',seq:3,type:'DeviceProfile'});const second=host.flush();await new Promise(r=>setImmediate(r));assert.deepEqual(sent,[]);release();await Promise.all([first,second]);assert.deepEqual(sent,[1,2,3]);
});

test('repeated hello acknowledgment does not grow an already pending recovery request',async()=>{
 const host=method('message','renew',{validMessageEnvelopeV2:()=>true}),state={state:{groupId:'g'},journal:{coordinatorId:'center',epoch:1,outbox:[{messageId:'recovery',type:'RecoveryRequest'},{messageId:'hello',type:'Hello'}]}};
 Object.assign(host,{store:{read:()=>state,readJournal:()=>state.journal,changeJournal:async c=>c.apply(state.journal),change:async c=>c.apply(state)},installation:{paired:{peer:{groupId:'g'}}},helloId:'hello',flush:async()=>{},enqueue:(s,type)=>s.journal.outbox.push({messageId:'extra',type})});
 const ack={type:'Ack',payload:JSON.stringify({messageId:'hello'}),ackOf:'hello',groupId:'g',senderInstanceId:'center',coordinatorEpoch:1};await host.message(ack);await host.message(ack);assert.deepEqual(state.journal.outbox,[{messageId:'recovery',type:'RecoveryRequest'}]);
});

test('background evaluation cannot steal a selected business admission slot',async()=>{
 const host=method('admitEvaluation','calibrate');let admitted=0,pumped=0,release;const gate=new Promise(r=>release=r);Object.assign(host,{launching:false,offered:new Set(['business']),admit:async()=>{admitted++;await gate;},pumpQueue(){pumped++;}});
 await assert.rejects(host.admitEvaluation({}),/EVALUATION_DEFERRED/);assert.equal(admitted,0);host.offered.clear();const work=host.admitEvaluation({});assert.equal(host.launching,true);assert.equal(admitted,1);release();await work;assert.equal(host.launching,false);assert.equal(pumped,1);
 host.admit=async()=>{throw Error('ADMISSION_FAILED');};await assert.rejects(host.admitEvaluation({}),/ADMISSION_FAILED/);assert.equal(host.launching,false);assert.equal(pumped,2);
});

test('queue expiry cannot remove selected work while asynchronous admission is in progress',()=>{
 const start=source.indexOf(' private pumpQueue('),end=source.indexOf(' private async dispatch(',start),module={exports:{}};
 const code=require('esbuild').transformSync('class Host {'+source.slice(start,end)+'} module.exports=Host;',{loader:'ts',format:'cjs'}).code;
 new Function('module','monotonic',code)(module,()=>6000);const host=new module.exports(),removed=[],rejected=[];
 Object.assign(host,{launching:true,waiting:new Map([['waiting',{reject:e=>rejected.push(e.message)}]]),waitReasons:new Map(),queue:{expired:()=>['selected','waiting'],removeWaiting:id=>removed.push(id)},store:{read:()=>({state:{entries:[]}})}});
 host.pumpQueue();assert.deepEqual(removed,['waiting']);assert.deepEqual(rejected,['QUEUE_STARVED']);
});

test('an exception after admission settles only never-started attempts and emits no replacement computation',async()=>{
 const settleAttemptV2=(state,receipt)=>({...state,entries:state.entries.map(e=>e.record.attemptId===receipt.attemptId?{...e,record:{...e.record,...receipt}}:e)});
 const host=method('abortBeforeStart','admit',{settleAttemptV2}),state={state:{entries:['ACCEPTED','RUNNING'].map((status,i)=>({record:{attemptId:String(i),state:status,resourcesSettled:false,coordinatorEpoch:1,planRevision:1,fence:{}},offer:{target:{},allowedConfigs:[{id:'c'}]}}))},journal:[]};let reports=0;
 Object.assign(host,{store:{change:async c=>c.apply(state)},report:()=>reports++,flush:async()=>{},error(){}});
 await host.abortBeforeStart('0');assert.equal(state.state.entries[0].record.state,'FAILED');assert.equal(state.state.entries[0].record.resourcesSettled,true);assert.equal(reports,1);
 await host.abortBeforeStart('0');await host.abortBeforeStart('1');assert.equal(reports,1);assert.equal(state.state.entries[1].record.resourcesSettled,false);
});

test('native admission deducts queue and authorization time from the original remaining budget',async()=>{
 let wall=1000,mono=100,admits=0;const host=method('admit','engine',{monotonic:()=>mono,admitV2:(s,o)=>{admits++;return {state:{...s,entries:[{record:{attemptId:o.task.attemptId},deadline:mono+5000}]},entry:{record:{}},existing:false};},factory:{id:()=> 'lease'}});
 const state={state:{entries:[]},journal:{epoch:1}},offer={task:{attemptId:'a',budget:{remainingMs:5000,deadlineAt:2000}},leaseMs:5000};
 Object.assign(host,{store:{change:async c=>c.apply(state)},transport:{now:()=>wall},ready:true,idle:()=>true,limits:()=>[],digest:()=> 'd'});
 await host.admit(offer,null,true);assert.equal(state.state.entries[0].deadline,1100);wall=2001;offer.task.attemptId='b';await assert.rejects(host.admit(offer,null,true),/BUDGET_EXHAUSTED/);assert.equal(admits,1);
});

test('profile projection does not report a just-admitted task as both queued and in flight',async()=>{
 const host=method('profile','probeLinks',{monotonic:()=>100,occupiedV2:()=>[],validDeviceProfileV2:()=>true});let observed;
 const state={state:{deviceId:'d',holderInstanceId:'h',ledgerEpoch:1,entries:[{record:{attemptId:'accepted'}}]},journal:{sequence:1,outbox:[]}};
 Object.assign(host,{store:{change:async c=>c.apply(state)},limits:()=>[],executors:()=>[],installation:{bootstrap:{domain:'SIMULATED'}},instance:'i',sample:()=>({}),status:()=>({}),idle:()=>true,foreground:true,lifecycleForeground:()=>true,transport:{now:()=>100},energyGate:null,links:[],queue:{capacityCredits:()=>[],queuedFacts:()=>[{attemptId:'accepted'},{attemptId:'waiting'}]},timings:{sample:()=>[{attemptId:'accepted'}]},enqueue:(_s,_type,p)=>observed=p,flush:async()=>{}});
 await host.profile();assert.deepEqual(observed.queued,[{attemptId:'waiting'}]);assert.deepEqual(observed.inFlight,[{attemptId:'accepted'}]);
});

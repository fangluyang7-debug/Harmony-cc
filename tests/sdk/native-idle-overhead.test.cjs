const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),esbuild=require('esbuild');
const root=path.resolve(__dirname,'../..');
function load(file,globals){const source=fs.readFileSync(path.join(root,file),'utf8').replace(/^import .*;\r?\n/gm,'');const code=esbuild.transformSync(source,{loader:'ts',format:'cjs'}).code,module={exports:{}};new Function('module','exports',...Object.keys(globals),code)(module,module.exports,...Object.values(globals));return module.exports;}
test('journal-only commits preserve history, serialize with business changes and poison on persistence failure',async()=>{
 const {AgentStoreV2}=load('apps/harmony/scheduler/src/main/ets/v2/agent/AgentStoreV2.ets',{validateAgentJournalV2:()=>{}});
 const state={groupId:'g',holderInstanceId:'h',entries:[{payload:'x'.repeat(2200000)}],counter:1},snapshot={format:1,state,journal:{outbox:[{messageId:'a'}]}};
 let saved,fail=false;const store=new AgentStoreV2(snapshot,{commit:async s=>{if(fail)throw Error('disk');saved=s;}});
 const reference=store.snapshot.state;await store.changeJournal({apply:j=>{j.outbox=[];}});
 assert.equal(store.snapshot.state,reference);assert.deepEqual(JSON.parse(saved).state,state);
 const copy=store.readJournal();copy.outbox.push({messageId:'foreign'});assert.equal(store.readJournal().outbox.length,0);
 await Promise.all([store.change({apply:s=>s.state.counter++}),store.changeJournal({apply:j=>j.outbox.push({messageId:'b'})})]);
 assert.equal(JSON.parse(saved).state.counter,2);assert.deepEqual(JSON.parse(saved).journal.outbox,[{messageId:'b'}]);
 fail=true;await assert.rejects(store.changeJournal({apply:j=>j.outbox=[]}),/LEDGER_COMMIT_FAILED/);assert.throws(()=>store.readJournal(),/LEDGER_UNAVAILABLE/);
});
test('native 60 second lease renews at one third, reacts to config/reconnect and retries failed acknowledgement',async()=>{
 const source=fs.readFileSync(path.join(root,'apps/harmony/scheduler/src/main/ets/v2/host/NativeAgent.ets'),'utf8'),start=source.indexOf(' private async renew('),end=source.indexOf(' private async ackQuota(',start);
 let now=0,requests=0,ackFails=false;const code=esbuild.transformSync('class Host {'+source.slice(start,end)+'} module.exports=Host;',{loader:'ts',format:'cjs'}).code,module={exports:{}};
 class HostChange{constructor(apply){this.apply=apply;}}
 new Function('module','monotonic','canonical','factory','HostChange','requestGrantV2','installGrantV2',code)(module,()=>now,JSON.stringify,{id:()=> 'r'},HostChange,s=>s,s=>s);
 const state={state:{ledgerEpoch:1}},host=new module.exports();Object.assign(host,{ready:true,grantBusy:false,renewAt:0,renewalConfig:'',idle:()=>true,limits:()=>[{resourcePoolId:'cpu',amount:host.contribution.maxCpuThreads},{resourcePoolId:'ram',amount:host.contribution.maxMemoryBytes}],contribution:{maxCpuThreads:2,maxMemoryBytes:100},store:{read:()=>state,change:async c=>c.apply(state)},transport:{verify:()=>true,json:async()=>{requests++;return {leaseMs:60000};}},ackQuota:async()=>{if(ackFails)throw Error('ack');}});
 await host.renew();assert.equal(requests,1);for(now=2000;now<20000;now+=2000)await host.renew();assert.equal(requests,1);
 await host.renew();assert.equal(requests,2);host.contribution.maxCpuThreads=1;await host.renew();assert.equal(requests,3);
 host.renewAt=0;ackFails=true;await assert.rejects(host.renew(),/ack/);ackFails=false;await host.renew();assert.equal(requests,5);
});

const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../../apps/harmony/scheduler/src/main/ets/v2/agent/AgentStoreV2.ets'),'utf8');
test('native cancellation polling reads only committed scalar state without snapshot cloning',()=>{
 const start=source.indexOf(' isCancelled('),end=source.indexOf('\n change(',start);assert.ok(start>=0&&end>start);
 const code=require('esbuild').transformSync('class Store {'+source.slice(start,end)+'} module.exports=Store;',{loader:'ts',format:'cjs'}).code,module={exports:{}};new Function('module',code)(module);
 const store=new module.exports(),entry={record:{attemptId:'job'},cancelRequested:false,deadline:100};store.snapshot={state:{entries:[entry]}};store.read=()=>{throw Error('HISTORY_COPY_FORBIDDEN');};
 assert.equal(store.isCancelled('job',99),false);assert.equal(store.isCancelled('job',100),true);assert.equal(store.isCancelled('missing',0),true);
 entry.cancelRequested=true;assert.equal(store.isCancelled('job',0),true);store.poisoned=true;assert.throws(()=>store.isCancelled('job',0),/LEDGER_UNAVAILABLE/);
});

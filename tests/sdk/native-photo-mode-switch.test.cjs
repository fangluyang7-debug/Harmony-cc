const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{transformSync}=require('esbuild');
const source=fs.readFileSync('apps/harmony/scheduler/src/main/ets/v2/host/NativeAgent.ets','utf8');
function method(start,end){return source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));}
function load(body,deps={}){const m={exports:{}};new Function('module',...Object.keys(deps),transformSync('class Host {'+body+'}module.exports=Host;',{loader:'ts',format:'cjs'}).code)(m,...Object.values(deps));return new m.exports();}
test('local mode releases contribution without closing/reopening the ledger, resume restores the same host',async()=>{
 let now=0;const calls=[],ledger={ledgerEpoch:7,entries:[]};
 const h=load(method(' async pauseForLocal()', ' async leaveSpace()')+method(' private idle()', ' private limits()'),{monotonic:()=>now});
 Object.assign(h,{stopped:false,localOnly:false,foreground:true,lifecycleForeground:()=>true,enabled:true,paused:false,switching:false,
  running:new Set(),work:Promise.resolve(),store:{read:()=>({state:ledger})},ready:true,
  renew:async()=>calls.push(['renew',h.idle()]),profile:async()=>calls.push(['profile',h.idle()]),tick:async()=>calls.push(['tick',h.idle()])});
 assert.equal(h.idle(),true);await h.pauseForLocal();assert.equal(h.idle(),false);assert.equal(ledger.ledgerEpoch,7);
 assert.deepEqual(calls,[['renew',false],['profile',false]]);await h.pauseForLocal();assert.equal(calls.length,2);
 await h.resumeContribution();assert.equal(h.idle(),true);assert.equal(ledger.ledgerEpoch,7);assert.deepEqual(calls[2],['tick',true]);
 ledger.entries=[{record:{resourcesSettled:false}}];await assert.rejects(h.pauseForLocal(),/SPACE_SWITCH_BUSY/);assert.equal(h.localOnly,false);
 h.stopped=true;await assert.rejects(h.resumeContribution(),/HOST_STOPPED/);
});
test('evaluation wake arriving during an in-flight claim is retained and consumed once',async()=>{
 let release,calls=0;const blocked=new Promise(r=>release=r);
 const h=load(method(' private async calibrate()', ' /** The coordinator stopped:'));
 Object.assign(h,{calibrating:false,calibrationPending:false,ready:true,stopped:false,idle:()=>true,store:{read:()=>({state:{grant:{}}})},error:e=>{throw e;},
  transport:{json:async()=>{calls++;if(calls===1)await blocked;return {work:null};}}});
 const first=h.calibrate();await Promise.resolve();h.calibrationPending=true;await h.calibrate();assert.equal(calls,1);
 release();await first;await new Promise(r=>setImmediate(r));assert.equal(calls,2);assert.equal(h.calibrating,false);assert.equal(h.calibrationPending,false);
 h.idle=()=>false;h.calibrationPending=true;await h.calibrate();assert.equal(calls,2,'local-only mode must not claim calibration work');
});

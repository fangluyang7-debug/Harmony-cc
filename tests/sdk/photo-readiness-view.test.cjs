const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{transformSync}=require('esbuild');
function monitor(pending){
 let now=0,id=0;const timers=new Map(),ticks=new Map(),views=[],m={exports:{}};
 const code=transformSync(fs.readFileSync('apps/harmony-photo/entry/src/main/ets/PhotoReadiness.ets','utf8'),{loader:'ts',format:'cjs'}).code;
 new Function('require','module','exports','setTimeout','clearTimeout','setInterval','clearInterval',code)(()=>({monotonic:()=>now}),m,m.exports,(fn,ms)=>{timers.set(++id,{fn,ms});return id;},n=>timers.delete(n),fn=>{ticks.set(++id,fn);return id;},n=>ticks.delete(n));
 const view=new m.exports.PhotoReadiness(pending,v=>views.push(v));
 const flush=()=>new Promise(resolve=>setImmediate(resolve));
 return {view,views,timers,ticks,flush,tick:()=>{now+=1000;for(const fn of ticks.values())fn();},advance:async()=>{const [key,t]=timers.entries().next().value;timers.delete(key);now+=t.ms;t.fn();await flush();}};
}
test('readiness reports real pending capabilities, freezes setup duration, and disables readiness after disconnect',async()=>{
 let state=['成品生成'];const t=monitor(async()=>{if(state instanceof Error)throw state;return state;});
 t.view.start();await t.flush();assert.equal(t.views.at(-1).ready,false);assert.match(t.views.at(-1).message,/成品生成/);
 await t.advance();assert.equal(t.views.at(-1).elapsedMs,1000);
 state=[];await t.advance();assert.equal(t.views.at(-1).ready,true);assert.equal(t.views.at(-1).elapsedMs,2000);
 await t.advance();assert.equal(t.views.at(-1).elapsedMs,2000,'idle time is not added to setup time');
 state=Error('offline');await t.advance();assert.equal(t.views.at(-1).ready,false);assert.match(t.views.at(-1).message,/offline/);
 state=[];await t.advance();assert.equal(t.views.at(-1).ready,true);t.view.stop();assert.equal(t.timers.size,0);
});
test('leaving or reconnecting ignores late qualification responses from the previous session',async()=>{
 let finish;const t=monitor(()=>new Promise(resolve=>finish=resolve));t.view.start();const count=t.views.length;t.view.stop();finish([]);await t.flush();
 assert.equal(t.views.length,count);assert.equal(t.timers.size,0);assert.equal(t.ticks.size,0);
 t.view.start();const old=finish;t.view.start();old([]);await t.flush();assert.equal(t.views.at(-1).ready,false);
 finish([]);await t.flush();assert.equal(t.views.at(-1).ready,true);assert.equal(t.timers.size,1);t.view.stop();
});
test('elapsed setup time remains visible while the qualification request is pending',async()=>{
 let finish;const t=monitor(()=>new Promise(resolve=>finish=resolve));t.view.start();t.tick();t.tick();assert.equal(t.views.at(-1).elapsedMs,2000);assert.equal(t.views.at(-1).ready,false);
 finish([]);await t.flush();assert.equal(t.views.at(-1).ready,true);t.tick();assert.equal(t.views.at(-1).elapsedMs,2000);t.view.stop();assert.equal(t.ticks.size,0);
});

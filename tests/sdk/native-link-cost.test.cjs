const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {fitLink}=require('@harmony/scheduler-core');
test('native relay probes and core estimate the same startup-dominated and bandwidth-dominated links',async()=>{
 const source=fs.readFileSync(path.join(__dirname,'../../apps/harmony/scheduler/src/main/ets/v2/host/NativeAgent.ets'),'utf8');
 const start=source.indexOf(' private async probeLinks():'),end=source.indexOf(' private async pollCancellation()',start);assert.ok(start>0&&end>start);
 const js=require('esbuild').transformSync('class Host {'+source.slice(start,end)+'} module.exports=Host;',{loader:'ts',format:'cjs'}).code;
 for(const durations of [[30,18,20],[11,82,328],[0,0,0]]){
  let now=0,index=0;const module={exports:{}};
  new Function('module','factory','monotonic',js)(module,{id:()=> 'epoch'},()=>now);
  const host=new module.exports();Object.assign(host,{installation:{bootstrap:{domain:'SIMULATED'},paired:{peer:{deviceId:'device'}}},sample:(value,unit,source)=>({value,unit,source}),transport:{json:async(_route,body)=>{now+=durations[index++%3];return {relayId:'relay',padding:body.mode==='download'?'x'.repeat(body.bytes):''};}}});
  await host.probeLinks();const fit=fitLink([1024,8192,32768].map((bytes,i)=>({bytes,durationMs:durations[i],observedAt:100})),30000);
  assert.equal(host.links.length,2);for(const link of host.links){assert.equal(link.bytesPerSecond.value,fit.bytesPerSecond);assert.equal(link.fixedMs.value,fit.fixedMs);}
 }
});

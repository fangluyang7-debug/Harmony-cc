const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
test('review foreground survives ordinary ability background and yields when the last foreground ability leaves',async()=>{
 const source=fs.readFileSync('apps/harmony-agent/entry/src/main/ets/AgentRuntime.ets','utf8').replace(/^import .*;\r?$/gm,'');
 const code=require('esbuild').transformSync(source,{loader:'ts',format:'cjs'}).code,m={exports:{}};const calls=[];const host={displayHolderId:()=> 'holder',setForeground:v=>calls.push(v),close:async()=>calls.push('close')};
 new Function('module','exports','NativeAgent',code)(m,m.exports,{start:async()=>host});const r=m.exports;
 r.foregroundReview(true);await r.openAgent({},null);r.foregroundAgent(false);assert.equal(calls.at(-1),true);await r.closeAgent();assert.notEqual(calls.at(-1),'close');r.foregroundReview(false);assert.equal(calls.at(-1),false);
 r.foregroundAgent(true);r.foregroundReview(true);r.foregroundReview(false);assert.equal(calls.at(-1),true);r.foregroundAgent(false);assert.equal(calls.at(-1),false);
});

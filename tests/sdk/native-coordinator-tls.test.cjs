const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{transformSync}=require('esbuild');
test('Harmony TLS listeners are installed only after native listen succeeds',async()=>{
 const m={exports:{}};let listening=false,closed=false;const events=[];
 const server={listen:async()=>{await Promise.resolve();listening=true;},on:event=>{assert.equal(listening,true);events.push(event);},close:async()=>{closed=true;}};
 new Function('require','module','exports',transformSync(fs.readFileSync('apps/harmony/scheduler/src/main/ets/v2/coordinator/CoordinatorTlsServer.ets','utf8'),{loader:'ts',format:'cjs'}).code)(name=>name.includes('NetworkKit')?{socket:{constructTLSSocketServerInstance:()=>server}}:{},m,m.exports);
 const host=new m.exports.CoordinatorTlsServer();await host.start({certificate:'fixture',privateKey:'fixture'},7443,async()=>({status:200,body:'{}'}));assert.deepEqual(events,['error','connect']);await host.close();assert.equal(closed,true);
});

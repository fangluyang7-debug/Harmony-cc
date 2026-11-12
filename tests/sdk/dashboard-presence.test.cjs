const {test}=require('node:test'),assert=require('node:assert/strict');
const sample=(value)=>({value,source:'MEASURED',sampledAt:100,ttlMs:1000,unit:'state'});
const holder=(id,state='ONLINE')=>({controlState:state,evidenceFresh:true,profile:{holderInstanceId:id,ownerActivity:sample('IDLE'),foreground:sample('FOREGROUND')}});
test('device, holder and network lists hide offline/background entries without destroying reconnect history',async()=>{
 const {visibleDevices,visibleNetwork}=await import('../../apps/team-space-web/dispatch-presence.mjs');
 const active=holder('new'),old=holder('old','OFFLINE'),background=holder('background');background.profile.foreground.value='BACKGROUND';
 const devices=[{id:'phone',holders:[old,active,background]},{id:'paired-only',holders:[]}];
 const copy=JSON.stringify(devices),shown=visibleDevices(devices,200);
 assert.deepEqual(shown.map(d=>[d.id,d.holders.map(h=>h.profile.holderInstanceId)]),[['phone',['new']]]);
 assert.deepEqual(visibleNetwork([{deviceId:'phone',holderInstanceId:'old'},{deviceId:'phone',holderInstanceId:'new'},{deviceId:'another',holderInstanceId:'new'}],shown),[{deviceId:'phone',holderInstanceId:'new'}]);
 assert.equal(JSON.stringify(devices),copy);
 assert.deepEqual(visibleDevices(devices,1100),[]);
 active.controlState='OFFLINE';assert.deepEqual(visibleDevices(devices,200),[]);
 active.controlState='ONLINE';assert.equal(visibleDevices(devices,200).length,1);
 for(const state of ['UNKNOWN','SUSPECT','RECONCILING']){active.controlState=state;assert.deepEqual(visibleDevices(devices,200),[]);}
});
test('future, stale and unknown evidence never becomes an online device',async()=>{
 const {visibleDevices}=await import('../../apps/team-space-web/dispatch-presence.mjs');
 const h=holder('one'),devices=[{id:'phone',holders:[h]}];
 assert.deepEqual(visibleDevices(devices,99),[]);
 h.evidenceFresh=false;assert.deepEqual(visibleDevices(devices,200),[]);
 h.evidenceFresh=true;h.profile.foreground.source='UNKNOWN';assert.deepEqual(visibleDevices(devices,200),[]);
});

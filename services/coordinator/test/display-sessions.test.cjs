const {test}=require('node:test'),assert=require('node:assert/strict');
const {runtime}=require('./helpers.cjs');
const {appRequest}=require('@harmony/scheduler-client/dist/node');
test('only viewer acknowledgement confirms a current lease and version',async()=>{
 const r=await runtime();
 try{
  async function peer(group,holder){
   const i=await r.auth.invite(group,holder,holder,r.url),p=await r.auth.exchange({inviteId:i.inviteId,code:i.code,holderInstanceId:holder});
   const req=appRequest({...i,credential:p.credential});
   return async(route,body)=>JSON.parse(await req('/v2/display'+route,body===undefined?null:JSON.stringify(body)));
  }
  const source=await peer('team','source'),viewer=await peer('team','screen'),other=await peer('other','elsewhere');
  const invite=()=>source('',{viewerHolderId:'screen',leaseMs:300000});
  const s=await invite(),id='/'+s.id,publish=(version,text)=>source(id+'/publish',{version,text});
  assert.equal(s.state,'INVITED');assert.equal((await viewer(''))[0].text,null);
  await assert.rejects(publish(1,'before consent'),/DISPLAY_LEASE_INACTIVE/);
  await assert.rejects(other(id),/DISPLAY_SESSION_UNKNOWN/);
  await viewer(id+'/accept',{});
  await publish(1,'first');await publish(2,'new');
  assert.equal((await publish(2,'new')).shownVersion,0);
  await assert.rejects(publish(1,'old'),/DISPLAY_VERSION_CONFLICT/);
  await assert.rejects(viewer(id+'/shown',{version:1}),/DISPLAY_VERSION_CONFLICT/);
  await assert.rejects(source(id+'/shown',{version:2}),/DISPLAY_SESSION_UNKNOWN/);
  assert.equal((await viewer(id)).text,'new');
  assert.equal((await viewer(id+'/shown',{version:2})).shownVersion,2);
  assert.equal((await source(id)).shownVersion,2);
  await source(id+'/revoke',{});assert.deepEqual(await viewer(''),[]);
  assert.equal((await viewer(id)).text,null);await assert.rejects(publish(3,'late'),/DISPLAY_LEASE_INACTIVE/);
  const second='/'+(await invite()).id;await viewer(second+'/accept',{});await viewer(second+'/leave',{});
  await assert.rejects(source(second+'/publish',{version:1,text:'late'}),/DISPLAY_LEASE_INACTIVE/);
  const third=await invite();await r.db.displaySession.update({where:{id:third.id},data:{expiresAt:Date.now()-1}});
  assert.equal((await source('/'+third.id)).state,'EXPIRED');assert.deepEqual(await viewer(''),[]);
 }finally{await r.close();}
});

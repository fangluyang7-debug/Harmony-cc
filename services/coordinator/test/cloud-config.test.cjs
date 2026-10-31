const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {runtime}=require('./helpers.cjs');const {createCoordinator}=require('../dist/app');const {loadConfig}=require('../dist/config');const {pinOptions}=require('@harmony/resource-transport');
test('Railway proxy keeps public HTTPS trust separate from persistent allotment signing identity',async()=>{
 assert.equal(loadConfig({PORT:'8080',COORDINATOR_TLS_MODE:'proxy'}).host,'0.0.0.0');
 assert.equal(loadConfig({PORT:'8080'}).port,8080);
 assert.throws(()=>loadConfig({COORDINATOR_PUBLIC_URL:'http://example.com'}));
 const r=await runtime(),invite=await r.auth.invite('cloud-team','owner','pc','https://team.example');await r.close();
 const options=pinOptions({...invite,tlsMode:'public'});assert.equal(options.rejectUnauthorized,true);assert.equal(options.ca,undefined);assert.equal(options.checkServerIdentity,undefined);
 assert.throws(()=>pinOptions({...invite,tlsMode:'public',address:'http://team.example'}));
 assert.throws(()=>pinOptions({...invite,tlsMode:'public',fingerprint:'0'.repeat(64)}));
 assert.throws(()=>pinOptions({...invite,tlsMode:'disabled'}));
 const cloud=await createCoordinator({...r.config,proxy:true,publicUrl:'https://team.example',webDir:path.resolve('../../apps/team-space-web')});
 try{
  await cloud.app.listen(0,'127.0.0.1');await cloud.restore();const address='http://127.0.0.1:'+cloud.app.getHttpServer().address().port;
  assert.equal(cloud.identity.id,r.identity.id);assert.equal(cloud.identity.cert,r.identity.cert);
  assert.equal((await fetch(address+'/v2/health/ready')).status,200);
  assert.match(await (await fetch(address+'/')).text(),/团队|协作空间/);
  assert.equal((await fetch(address+'/v2/spaces/me')).status,401);
  const registered=await fetch(address+'/v2/spaces/register',{method:'POST',headers:{Origin:'https://team.example','Content-Type':'application/json'},body:JSON.stringify({account:'proxy-account',name:'proxy test',password:'test-password-123'})});
  assert.equal(registered.status,200);assert.match(registered.headers.get('set-cookie'),/HttpOnly.*Secure/);
  const wrongOrigin=await fetch(address+'/v2/spaces/',{method:'POST',headers:{Origin:'https://another.example','Content-Type':'application/json'},body:'{}'});assert.equal(wrongOrigin.status,400);
 }finally{await cloud.close();}
});

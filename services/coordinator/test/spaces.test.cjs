const {test}=require('node:test'),assert=require('node:assert/strict'),https=require('node:https'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFile,fork}=require('node:child_process');
const {runtime}=require('./helpers.cjs');
const {createCoordinator}=require('../dist/app');
function browser(r){let cookie='';return async(route,body,origin)=>new Promise((resolve,reject)=>{const bytes=body===undefined?null:Buffer.from(JSON.stringify(body));const q=https.request(r.url+'/v2/spaces'+route,{ca:r.identity.cert,method:bytes?'POST':'GET',headers:{Cookie:cookie,...(origin?{Origin:origin}:{}),...(bytes?{'Content-Type':'application/json','Content-Length':bytes.length}:{})}},res=>{if(res.headers['set-cookie'])cookie=res.headers['set-cookie'][0].split(';')[0];let text='';res.on('data',b=>text+=b);res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(text)});}catch(e){reject(e);}});});q.on('error',reject);q.end(bytes);});}
async function until(check){const deadline=Date.now()+45000;while(Date.now()<deadline){if(await check())return;await new Promise(r=>setTimeout(r,150));}throw Error('SPACE_TIMEOUT');}
const command=(file,args)=>new Promise((resolve,reject)=>execFile(process.execPath,[file,...args],{windowsHide:true,timeout:60000},(e,stdout,stderr)=>e?reject(Error(stderr||e.message)):resolve(stdout)));
test('browser spaces persist, isolate roles and operate a paired CPU host with a fast device clock',async()=>{
 const r=await runtime({cpuHost:true});r.config.publicUrl=r.url;let host;
 const owner=browser(r),guest=browser(r),stranger=browser(r);const account=crypto.randomUUID();let group;
 try{
  assert.equal((await owner('/me')).status,401);
  const registered=await owner('/register',{account,name:'负责人',password:'test-password-123'});assert.equal(registered.status,200);const ownerId=registered.body.user.id;
  assert.equal((await owner('/',{name:'空间'},'https://unrelated.example')).status,400);
  group=(await owner('/',{name:'协同演示空间'})).body.id;assert.ok(group);
  assert.equal((await owner('/'+group)).body.devices.length,0);
  assert.equal((await owner('/'+group+'/jobs',{requestId:crypto.randomUUID(),capability:'text.count.v1',input:{text:'empty'}})).body.error,'NO_AVAILABLE_TARGET');
  await guest('/register',{account:crypto.randomUUID(),name:'观察者',password:'test-password-123'});
  const invite=await owner('/'+group+'/invites',{role:'VIEWER'});
  assert.equal((await guest('/join',{code:invite.body.code})).body.id,group);
  const members=(await owner('/'+group)).body.members,guestId=members.find(m=>m.userId!==ownerId).userId;
  assert.equal((await guest('/'+group+'/invites',{role:'MEMBER'})).status,403);
  assert.equal((await guest('/'+group+'/jobs',{})).status,403);
  await stranger('/register',{account:crypto.randomUUID(),name:'其他空间成员',password:'test-password-123'});
  assert.equal((await stranger('/'+group)).status,403);
  assert.equal((await owner('/'+group+'/members/'+ownerId,{role:'VIEWER'})).status,400);
  assert.equal((await owner('/'+group+'/members/'+guestId,{role:'MEMBER'})).status,200);
  const settings={ownerMode:'dedicated',maxCpuThreads:1,maxMemoryBytes:268435456,reserveMemoryBytes:0};
  const device=await owner('/'+group+'/devices',{name:'演示 CPU',settings});assert.equal(device.status,200);assert.equal(device.body.invitation.tlsMode,'pinned');
  const dir=r.config.dataDir,file=path.join(dir,'space-invitation.json'),installation=path.join(dir,'space-host'),policy=path.join(dir,'space-policy.json');
  fs.writeFileSync(file,JSON.stringify(device.body));fs.writeFileSync(policy,JSON.stringify(settings));
  await command(path.resolve('../pc-agent/dist/pairing-main.js'),[file,installation]);
  host=fork(path.resolve('../pc-agent/dist/host-main.js'),[path.join(installation,'agent.json'),policy],{windowsHide:true,execArgv:['--require',path.resolve('test/fast-clock.cjs')],stdio:['ignore','ignore','pipe','ipc']});
  host.stderr.on('data',b=>console.error('Host diagnostic:',b.toString().trim()));
  await until(async()=>{const s=(await owner('/'+group)).body;return s.devices[0].online&&s.devices[0].capabilities.every(c=>c.available&&c.state==='ACTIVE')&&s.devices[0].capabilities.length===2;});
  const id=crypto.randomUUID(),submitted=await guest('/'+group+'/jobs',{requestId:id,capability:'text.count.v1',input:{text:'Hello team'}});assert.equal(submitted.status,200,JSON.stringify(submitted.body));
  let result;await until(async()=>{result=await guest('/'+group+'/jobs/'+id);return result.body.output;});
  assert.deepEqual(result.body.output,{characters:10,words:2,lines:1});assert.equal((await owner('/'+group+'/jobs/'+id)).status,400);
  const deviceId=(await owner('/'+group)).body.devices[0].id;
  assert.equal((await guest('/'+group+'/devices/'+deviceId,{settings:{...settings,ownerMode:'paused'}})).status,403);
  assert.equal((await owner('/'+group+'/devices/'+deviceId,{settings:{...settings,ownerMode:'paused'}})).status,200);
  await until(async()=>((await owner('/'+group)).body.devices[0].profile.ownerActivity.value==='ACTIVE'));
  const blocked=await guest('/'+group+'/jobs',{requestId:crypto.randomUUID(),capability:'text.count.v1',input:{text:'paused'}});assert.equal(blocked.body.error,'NO_AVAILABLE_TARGET');
  await owner('/logout',{});assert.equal((await owner('/me')).status,401);
  assert.equal((await owner('/login',{account,password:'wrong-password'})).status,400);
  assert.equal((await owner('/login',{account,password:'test-password-123'})).status,200);
 }finally{if(host&&host.connected){const done=new Promise(resolve=>host.once('exit',resolve));host.send('stop');const timer=setTimeout(()=>host.kill(),15000);await done;clearTimeout(timer);}await r.close();}
 const reopened=await createCoordinator(r.config,async()=>{},{cpuHost:true});try{await reopened.app.listen(0,'127.0.0.1');await reopened.restore();r.url='https://localhost:'+reopened.app.getHttpServer().address().port;
  assert.equal((await owner('/'+group)).body.space.name,'协同演示空间');
 }finally{await reopened.close();}
});

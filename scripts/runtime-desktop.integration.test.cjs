const {test}=require('node:test'),assert=require('node:assert/strict'),net=require('node:net'),https=require('node:https'),fs=require('node:fs'),path=require('node:path');
const {main,addresses}=require('./runtime-desktop.cjs');
const root=path.resolve(__dirname,'..');
async function until(check,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(check())return;await new Promise(r=>setTimeout(r,50));}throw Error('DESKTOP_TIMEOUT');}
test('desktop starts the real LAN coordinator, serves authenticated dashboard entry and gracefully releases the port',async()=>{
 const address=addresses()[0]?.address;assert.ok(address,'LAN adapter required');
 const reservation=net.createServer();await new Promise(r=>reservation.listen(0,'0.0.0.0',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 fs.mkdirSync(path.join(root,'.test'),{recursive:true});const dataRoot=fs.mkdtempSync(path.join(root,'.test/desktop-')),desktop=await main({openBrowser:false,role:'center'}),control=desktop.control;control.dataRoot=dataRoot;
 try{
  control.startCenter({address,port});try{await until(()=>control.state==='RUNNING'||control.state==='FAILED',60000);}catch(e){throw Error(e.message+'\n'+control.logs.join('\n'));}
  assert.equal(control.state,'RUNNING',control.logs.join('\n'));
  const certificate=fs.readFileSync(path.join(dataRoot,'desktop-'+address,'coordinator-public.crt'));
  const get=route=>new Promise((resolve,reject)=>{https.get(control.url+route,{ca:certificate},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()}));}).on('error',reject);});
  assert.equal((await get('/v2/health/ready')).status,200);
  const dashboard=await get('/dispatch.html');assert.equal(dashboard.status,200);assert.match(dashboard.body,/已接入应用与工作流声明/);
  const local=new URL(desktop.url),origin=local.origin,token=local.hash.slice(1);
  const session=await fetch(origin+'/console/session',{method:'POST',headers:{Origin:origin,'X-Runtime-Token':token},body:'{}'});
  assert.equal(session.status,200);const cookie=session.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(origin+'/photo.html')).status,403);
  const localGet=route=>fetch(origin+route,{headers:{Cookie:cookie}});
  for(const asset of ['/dispatch.html','/photo.html','/photo.js','/photo-workflow.mjs','/photo-gallery.mjs','/photo-app-port.mjs','/qrcode.js','/join-key.mjs']){
   const response=await localGet(asset);assert.equal(response.status,200,asset);assert.equal(response.headers.get('x-harmony-local-console'),'1');
  }
  const account=await (await localGet('/v2/spaces/me')).json();assert.ok(account.spaces.length);
  const space=account.spaces[0].id;
  const invite=await fetch(origin+'/v2/spaces/'+space+'/invites',{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:'{"role":"MEMBER"}'});
  assert.equal(invite.status,200);assert.equal((await invite.json()).address,control.url,'Invitations must advertise the LAN coordinator, not the loopback proxy');
  control.stop();await until(()=>control.child===null);assert.equal(control.state,'STOPPED',control.logs.join('\n'));
  const reused=net.createServer();await new Promise((resolve,reject)=>reused.once('error',reject).listen(port,'0.0.0.0',resolve));await new Promise(r=>reused.close(r));
 }finally{if(control.child){control.stop();await until(()=>control.child===null).catch(()=>{});}await new Promise(resolve=>desktop.server.close(resolve));}
});

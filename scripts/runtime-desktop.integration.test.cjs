const {test}=require('node:test'),assert=require('node:assert/strict'),net=require('node:net'),https=require('node:https'),fs=require('node:fs'),path=require('node:path');
const {RuntimeControl,addresses}=require('./runtime-desktop.cjs');
const root=path.resolve(__dirname,'..');
async function until(check,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(check())return;await new Promise(r=>setTimeout(r,50));}throw Error('DESKTOP_TIMEOUT');}
test('desktop starts the real LAN coordinator, serves authenticated dashboard entry and gracefully releases the port',async()=>{
 const address=addresses()[0]?.address;assert.ok(address,'LAN adapter required');
 const reservation=net.createServer();await new Promise(r=>reservation.listen(0,'0.0.0.0',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 fs.mkdirSync(path.join(root,'.test'),{recursive:true});const dataRoot=fs.mkdtempSync(path.join(root,'.test/desktop-')),control=new RuntimeControl({dataRoot});
 try{
  control.startCenter({address,port});try{await until(()=>control.state==='RUNNING'||control.state==='FAILED',60000);}catch(e){throw Error(e.message+'\n'+control.logs.join('\n'));}
  assert.equal(control.state,'RUNNING',control.logs.join('\n'));
  const certificate=fs.readFileSync(path.join(dataRoot,'desktop-'+address,'coordinator-public.crt'));
  const get=route=>new Promise((resolve,reject)=>{https.get(control.url+route,{ca:certificate},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()}));}).on('error',reject);});
  assert.equal((await get('/v2/health/ready')).status,200);
  const dashboard=await get('/dispatch.html');assert.equal(dashboard.status,200);assert.match(dashboard.body,/已接入应用与工作流声明/);
  control.stop();await until(()=>control.child===null);assert.equal(control.state,'STOPPED',control.logs.join('\n'));
  const reused=net.createServer();await new Promise((resolve,reject)=>reused.once('error',reject).listen(port,'0.0.0.0',resolve));await new Promise(r=>reused.close(r));
 }finally{if(control.child){control.stop();await until(()=>control.child===null).catch(()=>{});}}
});

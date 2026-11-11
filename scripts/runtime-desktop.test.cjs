const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {RuntimeControl,main}=require('./runtime-desktop.cjs');
test('desktop process controls require a session token and same-origin POST',async()=>{
 const isolated=fs.mkdtempSync(path.join(os.tmpdir(),'harmony-desktop-auth-'));
 const runtime=await main({openBrowser:false,role:'agent',bindingFile:path.join(isolated,'binding.json')}),url=new URL(runtime.url),base=url.origin,token=url.hash.slice(1);
 try{
  assert.equal((await fetch(base+'/state')).status,403);
  assert.equal((await fetch(base+'/state',{headers:{'X-Runtime-Token':token,Origin:'https://unrelated.example'}})).status,403);
  assert.equal((await fetch(base+'/stop',{method:'POST',headers:{'X-Runtime-Token':token,'Content-Type':'application/json'},body:'{}'})).status,400);
  const state=await fetch(base+'/state',{headers:{'X-Runtime-Token':token}});assert.equal(state.status,200);assert.equal((await state.json()).state,'STOPPED');
  for(const route of ['/agent/start','/agent/pair']){
   const response=await fetch(base+route,{method:'POST',headers:{'X-Runtime-Token':token,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({directory:path.join(isolated,'unpaired')})});
   assert.equal(response.status,400);assert.match(await response.text(),/配对|邀请|安装目录/);
  }
  assert.equal((await fetch(base+'/stop',{method:'POST',headers:{'X-Runtime-Token':token,Origin:base,'Content-Type':'application/json'},body:'{}'})).status,200);
 }finally{await new Promise(resolve=>runtime.server.close(resolve));fs.rmSync(isolated,{recursive:true,force:true});}
});
test('desktop refuses non-local coordinator addresses and preserves existing device installations',async()=>{
 const control=new RuntimeControl();assert.throws(()=>control.startCenter({address:'203.0.113.2'}),/LAN_ADDRESS_REQUIRED/);assert.equal(control.child,null);
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'harmony-desktop-test-'));
 try{fs.writeFileSync(path.join(directory,'sentinel'),'preserve');
  await assert.rejects(control.pair({directory,invitation:JSON.stringify({invitation:{},contribution:{},holderInstanceId:'h'})}),/安装目录已存在/);
  assert.equal(fs.readFileSync(path.join(directory,'sentinel'),'utf8'),'preserve');
 }finally{fs.unlinkSync(path.join(directory,'sentinel'));fs.rmdirSync(directory);}
});
test('desktop reports readiness only from child, rejects duplicate start, and stops through IPC',async()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'harmony-desktop-process-')),file=path.join(directory,'child.cjs'),control=new RuntimeControl();
 fs.writeFileSync(file,"process.on('message',m=>{if(m.type==='shutdown')process.exit(0)});console.log('Coordinator ready: test');");
 try{control.launch(file,[],process.env);assert.equal(control.state,'STARTING');assert.throws(()=>control.launch(file,[],process.env),/先停止/);
  const end=Date.now()+5000;while(control.state==='STARTING'&&Date.now()<end)await new Promise(r=>setTimeout(r,20));assert.equal(control.state,'RUNNING');
  const exited=new Promise(r=>control.child.once('exit',r));control.stop();await exited;assert.equal(control.state,'STOPPED');
 }finally{if(control.child)control.child.kill();fs.unlinkSync(file);fs.rmdirSync(directory);}
});
test('a host that reports COORDINATOR_GONE retires the pairing so the device can pair again',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'harmony-desktop-gone-')),device=path.join(root,'device'),child=path.join(root,'host.cjs'),control=new RuntimeControl();
 fs.mkdirSync(path.join(device,'ledger'),{recursive:true});fs.writeFileSync(path.join(device,'agent.json'),JSON.stringify({identity:{groupId:'g',deviceId:'d'},connection:{address:'https://198.51.100.7:7443/'}}));fs.writeFileSync(path.join(device,'contribution.json'),JSON.stringify({maxCpuThreads:2,maxMemoryBytes:1073741824}));
 fs.writeFileSync(child,"console.log('COORDINATOR_GONE: test');process.exitCode=3;");
 try{
  assert.equal(control.deviceStatus({directory:device}).paired,true);
  control.mode='agent';control.agentDirectory=device;control.launch(child,[],process.env);
  await new Promise(resolve=>control.child.once('exit',()=>setImmediate(resolve)));
  assert.equal(control.state,'STOPPED');assert.equal(control.snapshot().coordinatorGone,true);
  assert.equal(control.deviceStatus({directory:device}).paired,false,'the active pairing is gone');
  const retired=fs.readdirSync(root).find(name=>name.startsWith('device.retired-'));assert.ok(retired);
  assert.ok(fs.existsSync(path.join(root,retired,'ledger')),'the old ledger is kept for audit');
  fs.writeFileSync(child,'process.exitCode=1;');control.launch(child,[],process.env);assert.equal(control.snapshot().coordinatorGone,false,'a new start clears the flag');
  await new Promise(resolve=>control.child.once('exit',()=>setImmediate(resolve)));assert.equal(control.state,'FAILED');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('pairing over an old installation: same coordinator is refused, another coordinator is moved aside only after the code resolves',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'harmony-desktop-repair-')),device=path.join(root,'device'),control=new RuntimeControl();
 const pin=c=>c.repeat(64),old={connection:{address:'https://198.51.100.7:7443/',fingerprint:pin('a')}};
 fs.mkdirSync(path.join(device,'ledger'),{recursive:true});fs.writeFileSync(path.join(device,'agent.json'),JSON.stringify(old));
 try{
  await assert.rejects(control.pair({directory:device,invitation:'123456',address:'https://127.0.0.1:1',fingerprint:pin('a')}),/已与该协调中心配对/);
  await assert.rejects(control.pair({directory:device,invitation:'123456',address:'https://127.0.0.1:1',fingerprint:pin('b')}));
  assert.ok(fs.existsSync(path.join(device,'agent.json')),'an unresolved code never moves the old pairing');
  assert.equal(fs.readdirSync(root).length,1);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

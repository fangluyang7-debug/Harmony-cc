process.env.HARMONY_PAIRING_TIMEOUT_MS=process.env.HARMONY_PAIRING_TIMEOUT_MS||'1500';const PAIRING_TEST_TIMEOUT_MS=Number(process.env.HARMONY_PAIRING_TIMEOUT_MS);
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {RuntimeControl,main}=require('./runtime-desktop.cjs');
test('each desktop center start uses a new empty session, even with an old database missing its identity',t=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'harmony-center-sessions-'));
 t.mock.method(os,'networkInterfaces',()=>({test:[{address:'192.168.10.2',family:'IPv4',internal:false}]}));
 const previous=process.env.HARMONY_COORDINATOR_DATA_DIR;process.env.HARMONY_COORDINATOR_DATA_DIR=directory;
 try{
  const old=path.join(directory,'desktop-192.168.10.2');fs.mkdirSync(old);fs.writeFileSync(path.join(old,'coordinator.sqlite'),'old session');
  const launch=(control)=>{let used;control.launch=(_script,args,env)=>{assert.equal(args[2],env.COORDINATOR_DATA_DIR);used=env.COORDINATOR_DATA_DIR;};control.startCenter({address:'192.168.10.2'});return used;};
  const control=new RuntimeControl(),first=launch(control);fs.writeFileSync(path.join(first,'coordinator.sqlite'),'first session');
  const second=launch(control),third=launch(new RuntimeControl());
  assert.equal(new Set([first,second,third]).size,3);
  assert.deepEqual(fs.readdirSync(second),[]);assert.deepEqual(fs.readdirSync(third),[]);
  assert.equal(fs.readFileSync(path.join(old,'coordinator.sqlite'),'utf8'),'old session');
 }finally{if(previous===undefined)delete process.env.HARMONY_COORDINATOR_DATA_DIR;else process.env.HARMONY_COORDINATOR_DATA_DIR=previous;fs.rmSync(directory,{recursive:true,force:true});}
});
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
test('leaving a space: the coordinator must confirm unless the caller forces a local-only leave',async(t)=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'harmony-desktop-leave-')),device=path.join(root,'device'),binding=path.join(root,'binding.json');
 const control=new RuntimeControl({bindingFile:binding}),pin='a'.repeat(64);
 fs.mkdirSync(path.join(device,'ledger'),{recursive:true});
 fs.writeFileSync(path.join(device,'agent.json'),JSON.stringify({identity:{groupId:'g',deviceId:'d',holderInstanceId:'h'},directory:path.join(device,'ledger'),connection:{address:'https://127.0.0.1:1/',certificate:'-----BEGIN CERTIFICATE-----\nMA==\n-----END CERTIFICATE-----\n',fingerprint:pin,credential:'c'.repeat(43),domain:'REAL'}}));
 fs.writeFileSync(path.join(device,'ledger/ledger.json'),JSON.stringify({state:{entries:[]}}));
 fs.writeFileSync(path.join(device,'contribution.json'),JSON.stringify({ownerMode:'dedicated',maxCpuThreads:1,maxMemoryBytes:67108864,reserveMemoryBytes:0}));
 control.binding.activate(device);
 // An unrelated legacy pairing may still exist in the default directory.
 t.mock.method(os,'homedir',()=>root);
 const legacy=path.join(root,'HarmonyRuntime','device');fs.cpSync(device,legacy,{recursive:true});
 try{
  control.child={};await assert.rejects(control.leave({directory:device}),/先停止设备调度件/);control.child=null;
  await assert.rejects(control.leave({directory:device}),error=>error.code==='COORDINATOR_UNREACHABLE'&&/协调中心未确认退出/.test(error.message));
  assert.ok(fs.existsSync(path.join(device,'agent.json')),'an unconfirmed leave keeps the pairing');
  const result=await control.leave({directory:device,force:true});
  assert.equal(result.confirmed,false);assert.ok(result.directory.includes('device.left-'));
  assert.equal(control.binding.data.active,null,'the active pairing is cleared');
  assert.ok(fs.existsSync(path.join(result.directory,'ledger/ledger.json')),'the ledger is kept with the moved pairing');
  assert.equal(control.deviceStatus({}).paired,false);
  assert.throws(()=>control.startAgent({}),/请先导入邀请并完成配对/);
  assert.ok(fs.existsSync(path.join(legacy,'agent.json')),'legacy records remain untouched');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('pairing requests fail fast with an explanation when the coordinator cannot be reached',async()=>{
 const {pairingRequest}=require('./runtime-desktop.cjs');
 await assert.rejects(pairingRequest('https://127.0.0.1:1','/v2/pairing/certificate'),/拒绝连接|无法到达/);
 const net=require('node:net'),silent=net.createServer(()=>{});await new Promise(resolve=>silent.listen(0,'127.0.0.1',resolve));
 try{
  const started=Date.now();
  await assert.rejects(pairingRequest('https://127.0.0.1:'+silent.address().port,'/v2/pairing/certificate'),/秒内没有响应.*7443/);
  assert.ok(Date.now()-started<PAIRING_TEST_TIMEOUT_MS+1500,'the absolute deadline bounds a silent server');
 }finally{silent.close();}
});

const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {HostManager}=require('../../apps/windows-agent/host-manager.cjs');
test('desktop process wrapper starts, stops and resumes the saved host without pairing again',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'harmony-desktop-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 fs.writeFileSync(path.join(dir,'host-main.js'),"console.log('CPU host started: test');setInterval(()=>{},1000);process.on('message',m=>{if(m==='stop')process.exit(0);});");
 const m=new HostManager(path.join(dir,'data'),dir),a={groupId:'g',deviceId:'d',config:'unused',policy:'unused'};fs.writeFileSync(path.join(m.directory,'active.json'),JSON.stringify(a));
 assert.equal(new HostManager(m.directory,dir).status().installationId,m.status().installationId);
 await m.start();const pid=m.child.pid;await m.start();assert.equal(m.child.pid,pid);assert.equal(m.status().running,true);await m.stop();assert.equal(m.status().running,false);await m.start();assert.notEqual(m.child.pid,pid);await m.stop();
});
test('desktop drains before pairing and restores the prior host if pairing is rejected',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'harmony-desktop-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const m=new HostManager(dir,dir),old={pid:123},order=[];m.child=old;
 const previous={groupId:'old',deviceId:'old',config:path.join(dir,'old.json'),policy:'policy'};
 fs.writeFileSync(previous.config,JSON.stringify({directory:dir}));fs.writeFileSync(path.join(dir,'ledger.json'),JSON.stringify({state:{entries:[]}}));fs.writeFileSync(path.join(dir,'active.json'),JSON.stringify(previous));
 m.stop=async()=>{order.push('stop');m.child=null;};m.run=async()=>{assert.equal(m.child,null);order.push('pair');throw Error('DEVICE_PAIRING_FAILED');};m.start=async active=>{assert.equal(active.groupId,'old');order.push('restore');m.child=old;};
 await assert.rejects(m.join(JSON.stringify({holderInstanceId:'a'.repeat(36),domain:'REAL',invitation:{groupId:'new'}})),/DEVICE_PAIRING_FAILED/);assert.equal(m.child,old);assert.equal(m.busy,false);assert.deepEqual(order,['stop','pair','restore']);
});
test('desktop does not resurrect a retired identity when the newly paired host fails to start',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'harmony-desktop-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const m=new HostManager(dir,dir),started=[];m.stop=async()=>{};m.run=async(_script,args)=>{fs.mkdirSync(args[1],{recursive:true});fs.writeFileSync(path.join(args[1],'agent.json'),JSON.stringify({identity:{groupId:'next',deviceId:'new'}}));};m.start=async a=>{started.push(a.groupId);throw Error('START_FAILED');};
 await assert.rejects(m.join(JSON.stringify({holderInstanceId:'b'.repeat(36),domain:'REAL',invitation:{groupId:'next'},contribution:{}})),/START_FAILED/);
 assert.equal(m.active().groupId,'next');assert.deepEqual(started,['next']);assert.equal(m.busy,false);
});

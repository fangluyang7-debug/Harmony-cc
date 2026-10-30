const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const run=promisify(execFile),{runtime}=require('./helpers.cjs');
test('pairing CLI uses pinned invitation, stores config and refuses an existing installation',async()=>{
 const r=await runtime();try{
  const invitation=await r.auth.invite('g1','p1','device1',r.url),filename=path.join(r.config.dataDir,'invitation.json'),directory=path.join(r.config.dataDir,'installation');
  fs.writeFileSync(filename,JSON.stringify({invitation,holderInstanceId:'cli-holder',domain:'SIMULATED'}),{mode:0o600});
  const command=path.resolve('../pc-agent/dist/pairing-main.js');
  const result=await run(process.execPath,[command,filename,directory],{timeout:20000,windowsHide:true});
  const config=JSON.parse(fs.readFileSync(path.join(directory,'agent.json'),'utf8'));
  assert.equal(config.identity.holderInstanceId,'cli-holder');assert.equal((await r.auth.authenticate(config.connection.credential)).deviceId,'device1');
  assert.ok(fs.existsSync(path.join(config.directory,'ledger.initialized')));assert.ok(!result.stdout.includes(config.connection.credential));
  const original=fs.readFileSync(path.join(directory,'agent.json'),'utf8');
  await assert.rejects(run(process.execPath,[command,filename,directory],{timeout:20000,windowsHide:true}));
  assert.equal(fs.readFileSync(path.join(directory,'agent.json'),'utf8'),original);
 }finally{await r.close();}
});
test('offline provisioning CLI preserves running coordinator lock and existing physical bindings',async()=>{
 const r=await runtime(),spec=path.join(r.config.dataDir,'provision.json'),output=path.join(r.config.dataDir,'invite-output.json');
 const command=path.resolve('dist/provision-main.js'),env={...process.env,COORDINATOR_DATA_DIR:r.config.dataDir,COORDINATOR_DOMAIN:'SIMULATED'};
 fs.writeFileSync(spec,JSON.stringify({address:r.url,deviceId:'new-device',groupId:'g1',holderInstanceId:'new-holder',principalId:'p1',capacity:[{resourcePoolId:'ram',amount:1000}]}));
 try{
  await assert.rejects(run(process.execPath,[command,spec,output],{env,timeout:20000,windowsHide:true}));assert.ok(!fs.existsSync(output));
  await r.close();await run(process.execPath,[command,spec,output],{env,timeout:20000,windowsHide:true});
  const saved=fs.readFileSync(output,'utf8');assert.equal(JSON.parse(saved).holderInstanceId,'new-holder');
  await assert.rejects(run(process.execPath,[command,spec,output+'.other'],{env,timeout:20000,windowsHide:true}));
  assert.equal(fs.readFileSync(output,'utf8'),saved);assert.ok(!fs.existsSync(output+'.other'));
 }finally{await r.close();}
});

const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFile,fork}=require('node:child_process');
const {runtime}=require('./helpers.cjs');
const {allotmentTransport}=require('../../pc-agent/dist/allotment-client');
const {transfer}=require('@harmony/resource-transport');
const {submitWhenAvailable}=require('../../pc-agent/dist/submit-wait');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const command=(file,args)=>new Promise((resolve,reject)=>execFile(process.execPath,[file,...args],{windowsHide:true,timeout:60000},(e,stdout,stderr)=>e?reject(Error(stderr||e.message)):resolve(stdout)));
async function until(check,errors){const until=Date.now()+45000;while(Date.now()<until){if(await check())return;await new Promise(r=>setTimeout(r,100));}throw Error('HOST_TIMEOUT '+JSON.stringify(errors));}
test('paired standalone CPU host automatically qualifies; metadata submission -> real cross-device text/vector results through public APIs',async()=>{
 const r=await runtime({cpuHost:true});let host;const errors=[];
 try{
  const dir=r.config.dataDir,invite=await r.auth.invite('team1','owner1','worker-pc',r.url);
  await r.allotments.confirmDevice('worker-pc',[{resourcePoolId:'cpu',amount:1},{resourcePoolId:'ram',amount:268435456}],[{groupId:'team1',holderInstanceId:'worker-holder',appInstanceId:null}]);
  const invitation=path.join(dir,'invitation.json'),installation=path.join(dir,'installation'),policy=path.join(dir,'contribution.json');
  fs.writeFileSync(invitation,JSON.stringify({invitation:invite,holderInstanceId:'worker-holder',domain:'SIMULATED'}),{mode:0o600});
  await command(path.resolve('../pc-agent/dist/pairing-main.js'),[invitation,installation]);
  fs.writeFileSync(policy,JSON.stringify({ownerMode:'dedicated',maxCpuThreads:1,maxMemoryBytes:268435456,reserveMemoryBytes:0}));
  host=fork(path.resolve('../pc-agent/dist/host-main.js'),[path.join(installation,'agent.json'),policy],{windowsHide:true,stdio:['ignore','ignore','pipe','ipc']});host.stderr.on('data',b=>errors.push(b.toString().trim()));
  await until(async()=>{try{return (await r.snapshots.build('team1')).snapshot.candidates.length===2;}catch{return false;}},errors);
  const registered=await r.directory.profiles('team1');assert.equal(registered.length,1);assert.equal(registered[0].battery.value,null);
  assert.equal(registered[0].executors.length,2);assert.ok(registered[0].executors.every(e=>e.compute.source==='PRIOR'&&e.compute.value>0));
  const sourceInvite=await r.auth.invite('team1','submitter','source-laptop',r.url),source=await r.auth.exchange({inviteId:sourceInvite.inviteId,code:sourceInvite.code,holderInstanceId:'source-holder'});
  const connection={address:r.url,certificate:sourceInvite.certificate,fingerprint:sourceInvite.fingerprint,credential:source.credential,domain:'SIMULATED'},request=allotmentTransport(connection);
  const sourceConfig=path.join(dir,'source.json');fs.writeFileSync(sourceConfig,JSON.stringify({connection}),{mode:0o600});
  const input=Buffer.from(JSON.stringify({text:'Hello team\n资源协同'})),requestId=crypto.randomUUID(),metadata={requestId,capability:'text.count.v1',contentHash:hash(input),bytes:input.length};
  const plan=await request('/v2/jobs',metadata);assert.equal(plan.deviceId,'worker-pc');
  assert.equal(await r.db.attempt.count({where:{id:requestId}}),0); // Planning/registration does not dispatch before upload.
  await assert.rejects(request('/v2/jobs/'+requestId+'/start',{}),/REJECTED/);
  const repeated=await request('/v2/jobs',metadata);assert.equal(repeated.jobId,requestId);
  await assert.rejects(request('/v2/jobs',{...metadata,contentHash:'0'.repeat(64)}),/REJECTED/);
  await transfer(connection,plan.inputTicket,source.credential,input);
  await request('/v2/jobs/'+requestId+'/start',{});let result;
  await until(async()=>{result=await request('/v2/jobs/'+requestId,null);return result.outputTicket;},errors);
  const output=await transfer(connection,result.outputTicket,source.credential);assert.deepEqual(JSON.parse(output.bytes),{characters:15,words:3,lines:2});
  await request('/v2/jobs/'+requestId+'/start',{});assert.equal(await r.db.attempt.count({where:{id:requestId}}),1);
  const otherInvite=await r.auth.invite('team1','other','other-device',r.url),other=await r.auth.exchange({inviteId:otherInvite.inviteId,code:otherInvite.code,holderInstanceId:'other-holder'}),otherRequest=allotmentTransport({...connection,credential:other.credential});
  await assert.rejects(otherRequest('/v2/jobs/'+requestId,null),/REJECTED/);
  await assert.rejects(otherRequest('/v2/executions/'+requestId+'/input',{}),/REJECTED/);
  const vectorInput=path.join(dir,'vector.json'),vectorOutput=path.join(dir,'normalized.json');fs.writeFileSync(vectorInput,JSON.stringify({dimension:2,rows:[[3,4]]}));
  await command(path.resolve('../pc-agent/dist/submit-main.js'),[sourceConfig,'vector.normalize.v1',vectorInput,vectorOutput]);
  assert.deepEqual(JSON.parse(fs.readFileSync(vectorOutput)),{dimension:2,rows:[[.6,.8]],norms:[5]});
  // Use the production submission path, without a test-only readiness wait.
  for(let i=0;i<3;i++){
    const bytes=Buffer.from(JSON.stringify({text:'continuous '+i})),id=crypto.randomUUID();
    const next=await submitWhenAvailable(request,{requestId:id,capability:'text.count.v1',contentHash:hash(bytes),bytes:bytes.length},()=>{});
    await transfer(connection,next.inputTicket,source.credential,bytes);await request('/v2/jobs/'+id+'/start',{});
    let completed;await until(async()=>{completed=await request('/v2/jobs/'+id,null);assert.notEqual(completed.state,'REJECTED',JSON.stringify(completed));return completed.outputTicket;},errors);
    assert.ok(completed.decisionEvidence.profileSequence>0);
    assert.deepEqual(JSON.parse((await transfer(connection,completed.outputTicket,source.credential)).bytes),{characters:12,words:2,lines:1});
  }
  const current=await r.snapshots.build('team1');
  await r.profiles.configure('team1',{...current.policy,version:'manual-policy',allowedTargetIds:[]},
   {minimumBattery:null,maximumTemperature:null,allowMetered:true,priority:'REMOTE_INTERACTIVE',requireForeground:true});
  const beforeSequence=(await r.directory.profiles('team1'))[0].sequence;
  await until(async()=>(await r.directory.profiles('team1'))[0].sequence>beforeSequence,errors);
  assert.equal((await r.snapshots.build('team1')).policy.version,'manual-policy');
  await assert.rejects(request('/v2/jobs',{...metadata,requestId:crypto.randomUUID()}),/REJECTED/);
  await r.auth.revoke(source.peer.credentialId);await assert.rejects(request('/v2/jobs/'+requestId,null),/REJECTED/);
 }finally{
  if(host&&host.connected){const exit=new Promise(resolve=>host.once('exit',resolve));host.send('stop');const timer=setTimeout(()=>host.kill(),15000);await exit;clearTimeout(timer);}
  await r.close();
 }
});

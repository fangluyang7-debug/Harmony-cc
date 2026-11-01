const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto'),{execFile}=require('node:child_process');
const {runtime}=require('./helpers.cjs'),{start}=require('../../../tests/agent-conformance/drivers.cjs');
const {SchedulerSdk}=require('@harmony/scheduler-client'),{appRequest,nodeSdkPort}=require('@harmony/scheduler-client/dist/node');
const capacity=[{resourcePoolId:'cpu',amount:1},{resourcePoolId:'ram',amount:268435456}],settings={ownerMode:'dedicated',maxCpuThreads:1,maxMemoryBytes:268435456,reserveMemoryBytes:0};
async function until(check){const end=Date.now()+45000;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,100));}throw Error('SDK_TEST_TIMEOUT');}
test('registered SDK, alternatives, shared quota, queued cancellation, callback and registration CLI use the formal planner/receipt path',async()=>{
 const r=await runtime({cpuHost:true}),root=path.resolve('../..');let worker;
 try{
  const invitation=await r.auth.invite('sdk-group','worker-owner','sdk-worker',r.url),holder=randomUUID();
  await r.allotments.confirmDevice('sdk-worker',capacity,[{groupId:'sdk-group',holderInstanceId:holder,appInstanceId:null}]);
  const bootstrap=path.join(r.config.dataDir,'worker.json');fs.writeFileSync(bootstrap,JSON.stringify({invitation,holderInstanceId:holder,domain:'SIMULATED'}));
  worker=await start('pc',{root,dir:r.config.dataDir,bootstrap,settings});
  await until(async()=>{try{return (await r.snapshots.build('sdk-group')).snapshot.candidates.length===2;}catch{return false;}});
  const invite=await r.auth.invite('sdk-group','app-owner','sdk-origin',r.url),owner=await r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:randomUUID()}),connection={address:r.url,certificate:invite.certificate,fingerprint:invite.fingerprint,credential:owner.credential,domain:'SIMULATED'};
  const policy={label:'SDK fixture',allowedContracts:['text.count.v1'],maxConcurrent:1,resources:capacity,offlineBase:[],onlineExtra:[]};
  const ownerFile=path.join(r.config.dataDir,'owner.json'),policyFile=path.join(r.config.dataDir,'policy.json'),appFile=path.join(r.config.dataDir,'app.json');fs.writeFileSync(ownerFile,JSON.stringify({connection}));fs.writeFileSync(policyFile,JSON.stringify(policy));
  await new Promise((resolve,reject)=>execFile(process.execPath,[path.join(root,'services/pc-agent/dist/app-register-main.js'),ownerFile,policyFile,appFile],{windowsHide:true,timeout:30000},e=>e?reject(e):resolve()));
  const config=JSON.parse(fs.readFileSync(appFile)),request=appRequest(config.connection),client=new SchedulerSdk(nodeSdkPort(config.connection));
  assert.notEqual(config.connection.credential,owner.credential);
  const bytes=Buffer.from('{"text":"Hello SDK"}'),input=await client.registerInput(bytes,'text.input');
  const make=(id=randomUUID())=>({version:3,id,outputContract:'text.counts',qualityTarget:'reference',nodes:[{id:'compute',capability:'text.count.v1',input,parameters:'{}',dependsOn:[]}]}),options=()=>({requestId:randomUUID(),budgetMs:30000,resultDestination:'ORIGIN'});
  await assert.rejects(appRequest(connection)('/v2/sdk/jobs',JSON.stringify({workflow:make(),options:options()})),/APP_REGISTRATION_REQUIRED/);
  await assert.rejects(request('/v2/sdk/jobs',JSON.stringify({workflow:make(),options:options(),appId:config.identity.app.appId})),/SDK_SUBMISSION_INVALID/);
  const one=make(),two=make();two.outputContract='vector.normalized';
  await assert.rejects(client.plan({version:3,id:randomUUID(),outputContract:'text.counts',qualityTarget:'reference',alternatives:[one,two]},options()),/SDK_ALTERNATIVES_NOT_EQUIVALENT/);
  two.outputContract='text.counts';two.qualityTarget='different';
  await assert.rejects(client.plan({version:3,id:randomUUID(),outputContract:'text.counts',qualityTarget:'reference',alternatives:[one,two]},options()),/SDK_ALTERNATIVES_NOT_EQUIVALENT/);
  const bad=make();bad.nodes.push({...bad.nodes[0],id:'two'});await assert.rejects(client.plan(bad,options()),/SDK_MULTI_NODE_REQUIRES_S5/);
  const other=await r.apps.register(owner.peer,policy,r.url),otherApp=await r.apps.exchange({registrationId:other.registrationId,code:other.code}),otherClient=new SchedulerSdk(nodeSdkPort({...connection,credential:otherApp.credential}));
  const planned=await client.plan(make(),options());assert.equal(await r.db.attempt.count({where:{id:planned.jobId}}),0);
  await assert.rejects(otherClient.plan(make(),options()),/APP_QUOTA_EXCEEDED/);
  assert.equal(JSON.parse(await client.resume(planned.jobId).cancel()).state,'CANCELLED');assert.equal((await client.resume(planned.jobId).status()).state,'CANCELLED');
  await assert.rejects(client.resume(planned.jobId).result(),/JOB_CANCELLED/);
  one.nodes[0].targetId='not-qualified';two.qualityTarget='reference';
  const task=await client.submit({version:3,id:randomUUID(),outputContract:'text.counts',qualityTarget:'reference',alternatives:[one,two]},options());
  const result=await new Promise((resolve,reject)=>task.onResult(resolve,reject));assert.deepEqual(JSON.parse(Buffer.from(result.output)),{characters:9,words:2,lines:1});
  const stored=await r.db.cpuJob.findUnique({where:{id:task.id}}),offer=JSON.parse(stored.metadataJson).offer;
  assert.equal(offer.task.app.appInstanceId,config.identity.app.appInstanceId);assert.equal(offer.task.app.appId,config.identity.app.appId);assert.equal(await r.db.attempt.count({where:{id:task.id}}),1);
  assert.equal((await r.db.receipt.findUnique({where:{id:task.id}})).committed,true);
  const vectorInput=await client.registerInput(Buffer.from('{"dimension":2,"rows":[[3,4]]}'),'vector.input'),vector=make();vector.outputContract='vector.normalized';vector.nodes[0].capability='vector.normalize.v1';vector.nodes[0].input=vectorInput;
  await assert.rejects(client.plan(vector,options()),/APP_CONTRACT_FORBIDDEN/);
  await r.apps.revoke(owner.peer,config.identity.app.appInstanceId);await assert.rejects(client.resume(task.id).status(),/CREDENTIAL_REVOKED|APP_CREDENTIAL_REVOKED/);
 }finally{await worker?.stop();await r.close();}
});

const {test}=require('node:test'),assert=require('node:assert/strict'),https=require('node:https'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFile,fork}=require('node:child_process');
const {runtime}=require('./helpers.cjs');
const {createCoordinator}=require('../dist/app');
function browser(r){let cookie='';const send=async(route,body,origin,binary=false)=>new Promise((resolve,reject)=>{const bytes=body===undefined?null:binary?Buffer.from(body):Buffer.from(JSON.stringify(body));const q=https.request(r.url+'/v2/spaces'+route,{ca:r.identity.cert,method:bytes?(binary?'PUT':'POST'):'GET',headers:{Cookie:cookie,...(origin?{Origin:origin}:{}),...(bytes?{'Content-Type':binary?'application/octet-stream':'application/json','Content-Length':bytes.length}:{})}},res=>{if(res.headers['set-cookie'])cookie=res.headers['set-cookie'][0].split(';')[0];const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>{try{const data=Buffer.concat(chunks);resolve({status:res.statusCode,body:res.headers['content-type']?.startsWith('application/octet-stream')?data:JSON.parse(data)});}catch(e){reject(e);}});});q.on('error',reject);q.end(bytes);});const request=(route,body,origin)=>send(route,body,origin);request.binary=(route,body,origin)=>send(route,body,origin,true);return request;}
async function until(check,timeoutMs=45000){const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){if(await check())return;await new Promise(r=>setTimeout(r,150));}throw Error('SPACE_TIMEOUT');}
const command=(file,args)=>new Promise((resolve,reject)=>execFile(process.execPath,[file,...args],{windowsHide:true,timeout:60000},(e,stdout,stderr)=>e?reject(Error(stderr||e.message)):resolve(stdout)));
test('short device QR uses a pinned, single-use invitation and keeps legacy downloads compatible',async()=>{
 const r=await runtime();r.config.publicUrl=r.url;
 const owner=browser(r),{pinnedOptions,pinnedRequest}=require('../dist/pinned-client');
 try{
  assert.equal((await owner('/register',{account:crypto.randomUUID(),name:'负责人',password:'test-password-123'})).status,200);
  const group=(await owner('/',{name:'配对空间'})).body.id;
  const settings={ownerMode:'dedicated',maxCpuThreads:1,maxMemoryBytes:268435456,reserveMemoryBytes:0};
  const issued=await owner('/'+group+'/devices',{name:'短码设备',settings,qrFormat:'link'});
  assert.equal(issued.status,200);
  const {qr,invitation,holderInstanceId,domain,contribution}=issued.body;
  const payload=r.url+'/#device='+invitation.inviteId+'.'+invitation.code+'&pin='+invitation.fingerprint;
  const qrCode=require('qrcode'),options={errorCorrectionLevel:'L',margin:4,width:640};
  assert.equal(qr,await qrCode.toDataURL(payload,options));
  assert.ok(qrCode.create(payload,options).modules.size<80);
  const request=(route,body)=>new Promise((resolve,reject)=>{
   const data=body===undefined?null:JSON.stringify(body);
   const req=https.request(r.url+route,{...pinnedOptions(invitation),method:data?'POST':'GET',
    headers:data?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}:{}},res=>{
     let text='';res.setEncoding('utf8').on('data',part=>{text+=part;});
     res.on('end',()=>resolve({status:res.statusCode,text,cache:res.headers['cache-control']}));
    });req.on('error',reject);req.end(data??undefined);
  });
  const cert=await request('/v2/pairing/certificate');
  assert.deepEqual(cert,{status:200,text:invitation.certificate,cache:'no-store'});
  const body={inviteId:invitation.inviteId,code:invitation.code};
  assert.equal((await request('/v2/pairing/bootstrap',{...body,code:'0'.repeat(24)})).status,401);
  const preview=await request('/v2/pairing/bootstrap',body);
  assert.equal(preview.status,201);
  assert.equal(preview.cache,'no-store');
  assert.deepEqual(JSON.parse(preview.text),{invitation,holderInstanceId,domain,contribution});
  assert.equal((await request('/v2/pairing/bootstrap',body)).status,201,'A preview does not consume an invite');
  await pinnedRequest(invitation,'/v2/pair',{...body,holderInstanceId});
  assert.equal((await request('/v2/pairing/bootstrap',body)).status,401);
  assert.equal((await request('/v2/pairing/code',{code:issued.body.pairingCode})).status,401,'QR exchange invalidates numeric code');
  const legacy=await owner('/'+group+'/devices',{name:'原有设备',settings});
  const {qr:legacyQr,pairingCode:legacyCode,pairingCodeExpiresAt:legacyExpiry,...legacyBootstrap}=legacy.body;
  assert.equal(legacyQr,await qrCode.toDataURL(JSON.stringify(legacyBootstrap),options));
  assert.match(legacyCode,/^\d{6}$/);
  assert.ok(legacyExpiry<=Date.now()+300000);
  const {resolvePairingInput,pairingCertificate}=require('../../../scripts/runtime-desktop.cjs');
  const trust=await pairingCertificate(r.url);
  assert.equal(trust.fingerprint,invitation.fingerprint);
  await assert.rejects(resolvePairingInput({invitation:legacyCode,address:r.url,fingerprint:'0'.repeat(64)}),/证书/);
  const numeric=await resolvePairingInput({invitation:legacyCode,address:r.url,fingerprint:trust.fingerprint});
  assert.deepEqual(numeric,legacyBootstrap);
  assert.equal((await request('/v2/pairing/code',{code:legacyCode})).status,401,'numeric code is single use');
  await pinnedRequest(numeric.invitation,'/v2/pair',{inviteId:numeric.invitation.inviteId,code:numeric.invitation.code,holderInstanceId:numeric.holderInstanceId});
  const another=await owner('/'+group+'/devices',{name:'链接设备',settings,qrFormat:'link'});
  const i=another.body.invitation;
  const linked=await resolvePairingInput({invitation:i.address+'/#device='+i.inviteId+'.'+i.code+'&pin='+i.fingerprint});
  assert.equal(linked.invitation.inviteId,i.inviteId);

 }finally{await r.close();}
});
test('browser spaces persist, isolate roles and operate a paired CPU host with a fast device clock',async()=>{
 const r=await runtime({cpuHost:true});r.config.publicUrl=r.url;let host;
 const owner=browser(r),guest=browser(r),stranger=browser(r);const account=crypto.randomUUID();let group;
 try{
  assert.equal((await owner('/me')).status,401);
  const registered=await owner('/register',{account,name:'负责人',password:'test-password-123'});assert.equal(registered.status,200);const ownerId=registered.body.user.id;
  assert.equal((await owner('/',{name:'空间'},'https://unrelated.example')).status,400);
  group=(await owner('/',{name:'协同演示空间'})).body.id;assert.ok(group);
  assert.equal((await owner('/'+group)).body.devices.length,0);
  assert.equal((await owner('/'+group+'/jobs',{requestId:crypto.randomUUID(),capability:'text.count.v1',input:{text:'empty'}})).body.error,'NO_LEGAL_PLAN');
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
  assert.match(device.body.qr,/^data:image\/png;base64,/);
  assert.deepEqual(device.body.contribution,settings,'QR bootstrap retains the owner-confirmed resource policy');
  const dir=r.config.dataDir,file=path.join(dir,'space-invitation.json'),installation=path.join(dir,'space-host'),policy=path.join(dir,'space-policy.json');
  fs.writeFileSync(file,JSON.stringify(device.body));fs.writeFileSync(policy,JSON.stringify(settings));
  await command(path.resolve('../pc-agent/dist/pairing-main.js'),[file,installation]);
  host=fork(path.resolve('../pc-agent/dist/host-main.js'),[path.join(installation,'agent.json'),policy],{windowsHide:true,execArgv:['--require',path.resolve('test/fast-clock.cjs')],stdio:['ignore','ignore','pipe','ipc']});
  host.stderr.on('data',b=>console.error('Host diagnostic:',b.toString().trim()));
  await until(async()=>{const s=(await owner('/'+group)).body;return s.devices[0].online&&s.devices[0].capabilities.every(c=>c.available&&c.state==='ACTIVE')&&['text.count.v1','vector.normalize.v1','image.crop.v1'].every(id=>s.devices[0].capabilities.some(c=>c.capability===id));},180000);
  const id=crypto.randomUUID(),submitted=await guest('/'+group+'/jobs',{requestId:id,capability:'text.count.v1',input:{text:'Hello team'}});assert.equal(submitted.status,200,JSON.stringify(submitted.body));
  let result;await until(async()=>{result=await guest('/'+group+'/jobs/'+id);return result.body.output;});
  assert.deepEqual(result.body.output,{characters:10,words:2,lines:1});assert.equal((await owner('/'+group+'/jobs/'+id)).status,400);
  let trace;await until(async()=>{trace=await guest('/'+group+'/jobs/'+id+'/trace');return trace.status===200&&['PLAN','OFFER','ADMIT','QUEUE','EXECUTE','PUBLISH'].every(p=>trace.body.spans.some(s=>s.phase===p));});
  assert.ok(trace.body.spans.every(s=>s.snapshotVersion===result.body.decisionEvidence.snapshotVersion));
  assert.equal((await owner('/'+group+'/jobs/'+id+'/trace')).status,400);
  const {SchedulerSdk}=require('@harmony/scheduler-client');
  const sdk=new SchedulerSdk({request:async(route,body)=>{const response=await guest('/'+group+route.replace('/v2/sdk','/sdk'),body===null?undefined:JSON.parse(body));assert.equal(response.status,200,JSON.stringify(response.body));return JSON.stringify(response.body);},write:async(ticket,bytes)=>{const response=await guest.binary('/'+group+'/sdk/jobs/'+ticket.ref.artifactId.slice(3)+'/input',bytes);assert.equal(response.status,200,JSON.stringify(response.body));},read:async ticket=>{const response=await guest.binary('/'+group+'/sdk/jobs/'+ticket.ref.artifactId.slice(4)+'/output');assert.equal(response.status,200);return response.body;},digest:async bytes=>crypto.createHash('sha256').update(bytes).digest('hex'),now:Date.now,wait:ms=>new Promise(resolve=>setTimeout(resolve,ms))});
  const sdkInput=await sdk.registerInput(Buffer.from('{"text":"SDK browser"}'),'text.input'),sdkId=crypto.randomUUID(),workflow={version:3,id:sdkId,outputContract:'text.counts',qualityTarget:'reference',nodes:[{id:'compute',capability:'text.count.v1',input:sdkInput,parameters:'{}',dependsOn:[]}]},sdkOptions={requestId:sdkId,budgetMs:30000,resultDestination:'ORIGIN'};
  const sdkPlan=await sdk.plan(workflow,sdkOptions),descriptor=r.artifacts.lookup(group,sdkPlan.inputTicket.ref);assert.equal(r.artifacts.available(descriptor),false);assert.equal(await r.db.attempt.count({where:{id:sdkId}}),0);
  assert.equal((await guest.binary('/'+group+'/sdk/jobs/'+sdkId+'/input',Buffer.from('{"text":"SDK browser"}'),'https://unrelated.example')).body.error,'ORIGIN_REJECTED');
  const sdkTask=await sdk.submit(workflow,sdkOptions),sdkResult=await sdkTask.result();assert.deepEqual(JSON.parse(Buffer.from(sdkResult.output)),{characters:11,words:2,lines:1});
  assert.equal(sdkResult.status.state,'SUCCEEDED');
  const delivered=JSON.parse((await r.db.cpuJob.findUnique({where:{id:sdkId}})).metadataJson);
  assert.ok(delivered.resultReceivedAt,'space SDK result acknowledgement must reach the formal received endpoint');
  const ack={ref:delivered.output.ref,bytes:delivered.output.bytes};
  assert.equal((await guest('/'+group+'/sdk/jobs/'+sdkId+'/received',ack)).status,200,'acknowledgement is idempotent');
  assert.equal((await owner('/'+group+'/sdk/jobs/'+sdkId+'/received',ack)).body.error,'JOB_SCOPE');
  assert.equal((await sdkTask.status()).outputTicket,null);
  const appInstallation=await r.db.registeredInstallation.findFirst({where:{principalId:guestId}});assert.equal(appInstallation.state,'ACTIVE');assert.deepEqual(JSON.parse(appInstallation.offlineJson),[]);
  const deviceId=(await owner('/'+group)).body.devices[0].id;
  assert.equal((await guest('/'+group+'/devices/'+deviceId,{settings:{...settings,ownerMode:'paused'}})).status,403);
  assert.equal((await owner('/'+group+'/devices/'+deviceId,{settings:{...settings,ownerMode:'paused'}})).status,200);
  await until(async()=>((await owner('/'+group)).body.devices[0].profile.ownerActivity.value==='ACTIVE'));
  const blocked=await guest('/'+group+'/jobs',{requestId:crypto.randomUUID(),capability:'text.count.v1',input:{text:'paused'}});assert.equal(blocked.body.error,'NO_LEGAL_PLAN');
  const gpu=await owner('/'+group+'/devices',{name:'PC-B',settings:{...settings,maxVramBytes:1073741824}});assert.equal(gpu.status,200);assert.equal(gpu.body.contribution.maxVramBytes,1073741824);
  await owner('/logout',{});assert.equal((await owner('/me')).status,401);
  assert.equal((await owner('/login',{account,password:'wrong-password'})).status,400);
  assert.equal((await owner('/login',{account,password:'test-password-123'})).status,200);
 }finally{if(host&&host.connected){const done=new Promise(resolve=>host.once('exit',resolve));host.send('stop');const timer=setTimeout(()=>host.kill(),15000);await done;clearTimeout(timer);}await r.close();}
 const reopened=await createCoordinator(r.config,async()=>{},{cpuHost:true});try{await reopened.app.listen(0,'127.0.0.1');await reopened.restore();r.url='https://localhost:'+reopened.app.getHttpServer().address().port;
  assert.equal((await owner('/'+group)).body.space.name,'协同演示空间');
 }finally{await reopened.close();}
});
test('automatic capacity follows the hardware a paired device reports',async()=>{
 const r=await runtime();r.config.publicUrl=r.url;
 const owner=browser(r),{pinnedOptions,pinnedRequest}=require('../dist/pinned-client');
 const GiB=1073741824,MiB=1048576;
 const settingsCall=(invitation,credential,body)=>new Promise((resolve,reject)=>{
  const data=JSON.stringify(body);
  const req=https.request(r.url+'/v2/device-settings',{...pinnedOptions(invitation),method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data),Authorization:'Bearer '+credential}},res=>{
   let text='';res.setEncoding('utf8').on('data',part=>{text+=part;});res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));
  });req.on('error',reject);req.end(data);
 });
 const pairDevice=async(name,settings)=>{
  const issued=await owner('/'+group+'/devices',{name,settings});assert.equal(issued.status,200,JSON.stringify(issued.body));
  const {invitation,holderInstanceId}=issued.body;
  const paired=await pinnedRequest(invitation,'/v2/pair',{inviteId:invitation.inviteId,code:invitation.code,holderInstanceId});
  return {invitation,credential:paired.credential,contribution:issued.body.contribution,deviceId:paired.peer.deviceId};
 };
 let group;
 try{
  assert.equal((await owner('/register',{account:crypto.randomUUID(),name:'负责人',password:'test-password-123'})).status,200);
  group=(await owner('/',{name:'自动额度'})).body.id;
  const provisional={ownerMode:'dedicated',capacityMode:'auto',maxCpuThreads:2,maxMemoryBytes:GiB,reserveMemoryBytes:GiB};
  assert.equal((await owner('/'+group+'/devices',{name:'坏额度方式',settings:{...provisional,capacityMode:'later'}})).status,400);
  const phone=await pairDevice('手机',provisional);
  assert.deepEqual(phone.contribution,provisional,'The invitation still carries the provisional ceiling for the first connection');
  const unchanged=await settingsCall(phone.invitation,phone.credential,{});
  assert.deepEqual(unchanged.body.settings,provisional,'A poll without measurements keeps the provisional ceiling');
  assert.equal((await settingsCall(phone.invitation,phone.credential,{measured:{cpuThreads:0,totalMemoryBytes:8*GiB}})).body.error,'MEASUREMENT_INVALID');
  assert.equal((await settingsCall(phone.invitation,phone.credential,{measured:{totalMemoryBytes:8*GiB,storageBytes:1e12}})).body.error,'MEASUREMENT_INVALID','Storage is not a RAM measurement');
  const eightGig=await settingsCall(phone.invitation,phone.credential,{measured:{cpuThreads:null,totalMemoryBytes:8*GiB}});
  assert.equal(eightGig.status,201,JSON.stringify(eightGig.body));
  const expected={...provisional,maxMemoryBytes:7.75*GiB,reserveMemoryBytes:256*MiB};
  assert.deepEqual(eightGig.body.settings,expected,'8 GiB RAM: 256 MiB free headroom, the rest is the ceiling; unknown CPU keeps the provisional slots');
  assert.deepEqual((await owner('/'+group)).body.devices.find(d=>d.id===phone.deviceId).settings,expected,'The dashboard shows the derived ceiling');
  const budget=JSON.parse((await r.db.device.findUnique({where:{id:JSON.stringify(['budget',phone.deviceId])}})).metadataJson);
  assert.deepEqual(budget.capacity,[{resourcePoolId:'cpu',amount:2},{resourcePoolId:'ram',amount:7.75*GiB}],'The physical budget follows the derived ceiling');
  const withCpu=await settingsCall(phone.invitation,phone.credential,{measured:{cpuThreads:8,totalMemoryBytes:8*GiB}});
  assert.deepEqual(withCpu.body.settings,{...expected,maxCpuThreads:7},'Dedicated devices retain one logical CPU for interaction');
  assert.deepEqual((await settingsCall(phone.invitation,phone.credential,{measured:{cpuThreads:8,totalMemoryBytes:8*GiB}})).body.settings,{...expected,maxCpuThreads:7},'Re-reporting the same hardware is idempotent');
  const small=await settingsCall(phone.invitation,phone.credential,{measured:{cpuThreads:2,totalMemoryBytes:2*GiB}});
  assert.deepEqual(small.body.settings,{...provisional,maxCpuThreads:1,maxMemoryBytes:1.875*GiB,reserveMemoryBytes:128*MiB},'2 GiB RAM: bounded headroom leaves room for real work');
  const tiny=await settingsCall(phone.invitation,phone.credential,{measured:{cpuThreads:1,totalMemoryBytes:512*MiB}});
  assert.deepEqual(tiny.body.settings,{...provisional,maxCpuThreads:1,maxMemoryBytes:384*MiB,reserveMemoryBytes:128*MiB},'Small hardware does not inherit a 1 GiB reserve');
  const desktop=await settingsCall(phone.invitation,phone.credential,{measured:{cpuThreads:22,totalMemoryBytes:32*GiB}});
  assert.deepEqual(desktop.body.settings,{...provisional,maxCpuThreads:21,maxMemoryBytes:31.5*GiB,reserveMemoryBytes:512*MiB},'Desktop headroom is capped, not a quarter of physical RAM');
  const fixed=await pairDevice('固定额度',{ownerMode:'dedicated',maxCpuThreads:2,maxMemoryBytes:GiB,reserveMemoryBytes:GiB});
  const ignored=await settingsCall(fixed.invitation,fixed.credential,{measured:{cpuThreads:16,totalMemoryBytes:32*GiB}});
  assert.deepEqual(ignored.body.settings,fixed.contribution,'A fixed-capacity device keeps the owner-confirmed ceiling');
 }finally{await r.close();}
});

const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {runtime}=require('./helpers.cjs');
const {builtinCpuPacks}=require('@harmony/reference-capabilities');
const {CpuHost}=require('../../pc-agent/dist/host'),{DurableLedger}=require('../../pc-agent/dist/durable-ledger');
test('fixed service uses only origin App credentials, shared qualification, planning and receipt path',async()=>{
 const secret=randomUUID();let calls=0,host,r;
 const server=http.createServer((req,res)=>{
  if(req.headers.authorization!=='Bearer '+secret){res.writeHead(401);res.end();return;}
  const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{calls++;const {text}=JSON.parse(Buffer.concat(chunks));res.setHeader('content-type','application/json');res.end(JSON.stringify({characters:Array.from(text).length,words:text.trim()?text.trim().split(/\s+/u).length:0,lines:text.length?text.split(/\r\n|\r|\n/u).length:0}));});
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=builtinCpuPacks().find(p=>p.manifest.contract.capability==='text.count.v1');
 const pack={...base,manifest:{...base.manifest,packId:'service.text.reference',contract:{...base.manifest.contract,contractId:'service.text.v1',capability:'service.text.v1',serviceId:'fixture.text.service'}}};
 try{
  r=await runtime({cpuHost:true,referencePacks:[...builtinCpuPacks(),pack]});
  const group=randomUUID(),device=randomUUID(),holder=randomUUID(),capacity=[{resourcePoolId:'cpu',amount:1},{resourcePoolId:'ram',amount:268435456}];
  const invite=await r.auth.invite(group,randomUUID(),device,r.url),owner=await r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:holder});
  await r.allotments.confirmDevice(device,capacity,[{groupId:group,holderInstanceId:holder,appInstanceId:null}]);
  const invitation=await r.apps.register(owner.peer,{label:'Service App',allowedContracts:['service.text.v1'],maxConcurrent:1,resources:capacity,offlineBase:capacity,onlineExtra:[]},r.url),registered=await r.apps.exchange({registrationId:invitation.registrationId,code:invitation.code});
  const identity={groupId:group,deviceId:device,holderInstanceId:registered.peer.holderInstanceId,appInstanceId:registered.peer.app.appInstanceId},directory=path.join(r.config.dataDir,'service-ledger');
  const ledger=await DurableLedger.open(directory,identity,invite.certificate);await ledger.close();
  const errors=[];
  host=await CpuHost.open({directory,identity,connection:{address:r.url,certificate:invite.certificate,fingerprint:invite.fingerprint,credential:registered.credential,domain:'SIMULATED'},controlIntervalMs:2000,contribution:{ownerMode:'dedicated',maxCpuThreads:1,maxMemoryBytes:268435456,reserveMemoryBytes:0},fixedServices:[{pack,execute:async(input,_parameters,signal)=>{
   const response=await fetch('http://127.0.0.1:'+server.address().port,{method:'POST',headers:{authorization:'Bearer '+secret},body:input,signal});if(!response.ok)throw Error('SERVICE_REJECTED');return {bytes:Buffer.from(await response.arrayBuffer()),schemaId:'text.counts'};
  }}]},e=>errors.push(String(e)));host.start();
  const deadline=Date.now()+45000;let ready=false;
  while(Date.now()<deadline){try{if((await r.snapshots.build(group)).snapshot.candidates.some(c=>c.serviceId==='fixture.text.service')){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,200));}
  assert.ok(ready,JSON.stringify(errors));
  const sdk=host.sdk(),input=await sdk.registerInput(Buffer.from('{"text":"service"}'),'text.input'),id=randomUUID();
  const task=await sdk.submit({version:3,id,outputContract:'text.counts',qualityTarget:'reference',nodes:[{id:'query',capability:'service.text.v1',input,parameters:'{}',dependsOn:[]}]},{requestId:id,budgetMs:30000,resultDestination:'ORIGIN',inputLocation:'ORIGIN'});
  const result=await task.result();assert.equal(JSON.parse(Buffer.from(result.output)).characters,7);assert.ok(calls>=2);
  const row=await r.db.cpuJob.findUnique({where:{id}}),data=JSON.parse(row.metadataJson);
  assert.equal(data.offer.target.backend,'SERVICE');assert.equal(data.holderId,identity.holderInstanceId);assert.equal(row.metadataJson.includes(secret),false);assert.equal(row.metadataJson.includes('127.0.0.1:'+server.address().port),false);
  assert.equal(r.artifacts.available(data.input),false);assert.equal(r.artifacts.available(data.output),false);assert.equal((await r.db.receipt.findUnique({where:{id}})).committed,true);
 }finally{await host?.close();await r?.close();await new Promise(resolve=>server.close(resolve));}
});

const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),path=require('node:path'),crypto=require('node:crypto');
const {runtime}=require('./helpers.cjs');
const {builtinCpuPacks,vectorSearchPack,packDigest}=require('@harmony/reference-capabilities');
const {CpuHost}=require('../../pc-agent/dist/host'),{DurableLedger}=require('../../pc-agent/dist/durable-ledger');
const {vectorSearchAdapter,verifyVectorSearchSpace}=require('../../pc-agent/dist/service-adapters');
const {allotmentTransport}=require('../../pc-agent/dist/allotment-client');
const {submitWhenAvailable}=require('../../pc-agent/dist/submit-wait');
const {appRequest}=require('@harmony/scheduler-client/dist/node');
const {transfer}=require('@harmony/resource-transport');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
async function until(check,errors,timeoutMs=180000){const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){if(await check())return;await new Promise(r=>setTimeout(r,1000));}throw Error('SERVICE_HOST_TIMEOUT '+JSON.stringify(errors));}

const model={modelId:'fixture',version:'v1',weightsHash:'a'.repeat(64),preprocessVersion:'rgb',embeddingKind:'image',dimension:2,dtype:'float32',normalization:'l2'};
const space={serviceId:'fixture.catalog',indexSpaceId:'fixture',indexVersion:'v1',model};
const entries=[{productId:'p-a',vector:[1,0],category:'shoe'},{productId:'p-b',vector:[0,1],category:'bag'},{productId:'p-c',vector:[Math.SQRT1_2,Math.SQRT1_2],category:'shoe'}];

/** Stand-in for the business service's documented vector search API (bearer protected). */
function fixtureService(secret,seen){
 return http.createServer((req,res)=>{
  if(req.headers.authorization!=='Bearer '+secret){res.writeHead(401);res.end();return;}
  const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
   res.setHeader('content-type','application/json');
   if(req.method==='GET'&&req.url==='/api/v2/image-search/spaces/fixture'){res.end(JSON.stringify({indexSpaceId:'fixture',indexVersion:'v1',model}));return;}
   if(req.method!=='POST'||req.url!=='/api/v2/image-search/vector'){res.writeHead(404);res.end();return;}
   let body;try{body=JSON.parse(Buffer.concat(chunks));}catch{res.writeHead(400);res.end(JSON.stringify({code:'IMAGE_V2_INPUT_INVALID'}));return;}
   seen.push(body);const v=body.vector;
   if(!Array.isArray(v)||v.length!==2||!v.every(Number.isFinite)||body.indexSpaceId!=='fixture'||!Number.isInteger(body.topK)){res.writeHead(400);res.end(JSON.stringify({code:'IMAGE_V2_INPUT_INVALID'}));return;}
   const candidates=entries.filter(e=>body.filters?.category===undefined||e.category===body.filters.category)
    .map(e=>({productId:e.productId,score:e.vector[0]*v[0]+e.vector[1]*v[1]})).sort((a,b)=>b.score-a.score||a.productId.localeCompare(b.productId)).slice(0,body.topK);
   res.end(JSON.stringify({requestId:body.requestId,indexSpaceId:'fixture',indexVersion:'v1',model,candidates,scoreMeaning:'COSINE_SIMILARITY',nextPage:null,processingMs:1}));
  });
 });
}

test('shared service pack is deterministic and the adapter maps service answers and refusals',async()=>{
 const pack=vectorSearchPack(space);
 assert.equal(packDigest(pack),packDigest(vectorSearchPack(JSON.parse(JSON.stringify(space)))));
 assert.equal(pack.manifest.contract.serviceId,'fixture.catalog');assert.equal(pack.manifest.contract.sideEffectPolicy,'PURE');
 assert.deepEqual(pack.cases.map(c=>c.expect.kind),['OUTPUT','OUTPUT','OUTPUT','OUTPUT','REJECT','REJECT']);
 const secret=crypto.randomUUID(),seen=[],server=fixtureService(secret,seen);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const connection={baseUrl:'http://127.0.0.1:'+server.address().port+'/',token:secret};
 try{
  await verifyVectorSearchSpace(space,connection);
  await assert.rejects(verifyVectorSearchSpace({...space,indexVersion:'v2'},connection),/SERVICE_INDEX_MISMATCH/);
  await assert.rejects(verifyVectorSearchSpace(space,{...connection,token:'wrong'}),/SERVICE_INDEX_UNAVAILABLE/);
  const adapter=vectorSearchAdapter(pack,space,connection),signal=new AbortController().signal;
  for(const c of pack.cases){
   if(c.expect.kind==='OUTPUT'){const out=await adapter.execute(c.input,c.parameters,signal);assert.equal(out.schemaId,'candidate.list');assert.equal(await pack.evaluate(c,out.bytes),1);}
   else await assert.rejects(adapter.execute(c.input,c.parameters,signal),new RegExp(c.expect.errorCode));
  }
  await assert.rejects(adapter.execute(pack.cases[0].input,JSON.stringify({indexSpaceId:'other',topK:1}),signal),/VECTOR_QUERY_INVALID/);
  const aborted=new AbortController();aborted.abort();
  await assert.rejects(adapter.execute(pack.cases[0].input,pack.cases[0].parameters,aborted.signal),/CANCELLED_SETTLED/);
  assert.ok(seen.every(b=>typeof b.requestId==='string'&&b.model.modelId==='fixture'));
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('a business service registers vector search as an ordinary target; a different App is routed to it without host binding',async()=>{
 const secret=crypto.randomUUID(),seen=[],server=fixtureService(secret,seen);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const baseUrl='http://127.0.0.1:'+server.address().port+'/',pack=vectorSearchPack(space);
 let host,r;const errors=[];
 try{
  r=await runtime({cpuHost:true,referencePacks:[...builtinCpuPacks(),pack]});
  const group='team-'+crypto.randomUUID().slice(0,8),capacity=[{resourcePoolId:'cpu',amount:1},{resourcePoolId:'ram',amount:268435456}];
  // The service host has its own device and holder and is not an App host (appInstanceId null).
  const serviceDevice='catalog-service',serviceHolder='service-holder';
  const invite=await r.auth.invite(group,'service-owner',serviceDevice,r.url),paired=await r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:serviceHolder});
  await r.allotments.confirmDevice(serviceDevice,capacity,[{groupId:group,holderInstanceId:serviceHolder,appInstanceId:null}]);
  const identity={groupId:group,deviceId:serviceDevice,holderInstanceId:serviceHolder,appInstanceId:null},directory=path.join(r.config.dataDir,'service-ledger');
  const ledger=await DurableLedger.open(directory,identity,invite.certificate);await ledger.close();
  const connection={baseUrl,token:secret};
  host=await CpuHost.open({directory,identity,connection:{address:r.url,certificate:invite.certificate,fingerprint:invite.fingerprint,credential:paired.credential,domain:'SIMULATED'},controlIntervalMs:2000,
   contribution:{ownerMode:'dedicated',maxCpuThreads:1,maxMemoryBytes:268435456,reserveMemoryBytes:0},services:[vectorSearchAdapter(pack,space,connection)]},e=>errors.push(String(e)));host.start();
  await until(async()=>{try{return (await r.snapshots.build(group)).snapshot.candidates.some(c=>c.serviceId==='fixture.catalog'&&c.capability==='vector.search.v1');}catch{return false;}},errors);
  const qualifying=seen.length;assert.ok(qualifying>=4,'reference cases must run against the real service, got '+qualifying);
  // A different App on a different device submits. It never installed the service itself.
  const appInvite=await r.auth.invite(group,'shopper','phone-a',r.url),owner=await r.auth.exchange({inviteId:appInvite.inviteId,code:appInvite.code,holderInstanceId:'phone-holder'});
  const registration=await r.apps.register(owner.peer,{label:'Shopping App',allowedContracts:['vector.search.v1'],maxConcurrent:4,resources:capacity.map(r=>({...r,amount:r.amount*4})),offlineBase:[],onlineExtra:[]},r.url);
  const app=await r.apps.exchange({registrationId:registration.registrationId,code:registration.code});
  const appConnection={address:r.url,certificate:appInvite.certificate,fingerprint:appInvite.fingerprint,credential:app.credential,domain:'SIMULATED'},request=allotmentTransport(appConnection);
  const input=Buffer.from(JSON.stringify({model,vector:[Math.SQRT1_2,Math.SQRT1_2]})),requestId=crypto.randomUUID();
  const plan=await submitWhenAvailable(request,{requestId,capability:'vector.search.v1',contentHash:hash(input),bytes:input.length,parameters:JSON.stringify({indexSpaceId:'fixture',topK:2})},()=>{});
  assert.equal(plan.deviceId,serviceDevice);
  await transfer(appConnection,plan.inputTicket,app.credential,input);
  await request('/v2/jobs/'+requestId+'/start',{});
  let result;await until(async()=>{result=await request('/v2/jobs/'+requestId,null);return !!result.outputTicket;},errors);
  const output=JSON.parse((await transfer(appConnection,result.outputTicket,app.credential)).bytes);
  assert.deepEqual(output.candidates.map(c=>c.productId),['p-c','p-a']);assert.equal(output.indexVersion,'v1');
  // Candidate evidence: exactly one target had registered this capability; nothing was pinned.
  assert.equal(result.decisionEvidence.candidateCount,1);
  const row=await r.db.cpuJob.findUnique({where:{id:requestId}}),data=JSON.parse(row.metadataJson);
  assert.equal(data.offer.target.backend,'SERVICE');assert.equal(data.offer.target.executorId,'service.http.v1');
  assert.equal(data.holderId,serviceHolder);assert.notEqual(data.holderId,'phone-holder');assert.equal(data.offer.task.app.appId,registration.appId);
  assert.equal(data.request.nodes[0].serviceId,'fixture.catalog');
  assert.equal(row.metadataJson.includes(secret),false);assert.equal(row.metadataJson.includes(baseUrl),false);
  assert.ok(seen.some(b=>b.topK===2&&b.indexSpaceId==='fixture'&&Array.isArray(b.vector)));
  assert.equal((await r.db.receipt.findUnique({where:{id:requestId}})).committed,true);
  // The App's gateway reads which declared capabilities have qualified targets; counts are facts, not placement.
  const availability=JSON.parse(await appRequest(appConnection)('/v2/apps/me/capabilities',null));
  assert.deepEqual(availability,{capabilities:[{capability:'vector.search.v1',targets:1,services:1}]});
  // Data scope is a planner constraint: LOCAL_ONLY cannot leave the phone (which hosts no executor here), OWNER_SERVICE may only go to the service.
  const scoped=Buffer.from(JSON.stringify({model,vector:[1,0]}));
  await assert.rejects(request('/v2/jobs',{requestId:crypto.randomUUID(),capability:'vector.search.v1',contentHash:hash(scoped),bytes:scoped.length,parameters:JSON.stringify({indexSpaceId:'fixture',topK:1}),privacy:'LOCAL_ONLY'}),/NO_LEGAL_PLAN|NO_AVAILABLE_TARGET/);
  await assert.rejects(request('/v2/jobs',{requestId:crypto.randomUUID(),capability:'vector.search.v1',contentHash:hash(scoped),bytes:scoped.length,parameters:'{}',privacy:'PRIVATE'}),/JOB_INPUT_INVALID/);
  const owned=await submitWhenAvailable(request,{requestId:crypto.randomUUID(),capability:'vector.search.v1',contentHash:hash(scoped),bytes:scoped.length,parameters:JSON.stringify({indexSpaceId:'fixture',topK:1}),privacy:'OWNER_SERVICE'},()=>{});
  assert.equal(owned.deviceId,serviceDevice);
  // A query the service refuses settles as a rejection with the adapter's error code, never a retry storm.
  const bad=Buffer.from(JSON.stringify({model,vector:[1,0,0]})),badId=crypto.randomUUID();
  const badPlan=await submitWhenAvailable(request,{requestId:badId,capability:'vector.search.v1',contentHash:hash(bad),bytes:bad.length,parameters:JSON.stringify({indexSpaceId:'fixture',topK:1})},()=>{});
  await transfer(appConnection,badPlan.inputTicket,app.credential,bad);
  await request('/v2/jobs/'+badId+'/start',{});
  let failed;await until(async()=>{failed=await request('/v2/jobs/'+badId,null);return failed.state&&!['DISPATCHING','DISPATCHED','RUNNING','PLANNED','ACCEPTED'].includes(failed.state);},errors);
  assert.equal(failed.outputTicket??null,null);
 }finally{await host?.close();await r?.close();await new Promise(resolve=>server.close(resolve));}
});

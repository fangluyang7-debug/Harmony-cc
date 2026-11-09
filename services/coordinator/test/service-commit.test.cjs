const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),path=require('node:path'),crypto=require('node:crypto');
const {runtime}=require('./helpers.cjs');
const {builtinCpuPacks,commitPack,packDigest}=require('@harmony/reference-capabilities');
const {CpuHost}=require('../../pc-agent/dist/host'),{DurableLedger}=require('../../pc-agent/dist/durable-ledger');
const {commitAdapter}=require('../../pc-agent/dist/service-adapters');
const {allotmentTransport}=require('../../pc-agent/dist/allotment-client');
const {submitWhenAvailable}=require('../../pc-agent/dist/submit-wait');
const {transfer}=require('@harmony/resource-transport');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
async function until(check,errors,timeoutMs=180000){const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){if(await check())return;await new Promise(r=>setTimeout(r,1000));}throw Error('SERVICE_COMMIT_TIMEOUT '+JSON.stringify(errors));}

/** Stand-in for the business service commit endpoint: idempotent by key, dry-run writes nothing, ticket required. */
function fixtureService(secret,log){
 const sessions=new Map();
 const server=http.createServer((req,res)=>{
  if(req.headers.authorization!=='Bearer '+secret){res.writeHead(401);res.end();return;}
  const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
   res.setHeader('content-type','application/json');const fail=(status,code)=>{res.writeHead(status);res.end(JSON.stringify({error:{code}}));};
   if(req.method!=='POST'||req.url!=='/api/v2/stages/commit')return fail(404,'NOT_FOUND');
   let body;try{body=JSON.parse(Buffer.concat(chunks));}catch{return fail(400,'STAGE_INPUT_INVALID');}
   const key=req.headers['idempotency-key'],dryRun=req.headers['x-dry-run']==='true';log.push({key,dryRun,ticket:body.ticket});
   if(!body||typeof body.ticket!=='string'||!body.query||!Array.isArray(body.candidates))return fail(400,'STAGE_INPUT_INVALID');
   if(typeof key!=='string')return fail(400,'IDEMPOTENCY_KEY_REQUIRED');
   if(body.ticket==='dry-run'?!dryRun:body.ticket!=='shopper-ticket')return fail(401,'TICKET_INVALID');
   const sessionId='sess_'+hash(key).slice(0,24),existing=sessions.get(sessionId);
   if(dryRun){res.end(JSON.stringify({dryRun:true,sessionId,wouldCreate:!existing,writes:existing?[]:['imageAsset','querySession','filterSnapshot','candidateSnapshot'],candidateCount:body.candidates.length}));return;}
   if(existing){res.end(JSON.stringify({dryRun:false,sessionId,created:false,replay:true,stateVersion:1}));return;}
   sessions.set(sessionId,body);res.end(JSON.stringify({dryRun:false,sessionId,created:true,replay:false,candidateSnapshotId:'snap_'+sessions.size,stateVersion:1}));
  });
 });
 return {server,sessions};
}
const seed=i=>({title:'t'+i,platformName:'ref',amount:String(100+i),currency:'CNY',shopName:'s',shopType:'t',stockStatus:'in_stock',coverImageUrl:'',productUrl:'https://ref.invalid/'+i,matchSummary:{},normalizedAttributes:{},rawPayload:{},recommendationReason:[]});

test('commit pack qualifies only through dry runs and the adapter refuses to write without a key',async()=>{
 const pack=commitPack('fixture.catalog');
 assert.equal(packDigest(pack),packDigest(commitPack('fixture.catalog')));assert.equal(pack.manifest.contract.sideEffectPolicy,'IDEMPOTENT_WRITE');assert.equal(pack.dryRunEvaluation,true);
 const secret=crypto.randomUUID(),log=[],{server}=fixtureService(secret,log);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const connection={baseUrl:'http://127.0.0.1:'+server.address().port+'/',token:secret},signal=new AbortController().signal,adapter=commitAdapter(pack,connection);
 try{
  for(const c of pack.cases){
   if(c.expect.kind==='OUTPUT'){const out=await adapter.execute(c.input,c.parameters,signal,{evaluation:true,idempotencyKey:'eval-'+c.id});assert.equal(await pack.evaluate(c,out.bytes),1,c.id);}
   else await assert.rejects(adapter.execute(c.input,c.parameters,signal,{evaluation:true,idempotencyKey:'eval-'+c.id}),new RegExp(c.expect.errorCode),c.id);
  }
  assert.ok(log.filter(l=>l.ticket==='dry-run').every(l=>l.dryRun===true));
  await assert.rejects(adapter.execute(pack.cases[0].input,'{}',signal,{evaluation:false,idempotencyKey:null}),/IDEMPOTENCY_KEY_REQUIRED/);
  // A service that performs a real write during evaluation is caught by the adapter, not trusted.
  const lying=http.createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({dryRun:false,sessionId:'sess_x',created:true,replay:false,stateVersion:1}));});
  await new Promise(resolve=>lying.listen(0,'127.0.0.1',resolve));
  try{await assert.rejects(commitAdapter(pack,{baseUrl:'http://127.0.0.1:'+lying.address().port+'/',token:secret}).execute(pack.cases[0].input,'{}',signal,{evaluation:true,idempotencyKey:'eval-x'}),/SERVICE_DRY_RUN_VIOLATED/);}
  finally{await new Promise(resolve=>lying.close(resolve));}
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('a scheduled commit writes once per idempotency key; a retry is routed and settled as a replay, never a second session',async()=>{
 const secret=crypto.randomUUID(),log=[],{server,sessions}=fixtureService(secret,log);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const baseUrl='http://127.0.0.1:'+server.address().port+'/',pack=commitPack('fixture.catalog');
 let host,r;const errors=[];
 try{
  r=await runtime({cpuHost:true,referencePacks:[...builtinCpuPacks(),pack]});
  const group='team-'+crypto.randomUUID().slice(0,8),capacity=[{resourcePoolId:'cpu',amount:1},{resourcePoolId:'ram',amount:268435456}];
  const serviceDevice='catalog-service',serviceHolder='service-holder';
  const invite=await r.auth.invite(group,'service-owner',serviceDevice,r.url),paired=await r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:serviceHolder});
  await r.allotments.confirmDevice(serviceDevice,capacity,[{groupId:group,holderInstanceId:serviceHolder,appInstanceId:null}]);
  const identity={groupId:group,deviceId:serviceDevice,holderInstanceId:serviceHolder,appInstanceId:null},directory=path.join(r.config.dataDir,'service-ledger');
  const ledger=await DurableLedger.open(directory,identity,invite.certificate);await ledger.close();
  host=await CpuHost.open({directory,identity,connection:{address:r.url,certificate:invite.certificate,fingerprint:invite.fingerprint,credential:paired.credential,domain:'SIMULATED'},controlIntervalMs:2000,
   contribution:{ownerMode:'dedicated',maxCpuThreads:1,maxMemoryBytes:268435456,reserveMemoryBytes:0},services:[commitAdapter(pack,{baseUrl,token:secret})]},e=>errors.push(String(e)));host.start();
  await until(async()=>{try{return (await r.snapshots.build(group)).snapshot.candidates.some(c=>c.capability==='shopping.commit.v1'&&c.serviceId==='fixture.catalog');}catch{return false;}},errors);
  assert.ok(log.length>=3&&log.every(l=>l.dryRun===true),'qualification must only dry-run: '+JSON.stringify(log));assert.equal(sessions.size,0);
  const appInvite=await r.auth.invite(group,'shopper','phone-a',r.url),owner=await r.auth.exchange({inviteId:appInvite.inviteId,code:appInvite.code,holderInstanceId:'phone-holder'});
  const registration=await r.apps.register(owner.peer,{label:'Shopping App',allowedContracts:['shopping.commit.v1'],maxConcurrent:2,resources:capacity,offlineBase:[],onlineExtra:[]},r.url);
  const app=await r.apps.exchange({registrationId:registration.registrationId,code:registration.code});
  const appConnection={address:r.url,certificate:appInvite.certificate,fingerprint:appInvite.fingerprint,credential:app.credential,domain:'SIMULATED'},request=allotmentTransport(appConnection);
  const input=Buffer.from(JSON.stringify({ticket:'shopper-ticket',query:{text:'跑鞋',filters:{sortRule:'relevance_desc'}},candidates:[seed(0),seed(1)],answer:'ok'}));
  const run=async(businessIdempotencyKey)=>{
   const requestId=crypto.randomUUID(),plan=await submitWhenAvailable(request,{requestId,capability:'shopping.commit.v1',contentHash:hash(input),bytes:input.length,parameters:'{}',businessIdempotencyKey},()=>{});
   assert.equal(plan.deviceId,serviceDevice);await transfer(appConnection,plan.inputTicket,app.credential,input);await request('/v2/jobs/'+requestId+'/start',{});
   let result;await until(async()=>{result=await request('/v2/jobs/'+requestId,null);return !!result.outputTicket;},errors);
   assert.equal(result.decisionEvidence.candidateCount,1);
   const row=await r.db.cpuJob.findUnique({where:{id:requestId}}),data=JSON.parse(row.metadataJson);
   assert.equal(data.offer.task.businessIdempotencyKey,businessIdempotencyKey);assert.equal(data.offer.task.contract.sideEffectPolicy,'IDEMPOTENT_WRITE');assert.equal(row.metadataJson.includes(secret),false);
   return JSON.parse((await transfer(appConnection,result.outputTicket,app.credential)).bytes);
  };
  // Without a business idempotency key the coordinator refuses to plan a write at all.
  await assert.rejects(request('/v2/jobs',{requestId:crypto.randomUUID(),capability:'shopping.commit.v1',contentHash:hash(input),bytes:input.length,parameters:'{}'}),/JOB_IDEMPOTENCY_REQUIRED/);
  const first=await run('operation-7');assert.equal(first.created,true);assert.equal(first.dryRun,false);assert.equal(sessions.size,1);
  const retry=await run('operation-7');assert.equal(retry.replay,true);assert.equal(retry.sessionId,first.sessionId);assert.equal(sessions.size,1);
  const other=await run('operation-8');assert.equal(other.created,true);assert.notEqual(other.sessionId,first.sessionId);assert.equal(sessions.size,2);
  assert.ok(log.filter(l=>!l.dryRun).every(l=>typeof l.key==='string'&&l.key.startsWith('operation-')));
 }finally{await host?.close();await r?.close();await new Promise(resolve=>server.close(resolve));}
});

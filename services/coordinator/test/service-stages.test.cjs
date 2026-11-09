const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),path=require('node:path'),crypto=require('node:crypto');
const {runtime}=require('./helpers.cjs');
const {builtinCpuPacks,priceStockPack,rankPack,packDigest}=require('@harmony/reference-capabilities');
const {CpuHost}=require('../../pc-agent/dist/host'),{DurableLedger}=require('../../pc-agent/dist/durable-ledger');
const {stageAdapter}=require('../../pc-agent/dist/service-adapters');
const {allotmentTransport}=require('../../pc-agent/dist/allotment-client');
const {submitWhenAvailable}=require('../../pc-agent/dist/submit-wait');
const {transfer}=require('@harmony/resource-transport');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
async function until(check,errors,timeoutMs=180000){const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){if(await check())return;await new Promise(r=>setTimeout(r,1000));}throw Error('SERVICE_STAGES_TIMEOUT '+JSON.stringify(errors));}
const money=/^\d{1,100}(\.\d{1,100})?$/,cmp=(a,b)=>{const [aw,af='']=a.split('.'),[bw,bf='']=b.split('.');if(aw.length!==bw.length)return aw.length-bw.length;const w=aw.localeCompare(bw);if(w)return w;const n=Math.max(af.length,bf.length);return af.padEnd(n,'0').localeCompare(bf.padEnd(n,'0'));};
const catalogue=[{id:'p-a',platform:'ref',productUrl:'https://ref.invalid/a',priceAmount:'299.00',currency:'CNY',stockStatus:'in_stock'},{id:'p-b',platform:'ref',productUrl:'https://ref.invalid/b',priceAmount:'99.50',currency:'CNY',stockStatus:'out_of_stock'}];

/** Stand-in for the business service's documented stage endpoints (same rules as ShoppingStagesV2Controller). */
function fixtureService(secret,seen){
 return http.createServer((req,res)=>{
  if(req.headers.authorization!=='Bearer '+secret){res.writeHead(401);res.end();return;}
  const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
   res.setHeader('content-type','application/json');const bad=()=>{res.writeHead(400);res.end(JSON.stringify({error:{code:'STAGE_INPUT_INVALID'}}));};
   let body;try{body=JSON.parse(Buffer.concat(chunks));}catch{return bad();}
   seen.push({url:req.url,body});
   if(req.method==='POST'&&req.url==='/api/v2/stages/price-stock'){
    const items=body.items??body.candidates;if(!Array.isArray(items)||items.length>200||!items.every(i=>i&&(typeof i.productId==='string'||typeof i.platformName==='string'&&typeof i.productUrl==='string')))return bad();
    res.end(JSON.stringify({requestId:body.requestId,priceSource:'catalog',items:items.map(i=>{const p=catalogue.find(p=>p.id===i.productId||p.platform===i.platformName&&p.productUrl===i.productUrl);
     return {productId:p?.id??i.productId??null,platformName:p?.platform??i.platformName??null,productUrl:p?.productUrl??i.productUrl??null,score:i.score??null,amount:p?.priceAmount??null,currency:p?.currency??null,stockStatus:p?p.stockStatus:'unknown',catalogUpdatedAt:p?'2026-11-09T00:00:00.000Z':null};})}));return;
   }
   if(req.method==='POST'&&req.url==='/api/v2/stages/rank'){
    const f=body.filters??{};if(!Array.isArray(body.items)||!body.items.every(i=>i&&typeof i.platformName==='string'&&typeof i.productUrl==='string'&&money.test(String(i.amount))))return bad();
    const seen2=new Set();let items=body.items.filter(i=>{if(f.stockOnly===true&&i.stockStatus!=='in_stock')return false;if(f.priceMin!=null&&cmp(i.amount,f.priceMin)<0)return false;if(f.priceMax!=null&&cmp(i.amount,f.priceMax)>0)return false;const k=i.platformName+':'+i.productUrl;if(seen2.has(k))return false;seen2.add(k);return true;});
    if(f.sortRule==='price_asc'||f.sortRule==='price_desc')items.sort((a,b)=>cmp(a.amount,b.amount)*(f.sortRule==='price_desc'?-1:1));
    res.end(JSON.stringify({requestId:body.requestId,items:items.slice(0,30)}));return;
   }
   res.writeHead(404);res.end();
  });
 });
}

test('stage packs are deterministic and the adapter maps every reference case to the service',async()=>{
 const price=priceStockPack('fixture.catalog'),rank=rankPack('fixture.catalog');
 assert.equal(packDigest(price),packDigest(priceStockPack('fixture.catalog')));assert.equal(packDigest(rank),packDigest(rankPack('fixture.catalog')));
 for(const p of [price,rank]){assert.equal(p.manifest.contract.parameterRole,'EXECUTION');assert.equal(p.manifest.contract.sideEffectPolicy,'PURE');assert.equal(p.manifest.model,null);}
 const secret=crypto.randomUUID(),seen=[],server=fixtureService(secret,seen);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const connection={baseUrl:'http://127.0.0.1:'+server.address().port+'/',token:secret},signal=new AbortController().signal;
 try{
  for(const pack of [price,rank]){
   const adapter=stageAdapter(pack,connection);
   for(const c of pack.cases){
    if(c.expect.kind==='OUTPUT'){const out=await adapter.execute(c.input,c.parameters,signal);assert.equal(out.schemaId,pack.manifest.contract.outputSchemas[0]);assert.equal(await pack.evaluate(c,out.bytes),1,pack.manifest.packId+'/'+c.id);}
    else await assert.rejects(adapter.execute(c.input,c.parameters,signal),new RegExp(c.expect.errorCode),pack.manifest.packId+'/'+c.id);
   }
  }
  // The rank invariants really bite: a service that ignores the sort rule scores 0.
  const asc=rank.cases.find(c=>c.id==='price-asc'),wrong=Buffer.from(JSON.stringify({items:JSON.parse(asc.input.toString()).items.slice(0,3)}));
  assert.equal(await rank.evaluate(asc,wrong),0);
  assert.ok(seen.every(s=>typeof s.body.requestId==='string'));
 }finally{await new Promise(resolve=>server.close(resolve));}
});

test('a business service hosts price-stock and rank as ordinary targets and another App is routed to them',async()=>{
 const secret=crypto.randomUUID(),seen=[],server=fixtureService(secret,seen);
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const baseUrl='http://127.0.0.1:'+server.address().port+'/',price=priceStockPack('fixture.catalog'),rank=rankPack('fixture.catalog');
 let host,r;const errors=[];
 try{
  r=await runtime({cpuHost:true,referencePacks:[...builtinCpuPacks(),price,rank]});
  const group='team-'+crypto.randomUUID().slice(0,8),capacity=[{resourcePoolId:'cpu',amount:1},{resourcePoolId:'ram',amount:268435456}];
  const serviceDevice='catalog-service',serviceHolder='service-holder';
  const invite=await r.auth.invite(group,'service-owner',serviceDevice,r.url),paired=await r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:serviceHolder});
  await r.allotments.confirmDevice(serviceDevice,capacity,[{groupId:group,holderInstanceId:serviceHolder,appInstanceId:null}]);
  const identity={groupId:group,deviceId:serviceDevice,holderInstanceId:serviceHolder,appInstanceId:null},directory=path.join(r.config.dataDir,'service-ledger');
  const ledger=await DurableLedger.open(directory,identity,invite.certificate);await ledger.close();
  const connection={baseUrl,token:secret};
  host=await CpuHost.open({directory,identity,connection:{address:r.url,certificate:invite.certificate,fingerprint:invite.fingerprint,credential:paired.credential,domain:'SIMULATED'},controlIntervalMs:2000,
   contribution:{ownerMode:'dedicated',maxCpuThreads:1,maxMemoryBytes:268435456,reserveMemoryBytes:0},services:[stageAdapter(price,connection),stageAdapter(rank,connection)]},e=>errors.push(String(e)));host.start();
  await until(async()=>{try{const c=(await r.snapshots.build(group)).snapshot.candidates;return ['catalog.price-stock.v1','rank.v1'].every(id=>c.some(x=>x.capability===id&&x.serviceId==='fixture.catalog'));}catch{return false;}},errors);
  const appInvite=await r.auth.invite(group,'shopper','phone-a',r.url),owner=await r.auth.exchange({inviteId:appInvite.inviteId,code:appInvite.code,holderInstanceId:'phone-holder'});
  const registration=await r.apps.register(owner.peer,{label:'Shopping App',allowedContracts:['catalog.price-stock.v1','rank.v1'],maxConcurrent:2,resources:capacity,offlineBase:[],onlineExtra:[]},r.url);
  const app=await r.apps.exchange({registrationId:registration.registrationId,code:registration.code});
  const appConnection={address:r.url,certificate:appInvite.certificate,fingerprint:appInvite.fingerprint,credential:app.credential,domain:'SIMULATED'},request=allotmentTransport(appConnection);
  const run=async(capability,bytes,parameters)=>{
   const requestId=crypto.randomUUID(),plan=await submitWhenAvailable(request,{requestId,capability,contentHash:hash(bytes),bytes:bytes.length,parameters},()=>{});
   assert.equal(plan.deviceId,serviceDevice);await transfer(appConnection,plan.inputTicket,app.credential,bytes);await request('/v2/jobs/'+requestId+'/start',{});
   let result;await until(async()=>{result=await request('/v2/jobs/'+requestId,null);return !!result.outputTicket;},errors);
   assert.equal(result.decisionEvidence.candidateCount,1);
   const row=await r.db.cpuJob.findUnique({where:{id:requestId}});assert.equal(JSON.parse(row.metadataJson).holderId,serviceHolder);assert.equal(row.metadataJson.includes(secret),false);
   return JSON.parse((await transfer(appConnection,result.outputTicket,app.credential)).bytes);
  };
  // A candidate list (what vector search produces) is priced from the catalogue; unknown products stay honest.
  const model={modelId:'fixture',version:'v1',weightsHash:'a'.repeat(64),preprocessVersion:'rgb',embeddingKind:'image',dimension:2,dtype:'float32',normalization:'l2'};
  const priced=await run('catalog.price-stock.v1',Buffer.from(JSON.stringify({indexSpaceId:'fixture',indexVersion:'v1',model,candidates:[{productId:'p-a',score:0.9},{productId:'nope',score:0.1}],scoreMeaning:'COSINE_SIMILARITY'})),'{}');
  assert.equal(priced.priceSource,'catalog');assert.deepEqual(priced.items.map(i=>[i.productId,i.amount,i.stockStatus]),[['p-a','299.00','in_stock'],['nope',null,'unknown']]);
  const seed=(i,amount,stockStatus='in_stock')=>({title:'t'+i,platformName:'ref',amount,currency:'CNY',shopName:'s',shopType:'t',stockStatus,coverImageUrl:'',productUrl:'https://ref.invalid/'+i,matchSummary:{},normalizedAttributes:{},rawPayload:{},recommendationReason:[]});
  const ranked=await run('rank.v1',Buffer.from(JSON.stringify({items:[seed(0,'299.00'),seed(1,'99.5','out_of_stock'),seed(2,'1299'),seed(3,'0.99')]})),JSON.stringify({sortRule:'price_asc',stockOnly:true}));
  assert.deepEqual(ranked.items.map(i=>i.amount),['0.99','299.00','1299']);
 }finally{await host?.close();await r?.close();await new Promise(resolve=>server.close(resolve));}
});

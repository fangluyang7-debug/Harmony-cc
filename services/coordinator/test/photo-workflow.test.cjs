const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),{randomUUID,createHash}=require('node:crypto');
const settings=path.resolve('../../.test/photo-tools/runtime.json');
if(fs.existsSync(settings)){const c=JSON.parse(fs.readFileSync(settings));process.env.HARMONY_PHOTO_MODEL=c.model;process.env.HARMONY_PHOTO_RUNNER=c.runner;}
const {runtime}=require('./helpers.cjs'),{photoPacks,encodeBundle,decodeBundle}=require('@harmony/reference-capabilities');
const {CpuHost}=require('../../pc-agent/dist/host'),{DurableLedger}=require('../../pc-agent/dist/durable-ledger');
const sharp=require('sharp');
test('bundle rejects tampered, duplicate and oversized materialization',()=>{
 const b=encodeBundle([{nodeId:'a',schemaId:'photo.tile',data:Buffer.from('abc')}]);assert.equal(Buffer.from(decodeBundle(b)[0].data,'base64').toString(),'abc');
 const v=JSON.parse(b);v.parts[0].data=Buffer.from('xyz').toString('base64');assert.throws(()=>decodeBundle(Buffer.from(JSON.stringify(v))));
 assert.throws(()=>encodeBundle([{nodeId:'a',schemaId:'s',data:Buffer.from('x')},{nodeId:'a',schemaId:'s',data:Buffer.from('x')}]));
 assert.throws(()=>encodeBundle([{nodeId:'a',schemaId:'s',data:Buffer.alloc(8388608)}]));
});
for(const refusal of ['ALLOTMENT_ACK_PENDING','P1008'])test('graph preserves the attempt across '+refusal+' and does not restart an admitted node',async()=>{
 const {WorkflowJobs}=require('../dist/workflow-jobs');let submitted=0,started=0,state='ACTIVE';
 const data={peer:{groupId:'g'},deadlineAt:Date.now()+10000,workflow:{nodes:[{id:'a',capability:'photo.analyze.v1',dependsOn:[],parameters:'{}'},{id:'b',capability:'photo.deliver.v1',inputFrom:'a',dependsOn:['a'],parameters:'{}'}]},inputs:{a:{ref:{contentHash:'h'},bytes:1}},nodes:[{id:'a',jobId:'ja',state:'PENDING'},{id:'b',jobId:'jb',state:'PENDING'}],plan:{decision:{suggestion:[{nodeId:'a'},{nodeId:'b'}]}}};
 const db={sdkWorkflowJob:{findUniqueOrThrow:async()=>({state}),update:async()=>{},updateMany:async arg=>{state=arg.data.state;return {count:1};}},cpuJob:{findUnique:async()=>null}};
 const jobs={submit:async()=>{submitted++;},graphInput:async()=>null,start:async()=>{if(++started===1){const e=Error(refusal);if(refusal==='P1008')e.code=refusal;throw e;}},winnerFor:async()=> 'ja',status:async()=>({state:started>=2?'ACCEPTED':'WAITING_INPUT'}),graphOutput:async()=>null};
 const graph=new WorkflowJobs(db,jobs,{context:async()=>({})},null,[]);
 await graph.progress('g',data);assert.equal(state,'ACTIVE');assert.equal(data.failure,undefined);assert.equal(data.nodes[0].state,'SUBMITTED');
 await graph.progress('g',data);assert.equal(submitted,1);assert.equal(started,2);assert.equal(state,'ACTIVE');await graph.progress('g',data);assert.equal(started,2,'an admitted task is never restarted by polling');
});
test('actual CPU neural photo graph plans, fans out, fans in and returns a verified product through SDK',{skip:!fs.existsSync(settings),timeout:300000},async()=>{
 const packs=photoPacks(),r=await runtime({cpuHost:true,referencePacks:packs}),hosts=[],errors=[];
 try{
  const group=randomUUID(),device=randomUUID(),holder=randomUUID(),capacity=[{resourcePoolId:'cpu',amount:2},{resourcePoolId:'ram',amount:2147483648}];
  const invite=await r.auth.invite(group,randomUUID(),device,r.url),owner=await r.auth.exchange({inviteId:invite.inviteId,code:invite.code,holderInstanceId:holder});
  await r.allotments.confirmDevice(device,capacity,[{groupId:group,holderInstanceId:holder,appInstanceId:null}]);
  const app=await r.apps.register(owner.peer,{label:'Actual local photo validation',allowedContracts:packs.map(p=>p.manifest.contract.contractId),maxConcurrent:4,resources:capacity,offlineBase:capacity,onlineExtra:[]},r.url),paired=await r.apps.exchange({registrationId:app.registrationId,code:app.code});
  const identity={groupId:group,deviceId:device,holderInstanceId:paired.peer.holderInstanceId,appInstanceId:paired.peer.app.appInstanceId},directory=path.join(r.config.dataDir,identity.holderInstanceId),ledger=await DurableLedger.open(directory,identity,invite.certificate);await ledger.close();
  const host=await CpuHost.open({directory,identity,connection:{address:r.url,certificate:invite.certificate,fingerprint:invite.fingerprint,credential:paired.credential,domain:'SIMULATED'},controlIntervalMs:1500,contribution:{ownerMode:'dedicated',maxCpuThreads:2,maxMemoryBytes:2147483648,reserveMemoryBytes:0}},e=>errors.push(String(e)));hosts.push(host);host.start();
  const deadline=Date.now()+180000;let ready=false;while(Date.now()<deadline){try{const snapshot=(await r.snapshots.build(group)).snapshot;ready=packs.every(p=>snapshot.candidates.some(c=>c.capability===p.manifest.contract.capability));}catch{}if(ready)break;await new Promise(resolve=>setTimeout(resolve,500));}
  assert.ok(ready,'photo targets qualified: '+errors.slice(-10).join(','));
  // Input is created only after workers have joined; no task output is preinstalled.
  const bytes=await sharp({create:{width:72,height:16,channels:3,background:{r:127,g:74,b:31}}}).png().toBuffer(),sdk=host.sdk(),input=await sdk.registerInput(bytes,'image.raster'),id=randomUUID();
  const {photoWorkflow}=await import('../../../apps/team-space-web/photo-workflow.mjs');const graph=photoWorkflow(id,input,72,16);
  const begin=performance.now(),task=await sdk.submit(graph.workflow,{requestId:id,budgetMs:180000,resultDestination:'ORIGIN'}),result=await task.result(185000),product=JSON.parse(Buffer.from(result.output));
  assert.equal(result.status.state,'SUCCEEDED');assert.equal(product.width,288);assert.equal(product.height,64);assert.equal(createHash('sha256').update(Buffer.from(product.image,'base64')).digest('hex'),product.hash);
  const attempts=await r.db.attempt.findMany({where:{workflowId:id}});assert.equal(attempts.length,graph.workflow.nodes.length);assert.equal(new Set(attempts.map(a=>a.nodeId)).size,attempts.length);
  for(const a of attempts)assert.equal((await r.db.receipt.findUnique({where:{id:a.id}})).committed,true);
  const row=await r.db.sdkWorkflowJob.findUnique({where:{id}}),data=JSON.parse(row.metadataJson);assert.ok(data.deadlineAt>Date.now());
  const evidence={kind:'LOCAL_PROCESS_TEST',model:packs.find(p=>p.manifest.model).manifest.model,workflow:id,durationMs:performance.now()-begin,inputHash:createHash('sha256').update(bytes).digest('hex'),inputBytes:bytes.length,outputHash:product.hash,outputWidth:product.width,outputHeight:product.height,nodes:attempts.map(a=>({nodeId:a.nodeId,state:a.state,backend:JSON.parse(a.offerJson).target.backend})),remainingMs:data.deadlineAt-Date.now()};
  fs.writeFileSync(path.resolve('../../.test/photo-tools/workflow-evidence.json'),JSON.stringify(evidence,null,2));console.log('PHOTO_EVIDENCE '+JSON.stringify(evidence));
 }catch(e){console.log('PHOTO_DIAGNOSTIC '+JSON.stringify({errors:errors.slice(-20),graphs:(await r.db.sdkWorkflowJob.findMany()).map(g=>({state:g.state,metadata:JSON.parse(g.metadataJson)}))}));throw e;}
 finally{for(const h of hosts)await h.close();await r.close();}
});

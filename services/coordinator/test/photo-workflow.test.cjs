function frontierMock(jobs){jobs.graphProgress=async(peer,ids)=>Promise.all(ids.map(async id=>{const serving=await jobs.winnerFor(peer,id),status=await jobs.status(peer,serving);return {id,serving,state:status.state,output:status.state==='SUCCEEDED'?await jobs.graphOutput(peer,serving):null};}));return jobs;}
const {test}=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),{randomUUID,createHash}=require('node:crypto');
const settings=path.resolve('../../.test/photo-tools/runtime.json');
if(fs.existsSync(settings)){const c=JSON.parse(fs.readFileSync(settings));process.env.HARMONY_PHOTO_MODEL=c.model;process.env.HARMONY_PHOTO_RUNNER=c.runner;}
const {runtime}=require('./helpers.cjs'),{photoPacks,encodeBundle,decodeBundle}=require('@harmony/reference-capabilities');
const {CpuHost}=require('../../pc-agent/dist/host'),{DurableLedger}=require('../../pc-agent/dist/durable-ledger');
const sharp=require('sharp');
test('ready sibling submissions proceed while another sibling is blocked, without duplicate starts',async()=>{
 const {WorkflowJobs}=require('../dist/workflow-jobs');let release;const blocked=new Promise(r=>{release=r;});let second;const sibling=new Promise(r=>{second=r;});const started=[],submitted=[];
 const data={peer:{groupId:'g'},deadlineAt:Date.now()+10000,workflow:{nodes:['a','b'].map(id=>({id,capability:'photo.analyze.v1',dependsOn:[],parameters:'{}'}))},inputs:{a:{ref:{contentHash:'a'},bytes:1},b:{ref:{contentHash:'b'},bytes:1}},nodes:['a','b'].map(id=>({id,jobId:id,state:'PENDING'}))};
 let persisted;const db={sdkWorkflowJob:{findUniqueOrThrow:async()=>({state:'ACTIVE'}),update:async v=>{persisted=JSON.parse(v.data.metadataJson);}},cpuJob:{findUnique:async()=>null}};
 const jobs={submit:async(_p,v)=>{submitted.push(v.requestId);if(v.requestId==='a')await blocked;else second();},graphInput:async()=>null,start:async(_p,id)=>{started.push(id);},winnerFor:async(_p,id)=>id,status:async()=>({state:'RUNNING'}),graphOutput:async()=>null};
 const g=new WorkflowJobs(db,frontierMock(jobs),{context:async()=>({})},null,[]),work=g.progress('g',data);
 try{await Promise.race([sibling,new Promise((_,reject)=>setTimeout(()=>reject(Error('sibling stalled behind first submission')),1000))]);}finally{release();}
 await work;assert.deepEqual(started.sort(),['a','b']);assert.ok(persisted.nodes.every(n=>n.state==='SUBMITTED'));
 await g.progress('g',data);assert.equal(submitted.length,2);assert.equal(started.length,2);
});
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
 const graph=new WorkflowJobs(db,frontierMock(jobs),{context:async()=>({})},null,[]);
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
  const begin=performance.now(),task=await sdk.submit(graph.workflow,{requestId:id,budgetMs:180000,inputLocation:'ORIGIN',resultDestination:'ORIGIN'}),result=await task.result(185000),product=JSON.parse(Buffer.from(result.output));
  assert.equal(result.status.state,'SUCCEEDED');assert.equal(product.width,288);assert.equal(product.height,64);assert.equal(createHash('sha256').update(Buffer.from(product.image,'base64')).digest('hex'),product.hash);
  const attempts=await r.db.attempt.findMany({where:{workflowId:id}});assert.equal(attempts.length,graph.workflow.nodes.length);assert.equal(new Set(attempts.map(a=>a.nodeId)).size,attempts.length);
  for(const a of attempts)assert.equal((await r.db.receipt.findUnique({where:{id:a.id}})).committed,true);
  const row=await r.db.sdkWorkflowJob.findUnique({where:{id}}),data=JSON.parse(row.metadataJson);assert.ok(data.deadlineAt>Date.now());
  assert.equal(data.originLocal,true);
  const analyze=data.nodes.find(n=>n.id.startsWith('analyze'));assert.equal(analyze.local,true,'same-source analysis stays in the app host cache');
  for(const n of data.nodes.filter(n=>n.id.startsWith('enhance')))assert.equal(n.local,false,'fan-in inputs remain materialized for bundle assembly');
  const evidence={kind:'LOCAL_PROCESS_TEST',model:packs.find(p=>p.manifest.model).manifest.model,workflow:id,durationMs:performance.now()-begin,inputHash:createHash('sha256').update(bytes).digest('hex'),inputBytes:bytes.length,outputHash:product.hash,outputWidth:product.width,outputHeight:product.height,nodes:attempts.map(a=>({nodeId:a.nodeId,state:a.state,backend:JSON.parse(a.offerJson).target.backend})),remainingMs:data.deadlineAt-Date.now()};
  fs.writeFileSync(path.resolve('../../.test/photo-tools/workflow-evidence.json'),JSON.stringify(evidence,null,2));console.log('PHOTO_EVIDENCE '+JSON.stringify(evidence));
 }catch(e){console.log('PHOTO_DIAGNOSTIC '+JSON.stringify({errors:errors.slice(-20),graphs:(await r.db.sdkWorkflowJob.findMany()).map(g=>({state:g.state,metadata:JSON.parse(g.metadataJson)}))}));throw e;}
 finally{for(const h of hosts)await h.close();await r.close();}
});

test('fan-in materializes only its immediate inputs, while linear edges stay retainable',()=>{
 const {retainableOutput}=require('../dist/workflow-jobs');
 const workflow={nodes:[{id:'analyze'},{id:'prepare-a',inputFrom:'analyze'},{id:'prepare-b',inputFrom:'analyze'},
  {id:'enhance-a',inputFrom:'prepare-a'},{id:'enhance-b',inputFrom:'prepare-b'},
  {id:'assemble',inputFroms:['enhance-a','enhance-b']},{id:'deliver',inputFrom:'assemble'}]};
 for(const id of ['analyze','prepare-a','prepare-b','assemble'])assert.equal(retainableOutput(workflow,id),true,id);
 for(const id of ['enhance-a','enhance-b','deliver'])assert.equal(retainableOutput(workflow,id),false,id);
 workflow.nodes.push({id:'also-linear',inputFrom:'enhance-a'});
 assert.equal(retainableOutput(workflow,'enhance-a'),false,'mixed fan-in + linear consumers must still have a relay copy');
});
test('graph polling does not wait for a full history cleanup or query inactive nodes',async()=>{
 const {WorkflowJobs}=require('../dist/workflow-jobs');let reads=0,sweeps=0;
 const data={peer:{groupId:'g'},deadlineAt:Date.now()+10000,workflow:{nodes:[{id:'done',dependsOn:[]},{id:'running',dependsOn:['done']},{id:'blocked',dependsOn:['running']}]},nodes:[{id:'done',jobId:'jd',state:'COMMITTED'},{id:'running',jobId:'jr',state:'SUBMITTED'},{id:'blocked',jobId:'jb',state:'PENDING'}]};
 const db={sdkWorkflowJob:{findMany:async()=>[{id:'g',metadataJson:JSON.stringify(data)}],findUnique:async()=>({state:'ACTIVE',metadataJson:JSON.stringify(data)}),findUniqueOrThrow:async()=>{reads++;return {state:'ACTIVE'};}}};
 const jobs={winnerFor:async()=> 'jr',status:async()=>({state:'RUNNING'}),graphOutput:async()=>{throw Error('running attempt must not inspect output');}};
 const retention={sweepRelay:async()=>{sweeps++;throw Error('cleanup should not block the graph');}};
 const graph=new WorkflowJobs(db,frontierMock(jobs),{context:async()=>({})},null,[],retention);
 await graph.advance('g');assert.equal(sweeps,0);assert.equal(reads,1,'only the cancellation cursor is checked; admitted and dependency-blocked nodes do not poll the DB again');
});

test('successful receipt still waits for committed output and retries visibility without dispatching twice',async()=>{
 const {WorkflowJobs}=require('../dist/workflow-jobs');let available=false,outputs=0,done=0;
 const descriptor={ref:{contentHash:'x'}};
 const data={peer:{groupId:'g'},deadlineAt:Date.now()+10000,workflow:{nodes:[{id:'a',dependsOn:[]}]},nodes:[{id:'a',jobId:'ja',state:'SUBMITTED'}]};
 const db={sdkWorkflowJob:{findUniqueOrThrow:async()=>({state:'ACTIVE'}),update:async()=>{},updateMany:async()=>{done++;}}};
 const jobs={winnerFor:async()=> 'ja',status:async()=>({state:'SUCCEEDED'}),graphOutput:async()=>{outputs++;return available?{descriptor,local:true}:null;},start:async()=>{throw Error('duplicate start');}};
 const graph=new WorkflowJobs(db,frontierMock(jobs),{context:async()=>({})},null,[]);
 await graph.progress('g',data);assert.equal(data.nodes[0].state,'SUBMITTED');assert.equal(done,0);
 available=true;await graph.progress('g',data);assert.equal(data.nodes[0].state,'COMMITTED');assert.equal(data.nodes[0].output,descriptor);assert.equal(done,1);assert.equal(outputs,2);
});

test('SDK graph polling requests input transfer only for attempts not yet admitted',async()=>{
 const {WorkflowJobs}=require('../dist/workflow-jobs'),calls=[];
 const peer={groupId:'g',holderInstanceId:'h'},data={nodes:[{id:'a',jobId:'ja',state:'SUBMITTED'},{id:'b',jobId:'jb',state:'SUBMITTED'},{id:'c',jobId:'jc',state:'PENDING'}],workflow:{nodes:[{id:'a'},{id:'b'},{id:'c'}]},inputs:{a:{bytes:1},b:{bytes:2}},plan:{decision:{suggestion:[{nodeId:'c',targetId:'t',deviceId:'d'}]}}};
 const db={sdkWorkflowJob:{findUnique:async()=>({groupId:'g',sourceHolderId:'h',state:'ACTIVE',metadataJson:JSON.stringify(data)})},attempt:{findMany:async q=>{assert.deepEqual(q.where.id.in,['ja','jb']);return [{id:'ja'}];}}};
 const graph=new WorkflowJobs(db,{graphInput:async(_p,id,_s,prepare)=>{calls.push(id);assert.equal(prepare,false);return {read:'source',write:'destination'};}},{context:async()=>({})},null,[]);graph.changed=()=>{};
 const status=await graph.status(peer,'graph');assert.deepEqual(calls,['jb']);assert.equal(status.inputTransfers.length,1);
});

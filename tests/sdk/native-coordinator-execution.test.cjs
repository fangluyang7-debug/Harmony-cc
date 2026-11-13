const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const {fixture}=require('./native-coordinator-fixture.cjs');
const root='apps/harmony/scheduler/src/main/ets/v2/coordinator/';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
async function setup(){
 const f=fixture(),pack=JSON.parse(fs.readFileSync('.test/s2-harmony-coordinator/entry/src/main/resources/rawfile/reference-packs.json')).find(p=>p.manifest.contract.capability==='catalog.filter.v1');
 const p=JSON.parse(fs.readFileSync('contracts/scheduling/v2/fixtures/t2/valid/DeviceProfile.json'));
 function measured(v){if(!v||typeof v!=='object')return;if('sampledAt' in v){v.sampledAt=Date.now()-5;v.ttlMs=60000;if(v.source==='SIMULATED')v.source='MEASURED';}else Object.values(v).forEach(measured);}measured(p);p.domain='REAL';p.queued=[];p.inFlight=[];
 const sample=(value,unit)=>({value,unit,source:'MEASURED',sampledAt:Date.now(),ttlMs:60000});
 for(const pool of p.pools)pool.resourcePoolId=pool.kind==='RAM_BYTES'?'ram':'cpu';for(const pool of p.pools){pool.total=sample(pool.resourcePoolId==='cpu'?12:4*1024**3,pool.total.unit);pool.admissionLimit={...pool.total};pool.occupied=sample(0,pool.total.unit);pool.draining=false;}
 const e={...p.executors[0],contract:pack.manifest.contract,model:null,resources:pack.manifest.resourceLimit,configurations:[pack.cases[0].config],compute:sample(3,'ms'),queue:sample(0,'ms'),cold:sample(1,'ms'),publish:sample(1,'ms'),uncertainty:sample(1,'ms')};e.target={...e.target,executorId:'node.cpu.v1',resourcePoolIds:['cpu','ram']};p.executors=[e];p.credits=[{priority:'REMOTE_INTERACTIVE',slots:4}];p.links=[['center',p.deviceId],[p.deviceId,'center']].map(([from,to])=>({from,to,networkEpoch:'lan',via:null,fixedMs:sample(1,'ms'),bytesPerSecond:sample(100000000,'bytes_per_second'),metered:false}));
 const worker={groupId:'g',principalId:'p',deviceId:p.deviceId,holderInstanceId:p.holderInstanceId,credentialId:'worker-credential'},source={groupId:'g',principalId:'p',deviceId:'phone',holderInstanceId:'soleai',credentialId:'source-credential',app:{groupId:'g',principalId:'p',appId:'soleai',appInstanceId:'soleai-instance',allowedContracts:['catalog.filter.v1']}};
 f.sql.prepare('INSERT INTO DeviceInstance (id,groupId,revision,metadataJson) VALUES (?,?,1,?)').run(JSON.stringify(['profile','g',p.holderInstanceId]),'g',JSON.stringify(p));f.database.controlState=()=> 'ONLINE';
 const q=new (f.load(root+'CoordinatorQualification.ets').CoordinatorQualification)(f.database,JSON.stringify([pack]),7);
 const auth={authenticate:async token=>{if(token==='source')return source;if(token==='worker')return worker;throw Error('CREDENTIAL_INVALID')}};
 const artifacts=new (f.load(root+'CoordinatorArtifacts.ets').CoordinatorArtifacts)(f.database,auth);
 return {...f,p,e,pack,q,worker,source,artifacts};
}
async function qualify(f){for(const c of f.pack.cases){const {work}=await f.q.claim(f.worker);assert.equal(work.permit.caseId,c.id);const report={settled:true,permitId:work.permit.id,domain:'REAL',durationMs:3,output:c.expect.kind==='REJECT'?'':Buffer.from(JSON.stringify(c.expected)).toString('base64'),...(c.expect.kind==='REJECT'?{errorCode:c.expect.errorCode}:{})};await f.q.report(f.worker,work.permit.id,report);}}
test('native qualification verifies full reference suite and reconciles claims without rerunning',async()=>{
 const f=await setup();const first=await f.q.claim(f.worker),again=await f.q.claim(f.worker);assert.equal(again.work.permit.id,first.work.permit.id);assert.equal(again.work.mode,'RECONCILE');
 await assert.rejects(f.q.report({...f.worker,holderInstanceId:'other'},first.work.permit.id,{}),/SCOPE/);
 const c=f.pack.cases[0],report={settled:true,permitId:first.work.permit.id,domain:'REAL',durationMs:3,output:Buffer.from(JSON.stringify(c.expected)).toString('base64')};await f.q.report(f.worker,first.work.permit.id,report);await f.q.report(f.worker,first.work.permit.id,report);
 await assert.rejects(f.q.report(f.worker,first.work.permit.id,{...report,durationMs:4}),/CONFLICT/);
 for(const c of f.pack.cases.slice(1)){const {work}=await f.q.claim(f.worker);await f.q.report(f.worker,work.permit.id,{settled:true,permitId:work.permit.id,domain:'REAL',durationMs:3,output:c.expect.kind==='REJECT'?'':Buffer.from(JSON.stringify(c.expected)).toString('base64'),...(c.expect.kind==='REJECT'?{errorCode:c.expect.errorCode}:{})});}
 let evidence;await f.database.transaction(async tx=>evidence=await f.q.evidence(tx,f.worker,f.e.target.targetId));assert.equal(evidence.admission.state,'ACTIVE');assert.equal((await f.q.claim(f.worker)).work,null);
});
test('native artifact relay preserves binary data and rejects wrong holders, hashes and expiry',async()=>{
 const f=await setup(),content=Buffer.from([0,255,128,13,10,42]),descriptor={groupId:'g',ownerPrincipalId:'p',ref:{artifactId:'blob',contentVersion:1,contentHash:hash(content),schemaId:'catalog.items',schemaVersion:1},bytes:content.length,expiresAt:Date.now()+60000};let write,read;
 await f.database.transaction(async tx=>{write=await f.artifacts.issue(tx,descriptor,f.source,'WRITE');read=await f.artifacts.issue(tx,descriptor,f.worker,'READ');});
 const request={method:'PUT',path:'/v2/artifacts/blob/1',authorization:'Bearer '+write.token,deviceCredential:'source',body:content};
 await assert.rejects(f.artifacts.handle({...request,deviceCredential:'worker'}),/SCOPE/);await assert.rejects(f.artifacts.handle({...request,body:Buffer.alloc(content.length)}),/INTEGRITY/);await f.artifacts.handle(request);await f.artifacts.handle(request);
 const got=await f.artifacts.handle({...request,method:'GET',authorization:'Bearer '+read.token,deviceCredential:'worker',body:Buffer.alloc(0)});assert.deepEqual(Buffer.from(got.binaryBody),content);
});
test('native SDK chain selects remote worker, persists admission and validates output before settlement',async()=>{
 const f=await setup();await qualify(f);
 f.e.queue={value:null,source:'UNKNOWN',sampledAt:Date.now()-1,ttlMs:60000,unit:'ms'};
 f.sql.prepare('UPDATE DeviceInstance SET metadataJson=?').run(JSON.stringify(f.p));
 const grant={grant:{allotmentId:'a1',version:1,coordinatorEpoch:7,ledgerEpoch:1,appInstanceId:null},ack:{version:1,persisted:true}};f.sql.prepare('INSERT INTO Allotment (id,groupId,revision,metadataJson) VALUES (?,?,1,?)').run(JSON.stringify(['allotment','g',f.p.holderInstanceId]),'g',JSON.stringify(grant));
 const handlers=new Map(),messages=[];const channel={register:(name,handler)=>handlers.set(name,handler),enqueue:async(...args)=>messages.push(args.slice(1)),pump:async()=>{}};
 const jobs=new (f.load(root+'CoordinatorJobs.ets').CoordinatorJobs)(f.database,channel,f.artifacts,f.q,'center',7);
 const content=Buffer.from(JSON.stringify({currency:'CNY',maxPriceMinor:50000,items:[{id:'item',price:'19.99',currency:'CNY',rank:0}]}));
 const body={workflow:{version:3,id:'shopping',outputContract:'catalog.ranked',qualityTarget:'reference',nodes:[{id:'rank',capability:'catalog.filter.v1',input:{bytes:content.length,contentHash:hash(content),schemaId:'catalog.items',schemaVersion:1},parameters:'{}',dependsOn:[]}]},options:{requestId:'shopping-test',budgetMs:30000,resultDestination:'ORIGIN'}};
 const plan=await jobs.submit(f.source,body);assert.equal(plan.deviceId,f.p.deviceId);assert.equal(f.sql.prepare('SELECT count(*) n FROM Attempt').get().n,0);
 await assert.rejects(jobs.startJob(f.source,plan.jobId),/INPUT_NOT_UPLOADED/);
 await f.artifacts.handle({method:'PUT',path:'/v2/artifacts/'+plan.inputTicket.ref.artifactId+'/1',authorization:'Bearer '+plan.inputTicket.token,deviceCredential:'source',body:content});
 await jobs.startJob(f.source,plan.jobId);await jobs.startJob(f.source,plan.jobId);assert.equal(messages.length,1);
 const auth=await jobs.execution(f.worker,plan.jobId,'authorize',{}),offer=auth.offer,t=offer.task;
 const record={groupId:'g',principalId:'p',appInstanceId:'soleai-instance',attemptId:t.attemptId,holderInstanceId:f.worker.holderInstanceId,ledgerEpoch:1,planRevision:1,coordinatorEpoch:7,executionDigest:hash(canonical({inputs:t.inputs,contract:t.contract,parameters:t.parameters,allowedTargetIds:t.allowedTargetIds,allowedConfigurations:t.allowedConfigurations})),allotmentId:'a1',allotmentVersion:1,leaseId:'lease-1',fence:{deviceId:f.p.deviceId,holderInstanceId:f.p.holderInstanceId,ledgerEpoch:1,counter:1},businessIdempotencyKey:null,state:'ACCEPTED',resourcesSettled:false,receipt:null};
 const admission={attemptId:t.attemptId,holderInstanceId:f.p.holderInstanceId,status:'ACCEPTED',reasonCode:null,record,wait:{value:0,source:'MEASURED',sampledAt:Date.now(),ttlMs:1000,unit:'ms'}};
 assert.equal(handlers.get('AdmissionReply').validate(admission),true);await f.database.transaction(tx=>handlers.get('AdmissionReply').handle(tx,f.worker,admission));
 assert.equal((await jobs.status(f.source,plan.jobId)).state,'ACCEPTED');
 const output=Buffer.from(JSON.stringify({scanned:1,excluded:0,items:[{id:'item',priceMinor:1999,rank:0}]}));const upload=await jobs.execution(f.worker,plan.jobId,'output',{bytes:output.length,contentHash:hash(output),schemaId:'catalog.ranked'});
 const receipt={attemptId:t.attemptId,coordinatorEpoch:7,planRevision:1,fence:record.fence,state:'SUCCEEDED',resourcesSettled:true,outputs:[upload.ticket.ref],actualTarget:offer.target,actualConfiguration:offer.allowedConfigs[0].id,errorCode:null};const report={receipt,allotmentId:'a1',allotmentVersion:1,leaseId:'lease-1',actualModel:null,timings:[]};
 await assert.rejects(f.database.transaction(tx=>handlers.get('ExecutionReceipt').handle(tx,f.worker,report)),/OUTPUT_NOT_UPLOADED/);
 await f.artifacts.handle({method:'PUT',path:'/v2/artifacts/'+upload.ticket.ref.artifactId+'/1',authorization:'Bearer '+upload.ticket.token,deviceCredential:'worker',body:output});
 await f.database.transaction(tx=>handlers.get('ExecutionReceipt').handle(tx,f.worker,report));await f.database.transaction(tx=>handlers.get('ExecutionReceipt').handle(tx,f.worker,report));
 const status=await jobs.status(f.source,plan.jobId);assert.equal(status.state,'SUCCEEDED');assert.equal(status.outputTicket.ref.contentHash,hash(output));assert.equal(JSON.parse(f.sql.prepare('SELECT recordJson FROM Attempt').get().recordJson).resourcesSettled,true);
 await assert.rejects(jobs.status(f.worker,plan.jobId),/JOB_SCOPE/);
 // The heartbeat still lists this settled attempt; its receipt must release scheduling credit immediately.
 for(const pool of f.p.pools)pool.occupied.value=offer.resources.find(r=>r.resourcePoolId===pool.resourcePoolId)?.amount??0;
 f.p.inFlight=[{attemptId:t.attemptId,targetId:offer.target.targetId,state:'RUNNING',resources:offer.resources,elapsed:{value:10,source:'MEASURED',sampledAt:Date.now(),ttlMs:60000,unit:'ms'},remaining:{value:null,source:'UNKNOWN',sampledAt:Date.now(),ttlMs:60000,unit:'ms'}}];f.p.credits[0].slots=0;
 f.sql.prepare('UPDATE DeviceInstance SET metadataJson=?').run(JSON.stringify(f.p));
 const next=await jobs.submit(f.source,{...body,options:{...body.options,requestId:'after-settlement'}});assert.equal(next.deviceId,f.p.deviceId,'settled receipt overrides only its exact stale in-flight reservation');

});

test('native dispatch pipelines multiple offers up to real credits without allowing unreported oversubscription',async()=>{
 const f=await setup();await qualify(f);const grant={grant:{allotmentId:'a1',version:1,coordinatorEpoch:7,ledgerEpoch:1,appInstanceId:null},ack:{version:1,persisted:true}};f.sql.prepare('INSERT INTO Allotment (id,groupId,revision,metadataJson) VALUES (?,?,1,?)').run(JSON.stringify(['allotment','g',f.p.holderInstanceId]),'g',JSON.stringify(grant));
 const messages=[],jobs=new (f.load(root+'CoordinatorJobs.ets').CoordinatorJobs)(f.database,{register(){},enqueue:async(...args)=>messages.push(args),pump:async()=>{}},f.artifacts,f.q,'center',7),content=Buffer.from('{}'),source={groupId:'g',ownerPrincipalId:'p',ref:{artifactId:'common-source',contentVersion:1,contentHash:hash(content),schemaId:'catalog.items',schemaVersion:1},bytes:content.length,expiresAt:Date.now()+60000};await f.database.transaction(tx=>f.artifacts.writeContent(tx,source,content.toString('base64')));
 const submission=i=>({workflow:{version:3,id:'pipeline'+i,outputContract:'catalog.ranked',qualityTarget:'reference',nodes:[{id:'rank',capability:'catalog.filter.v1',input:{bytes:source.bytes,contentHash:source.ref.contentHash,schemaId:source.ref.schemaId,schemaVersion:1},parameters:'{}',dependsOn:[]}]},options:{requestId:'pipeline'+i,budgetMs:30000,resultDestination:'ORIGIN'}});
 for(let i=0;i<4;i++){await jobs.submit(f.source,submission(i),source);await jobs.startJob(f.source,'pipeline'+i);}
 assert.equal(messages.length,4,'no holder-wide one-offer barrier');await assert.rejects(jobs.submit(f.source,submission(4),source),/NO_LEGAL_PLAN/);
 assert.equal(f.sql.prepare('SELECT COUNT(*) n FROM Attempt').get().n,4);assert.equal(JSON.parse(await jobs.inspect(f.source,'pipeline0')).input.ref.artifactId,'common-source','stages retain existing immutable input without reupload');
});

test('zero-byte boundary cases do not stall the native evaluation queue; only advertised configs are evaluated',async()=>{
 const f=await setup(),pack=structuredClone(f.pack),standard=pack.cases[0].config;pack.cases=[{id:'empty-bytes',input:'',config:standard,maxOutputBytes:65536,expect:{kind:'REJECT',errorCode:'CATALOG_INVALID'}},{id:'unsupported-threads',input:'',config:{...standard,id:'parallel-8',threads:8},maxOutputBytes:65536,expect:{kind:'REJECT',errorCode:'CATALOG_INVALID'}}];
 const q=new (f.load(root+'CoordinatorQualification.ets').CoordinatorQualification)(f.database,JSON.stringify([pack]),7),{work}=await q.claim(f.worker);assert.equal(work.permit.inputHash,hash(Buffer.alloc(0)));assert.equal(work.permit.caseId,'empty-bytes');
 await q.report(f.worker,work.permit.id,{settled:true,permitId:work.permit.id,domain:'REAL',durationMs:0,output:'',errorCode:'CATALOG_INVALID'});assert.equal((await q.claim(f.worker)).work,null);let evidence;await f.database.transaction(async tx=>{evidence=await q.evidence(tx,f.worker,f.e.target.targetId)});assert.equal(evidence.admission.state,'ACTIVE');
});

test('internal photo dispatch is atomic, plans once, avoids write tickets and remains idempotent across budget retry',async()=>{
 const f=await setup();await qualify(f);const grant={grant:{allotmentId:'a1',version:1,coordinatorEpoch:7,ledgerEpoch:1,appInstanceId:null},ack:{version:1,persisted:true}};f.sql.prepare('INSERT INTO Allotment (id,groupId,revision,metadataJson) VALUES (?,?,1,?)').run(JSON.stringify(['allotment','g',f.p.holderInstanceId]),'g',JSON.stringify(grant));
 let choices=0,issues=0;const messages=[],jobs=new (f.load(root+'CoordinatorJobs.ets').CoordinatorJobs)(f.database,{register(){},enqueue:async(...args)=>messages.push(args),pump:async()=>{}},f.artifacts,f.q,'center',7),content=Buffer.from('{}'),source={groupId:'g',ownerPrincipalId:'p',ref:{artifactId:'atomic-input',contentVersion:1,contentHash:hash(content),schemaId:'catalog.items',schemaVersion:1},bytes:content.length,expiresAt:Date.now()+60000};await f.database.transaction(tx=>f.artifacts.writeContent(tx,source,content.toString('base64')));
 const choose=jobs.choose.bind(jobs);jobs.choose=async(...args)=>{choices++;return choose(...args);};const issue=f.artifacts.issue.bind(f.artifacts);f.artifacts.issue=async(...args)=>{issues++;return issue(...args);};
 const body={workflow:{version:3,id:'atomic',outputContract:'catalog.ranked',qualityTarget:'reference',nodes:[{id:'rank',capability:'catalog.filter.v1',input:{bytes:source.bytes,contentHash:source.ref.contentHash,schemaId:source.ref.schemaId,schemaVersion:1},parameters:'{}',dependsOn:[]}]},options:{requestId:'atomic',budgetMs:30000,resultDestination:'ORIGIN'}};
 const result=await jobs.submit(f.source,body,source,true);assert.equal(result.target.deviceId,f.p.deviceId);assert.equal(choices,1);assert.equal(issues,0);assert.equal(messages.length,1);assert.equal(JSON.parse(await jobs.inspect(f.source,'atomic')).state,'OFFERED');
 await jobs.submit(f.source,{...body,options:{...body.options,budgetMs:29000}},source,true);assert.equal(choices,1);assert.equal(messages.length,1);
});

test('origin input stays on the authenticated app holder; no relay upload is required for a local root',async()=>{
 const f=await setup();await qualify(f);const grant={grant:{allotmentId:'a1',version:1,coordinatorEpoch:7,ledgerEpoch:1,appInstanceId:null},ack:{version:1,persisted:true}};f.sql.prepare('INSERT INTO Allotment (id,groupId,revision,metadataJson) VALUES (?,?,1,?)').run(JSON.stringify(['allotment','g',f.p.holderInstanceId]),'g',JSON.stringify(grant));
 const messages=[],jobs=new (f.load(root+'CoordinatorJobs.ets').CoordinatorJobs)(f.database,{register(){},enqueue:async(...args)=>messages.push(args),pump:async()=>{}},f.artifacts,f.q,'center',7),content=Buffer.from('{}'),peer={...f.source,deviceId:f.p.deviceId,holderInstanceId:f.p.holderInstanceId},source={groupId:'g',ownerPrincipalId:'p',ref:{artifactId:'origin-only',contentVersion:1,contentHash:hash(content),schemaId:'catalog.items',schemaVersion:1},bytes:content.length,expiresAt:Date.now()+60000};
 await f.database.transaction(tx=>f.artifacts.register(tx,source));const body={workflow:{version:3,id:'local',outputContract:'catalog.ranked',qualityTarget:'reference',nodes:[{id:'rank',capability:'catalog.filter.v1',input:{bytes:source.bytes,contentHash:source.ref.contentHash,schemaId:source.ref.schemaId,schemaVersion:1},executionScope:'ORIGIN_DEVICE',parameters:'{}',dependsOn:[]}]},options:{requestId:'local',budgetMs:30000,resultDestination:'ORIGIN',inputLocation:'ORIGIN'}};
 await jobs.submit(peer,body,source,true,true);const job=JSON.parse(await jobs.inspect(peer,'local'));assert.equal(job.holder,peer.holderInstanceId);assert.deepEqual(job.offer.transferPlan,[]);let available;await f.database.transaction(async tx=>available=await f.artifacts.available(tx,source));assert.equal(available,false,'input was not secretly uploaded or synthesized');
 await assert.rejects(jobs.submit(peer,{...body,options:{...body.options,requestId:'relay'}},source,true,false),/INPUT_NOT_UPLOADED/);
});

test('native workflow restart proof requires a matching durable PURE yield and settled receipt',async()=>{
 const f=await setup(),jobs=new (f.load(root+'CoordinatorJobs.ets').CoordinatorJobs)(f.database,{register(){}},f.artifacts,f.q,'center',7),id='settled-yield',job={owner:f.source,holder:f.worker.holderInstanceId,state:'CANCELLED_SETTLED',offer:{task:{contract:{sideEffectPolicy:'PURE',interruptibility:'CANCEL_RESTART'}}}};
 f.sql.prepare('INSERT INTO CpuJob(id,groupId,principalId,sourceHolderId,state,metadataJson) VALUES(?,?,?,?,?,?)').run(id,'g','p',f.source.holderInstanceId,job.state,JSON.stringify(job));
 const record={resourcesSettled:true,receipt:{attemptId:id,state:'CANCELLED_SETTLED',resourcesSettled:true}},notice={attemptId:id,kind:'RESTART'};
 f.sql.prepare('INSERT INTO Workflow(id,groupId,planRevision,state) VALUES(?,?,?,?)').run(id,'g',1,'ACTIVE');
 f.sql.prepare('INSERT INTO Node(id,workflowId,currentAttemptId,state) VALUES(?,?,?,?)').run(id,id,id,'CANCELLED_SETTLED');
 f.sql.prepare('INSERT INTO Attempt(id,groupId,workflowId,nodeId,executionDigest,state,holderInstanceId,taskJson,offerJson,recordJson,yieldJson) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,'g',id,id,'x','CANCELLED_SETTLED',f.worker.holderInstanceId,'{}','{}',JSON.stringify(record),JSON.stringify(notice));
 const restart=async()=>JSON.parse(await jobs.inspectMany(f.source,[id]))[0].restartable;
 assert.equal(await restart(),true);
 for(const r of [{...record,resourcesSettled:false},{...record,receipt:{...record.receipt,attemptId:'other'}},{...record,receipt:null}]){f.sql.prepare('UPDATE Attempt SET recordJson=?').run(JSON.stringify(r));assert.equal(await restart(),false);}
 f.sql.prepare('UPDATE Attempt SET recordJson=?,yieldJson=NULL').run(JSON.stringify(record));assert.equal(await restart(),false);
 f.sql.prepare('UPDATE Attempt SET yieldJson=?').run(JSON.stringify(notice));job.offer.task.contract.sideEffectPolicy='COMMIT';f.sql.prepare('UPDATE CpuJob SET metadataJson=?').run(JSON.stringify(job));assert.equal(await restart(),false);
});

test('recovery redelivers an unadmitted immutable offer, but never replays a missing admitted execution',async()=>{
 const f=await setup();await qualify(f);const grant={grant:{allotmentId:'a1',version:1,coordinatorEpoch:7,ledgerEpoch:1,appInstanceId:null},ack:{version:1,persisted:true}};f.sql.prepare('INSERT INTO Allotment (id,groupId,revision,metadataJson) VALUES (?,?,1,?)').run(JSON.stringify(['allotment','g',f.p.holderInstanceId]),'g',JSON.stringify(grant));
 const handlers=new Map(),messages=[],jobs=new (f.load(root+'CoordinatorJobs.ets').CoordinatorJobs)(f.database,{register:(n,h)=>handlers.set(n,h),enqueue:async(...args)=>messages.push(args.slice(1)),pump:async()=>{}},f.artifacts,f.q,'center',7),content=Buffer.from('{}'),source={groupId:'g',ownerPrincipalId:'p',ref:{artifactId:'origin',contentVersion:1,contentHash:hash(content),schemaId:'catalog.items',schemaVersion:1},bytes:2,expiresAt:Date.now()+60000};await f.database.transaction(tx=>f.artifacts.writeContent(tx,source,content.toString('base64')));
 const body={workflow:{version:3,id:'recover',outputContract:'catalog.ranked',qualityTarget:'reference',nodes:[{id:'rank',capability:'catalog.filter.v1',input:{bytes:2,contentHash:hash(content),schemaId:'catalog.items',schemaVersion:1},parameters:'{}',dependsOn:[]}]},options:{requestId:'recover',budgetMs:30000,resultDestination:'ORIGIN'}};
 await jobs.submit(f.source,body,source,true);const first=messages[0][3];await f.database.transaction(tx=>handlers.get('AttemptStatusReply').handle(tx,f.worker,{attemptId:'recover',record:null}));
 assert.equal(messages.length,2);assert.deepEqual(messages[1][3],first);assert.equal((await jobs.status(f.source,'recover')).state,'OFFERED');
 f.sql.prepare('UPDATE Attempt SET recordJson=?').run(JSON.stringify({resourcesSettled:false}));await f.database.transaction(tx=>handlers.get('AttemptStatusReply').handle(tx,f.worker,{attemptId:'recover',record:null}));assert.equal(messages.length,2);assert.equal((await jobs.status(f.source,'recover')).state,'HOLDER_RECORD_MISSING');
 assert.equal(f.sql.prepare('SELECT state FROM Attempt WHERE id=?').get('recover').state,'HOLDER_RECORD_MISSING','missing attempts must no longer block every future grant as admission-pending');
 const old=JSON.parse(f.sql.prepare('SELECT metadataJson FROM CpuJob WHERE id=?').get('recover').metadataJson);old.state='OFFERED';old.offer.task.coordinatorEpoch=6;
 f.sql.prepare("UPDATE Attempt SET recordJson=NULL,state='OFFERED' WHERE id=?").run('recover');f.sql.prepare('UPDATE CpuJob SET state=?,metadataJson=? WHERE id=?').run(old.state,JSON.stringify(old),'recover');
 await f.database.transaction(tx=>handlers.get('AttemptStatusReply').handle(tx,f.worker,{attemptId:'recover',record:null}));assert.equal(messages.length,2,'retired-epoch offer cannot be redelivered');
 assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM Attempt WHERE holderInstanceId=? AND state='OFFERED'").get(f.worker.holderInstanceId).n,0,'old unadmitted attempt cannot permanently block renewal');
});

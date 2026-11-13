const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {fixture}=require('./native-coordinator-fixture.cjs');
const root='apps/harmony/scheduler/src/main/ets/v2/coordinator/';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function setup(){
 const f=fixture(),peer={groupId:'g',principalId:'p',holderInstanceId:'photo-host',deviceId:'phone',credentialId:'c',app:{appInstanceId:'photo-app',allowedContracts:['photo.analyze.v1','photo.enhance.v1','photo.deliver.v1']}},jobs=new Map(),dispatches=[],blocked=new Set();
 const artifacts=new (f.load(root+'CoordinatorArtifacts.ets').CoordinatorArtifacts)(f.database,{authenticate:async()=>peer});
 const service={inspectMany:async(p,ids)=>JSON.stringify(ids.map(id=>{if(!jobs.has(id))throw Error('JOB_UNKNOWN');return jobs.get(id);})),inspect:async(p,id)=>{if(!jobs.has(id))throw Error('JOB_UNKNOWN');return JSON.stringify(jobs.get(id));},submit:async(p,s,source,start,sourceLocal)=>{if(blocked.has(s.workflow.nodes[0].id))throw Error('NO_LEGAL_PLAN');dispatches.push(s);jobs.set(s.options.requestId,{input:source,sourceLocal,state:start?'ACCEPTED':'WAITING_INPUT',offer:{target:{deviceId:s.workflow.nodes[0].executionScope?'phone':'B',targetId:'t',backend:s.workflow.nodes[0].executionScope?'cpu':'vulkan'}}});return {target:jobs.get(s.options.requestId).offer.target};},attachInput:async(p,id,source)=>{jobs.get(id).input=source;},startJob:async(p,id)=>{jobs.get(id).state='ACCEPTED';},cancel:async(p,id)=>{jobs.get(id).state='CANCELLED';return {};}};
 const packs=peer.app.allowedContracts.map(capability=>({manifest:{contract:{capability,outputSchemas:[capability==='photo.deliver.v1'?'photo.product':'photo.work']},model:null}}));
 const Photo=f.load(root+'CoordinatorPhoto.ets').CoordinatorPhoto,photo=new Photo(f.database,artifacts,service,JSON.stringify(packs)),engine=photo.engine;
 const bytes=Buffer.from('real input bytes'),input={bytes:bytes.length,contentHash:hash(bytes),schemaId:'image.encoded',schemaVersion:1};
 const workflow={version:3,id:'photo',qualityTarget:'reference',outputContract:'photo.product',nodes:[{id:'analyze',capability:'photo.analyze.v1',input,executionScope:'ORIGIN_DEVICE',parameters:'{}',dependsOn:[]},...['enhance-0','enhance-1'].map(id=>({id,capability:'photo.enhance.v1',inputFrom:'analyze',parameters:'{}',dependsOn:['analyze']})),{id:'deliver',capability:'photo.deliver.v1',executionScope:'ORIGIN_DEVICE',inputFroms:['enhance-0','enhance-1'],parameters:'{}',dependsOn:['enhance-0','enhance-1']}]};
 const sdk=(path,body)=>engine.sdk(JSON.stringify(peer),path,body?JSON.stringify(body):'').then(JSON.parse),api=m=>engine.photo(JSON.stringify(peer),JSON.stringify(m)).then(JSON.parse);
 async function submit(id){const plan=await sdk('/v2/sdk/jobs',{workflow,options:{requestId:id,budgetMs:180000,resultDestination:'ORIGIN'}});await artifacts.handle({method:'PUT',path:'/v2/artifacts/'+plan.inputTicket.ref.artifactId+'/1',authorization:'Bearer '+plan.inputTicket.token,deviceCredential:'source',body:bytes});await sdk('/v2/sdk/jobs/'+id+'/start');await engine.tick();return plan;}
 async function finish(id,product){const b=Buffer.from(JSON.stringify(product??{id})),descriptor={groupId:'g',ownerPrincipalId:'p',ref:{artifactId:'out-'+id,contentVersion:1,contentHash:hash(b),schemaId:id.endsWith('deliver')?'photo.product':'photo.work',schemaVersion:1},bytes:b.length,expiresAt:Date.now()+3600000};await f.database.transaction(tx=>artifacts.writeContent(tx,descriptor,b.toString('base64')));jobs.get(id).output=descriptor;jobs.get(id).state='SUCCEEDED';}
 return {...f,peer,engine,jobs,dispatches,blocked,input,workflow,sdk,api,submit,finish,bytes,photo};
}
test('native multi-stage graph waits for committed dependencies, overlaps siblings, survives retry, preserves budget and avoids duplicate computation',async()=>{
 const f=setup();await f.submit('round');assert.deepEqual(f.dispatches.map(s=>s.workflow.nodes[0].id),['analyze']);
 await f.finish('round.analyze');f.blocked.add('enhance-0');await f.engine.tick();assert.equal(f.jobs.get('round.enhance-1').state,'ACCEPTED');assert.equal(f.jobs.has('round.deliver'),false);
 f.blocked.clear();await f.engine.tick();await f.engine.tick();assert.equal(f.dispatches.filter(s=>s.workflow.nodes[0].id==='enhance-0').length,1);
 await f.finish('round.enhance-0');await f.engine.tick();assert.equal(f.jobs.has('round.deliver'),false);await f.finish('round.enhance-1');await f.engine.tick();
 assert.equal(f.jobs.get('round.deliver').input.ref.schemaId,'artifact.bundle');assert.equal(f.jobs.get('round.deliver').offer.target.deviceId,'phone');
 await f.finish('round.deliver');await f.engine.tick();assert.equal((await f.sdk('/v2/sdk/jobs/round')).state,'SUCCEEDED');assert.equal(f.dispatches.length,4);assert.ok(f.dispatches.every(s=>s.options.budgetMs<=180000&&s.options.budgetMs>0));await f.engine.restore();await f.engine.tick();assert.equal(f.dispatches.length,4);
});
test('photo run only exposes captured and delivered products; real graph status drives the existing judge view',async()=>{
 const f=setup(),r=await f.api({route:'/photo-runs',method:'POST',body:{mode:'COOPERATIVE',budgetMs:180000,inputs:[{hash:f.input.contentHash,bytes:f.input.bytes,width:1,height:1,name:'one.png'}]}});
 await f.api({route:`/photo-runs/${r.id}/input?image=0`,method:'PUT',data:f.bytes.toString('base64')});await f.submit('batch');
 let v=await f.api({route:'/photo-runs/'+r.id,method:'POST',body:{revision:0,state:'RUNNING',jobs:[{id:'batch',imageIndex:0}]}});
 await assert.rejects(f.api({route:'/photo-runs/'+r.id+'/capture-result?image=0',method:'POST',body:{}}),/PENDING/);
 for(const ids of [['batch.analyze'],['batch.enhance-0','batch.enhance-1']]){for(const id of ids)await f.finish(id);await f.engine.tick();}
 const png=Buffer.from('result'),product={image:png.toString('base64'),hash:hash(png),width:4,height:4};await f.finish('batch.deliver',product);await f.engine.tick();await f.api({route:'/photo-runs/'+r.id+'/capture-result?image=0',method:'POST',body:{}});
 v=await f.api({route:'/photo-runs/'+r.id,method:'POST',body:{revision:v.revision,deliveredImage:{imageIndex:0,hash:product.hash}}});await f.api({route:'/photo-runs/'+r.id,method:'POST',body:{revision:v.revision,state:'SUCCEEDED',sourceDurationMs:1234}});
 const display=JSON.parse(await f.engine.display('/runs/'+encodeURIComponent('coop:'+r.id),'','','http://172.20.10.2:7460','[{"id":"B","title":"GPU 电脑"}]'));assert.equal(display.results.length,1);assert.equal(display.durationMs,1234);assert.equal(display.workflows[0].nodes[1].target.deviceId,'B');assert.equal(display.devices.length,2);
 const summaries=JSON.parse(await f.engine.display('/runs','','','http://172.20.10.2:7460','[]'));assert.equal(summaries.runs[0].devices.length,2,'cached history still shows both actual executors');
 assert.equal(JSON.parse(await f.engine.display('/images/'+encodeURIComponent(display.id)+'/0/result','','','http://172.20.10.2:7460','[]')).data,product.image);
});
test('display-only connect, sequenced results, reset and old key revocation do not dispatch any compute',async()=>{
 const f=setup(),address='http://172.20.10.2:7460',call=(p,b,k='')=>f.engine.display(p,JSON.stringify(b??{}),k,address,'[]').then(JSON.parse),session=await call('/session'),key=session.invitation.split('=')[1];
 assert.equal((await call('/connect',{},key)).displayOnly,true);await call('/event',{seq:1,type:'SELECTED',runId:'r',inputs:[{name:'p',width:1,height:1,preview:'data:image/jpeg;base64,YQ=='}]},key);await call('/event',{seq:2,type:'START',runId:'r'},key);
 await assert.rejects(call('/event',{seq:3,type:'FINISH',runId:'r',durationMs:10},key),/INCOMPLETE/);const b=Buffer.from('product');await call('/event',{seq:3,type:'RESULT',runId:'r',imageIndex:0,product:{image:b.toString('base64'),hash:hash(b),width:4,height:4}},key);await call('/event',{seq:4,type:'FINISH',runId:'r',durationMs:42},key);assert.equal((await call('/runs')).runs.length,1);
 await new Promise(r=>setTimeout(r,2));await call('/reset');assert.equal((await call('/runs')).runs.length,0);await assert.rejects(call('/connect',{},key),/KEY_INVALID/);assert.equal(f.dispatches.length,0);
});

test('idle graph polls do not rewrite persisted graphs and explicit capacity rejection retries only the unaccepted node',async()=>{
 const f=setup();await f.submit('retry');await f.finish('retry.analyze');await f.engine.tick();await f.engine.tick();
 const revision=()=>f.sql.prepare("SELECT revision FROM Device WHERE id='native-photo:graph:retry'").get().revision;
 const before=revision();await f.engine.tick();await f.engine.tick();assert.equal(revision(),before,'no changes means no graph writes');
 const j=f.jobs.get('retry.enhance-0');j.state='REJECTED';j.rejection={status:'REJECTED',record:null,reasonCode:'RESOURCE_UNAVAILABLE'};
 await f.engine.tick();assert.equal(f.jobs.has('retry.enhance-0.r1'),false,'backoff before retry');
 f.engine.port.now=()=>Date.now()+500;await f.engine.tick();assert.equal(f.jobs.get('retry.enhance-0.r1').state,'ACCEPTED');
 assert.equal(f.dispatches.filter(s=>s.options.requestId==='retry.enhance-1').length,1,'accepted sibling never redispatched');
 await f.finish('retry.enhance-0.r1');await f.finish('retry.enhance-1');await f.engine.tick();await f.finish('retry.deliver');await f.engine.tick();assert.equal((await f.sdk('/v2/sdk/jobs/retry')).state,'SUCCEEDED');
 const retried=f.dispatches.find(s=>s.options.requestId==='retry.enhance-0.r1');assert.ok(retried.options.budgetMs<f.dispatches[0].options.budgetMs,'original remaining budget survives retry');
});

test('non-capacity rejection never triggers speculative duplicate execution',async()=>{
 const f=setup();await f.submit('reject');const j=f.jobs.get('reject.analyze');j.state='REJECTED';j.rejection={status:'REJECTED',record:null,reasonCode:'POLICY_REJECTED'};await f.engine.tick();await f.engine.tick();assert.equal((await f.sdk('/v2/sdk/jobs/reject')).state,'FAILED');assert.equal(f.dispatches.length,1);
});

test('origin-staged input executes on its app host without upload/download, while derived inputs still use validated relay artifacts',async()=>{
 const f=setup(),plan=await f.sdk('/v2/sdk/jobs',{workflow:f.workflow,options:{requestId:'local-root',budgetMs:180000,resultDestination:'ORIGIN',inputLocation:'ORIGIN'}});
 assert.equal(plan.inputDelivery,'LOCAL');await f.sdk('/v2/sdk/jobs/local-root/start');await f.engine.tick();assert.equal(f.jobs.get('local-root.analyze').sourceLocal,true);
 await f.finish('local-root.analyze');await f.engine.tick();assert.equal(f.jobs.get('local-root.enhance-0').sourceLocal,false);assert.equal(f.jobs.get('local-root.enhance-1').sourceLocal,false);
});

test('settled restartable GPU yield resumes only that block within original budget; all six photos complete',async()=>{
 const f=setup();for(let i=0;i<6;i++){await f.submit('photo'+i);await f.finish('photo'+i+'.analyze');}await f.engine.tick();
 for(let i=0;i<6;i++){await f.finish('photo'+i+'.enhance-0');const j=f.jobs.get('photo'+i+'.enhance-1');j.state='CANCELLED_SETTLED';j.restartable=true;j.yieldNotice={reasonCode:'OWNER_ACTIVE'};}
 await f.engine.tick();assert.equal(f.dispatches.filter(s=>s.options.requestId.endsWith('.r1')).length,0);
 f.engine.port.now=()=>Date.now()+500;await f.engine.tick();
 for(let i=0;i<6;i++){assert.equal(f.jobs.get('photo'+i+'.enhance-1.r1').state,'ACCEPTED');await f.finish('photo'+i+'.enhance-1.r1');}await f.engine.tick();
 for(let i=0;i<6;i++)await f.finish('photo'+i+'.deliver');await f.engine.tick();
 for(let i=0;i<6;i++){assert.equal((await f.sdk('/v2/sdk/jobs/photo'+i)).state,'SUCCEEDED');assert.equal(f.dispatches.filter(s=>s.options.requestId==='photo'+i+'.enhance-0').length,1);}
 assert.ok(f.dispatches.filter(s=>s.options.requestId.endsWith('.r1')).every(s=>s.options.budgetMs<180000));
});

test('queue-starved never-started block retries, but cancelled without restart proof and unknown outcome terminate instead of hanging',async()=>{
 for(const state of ['CANCELLED_SETTLED','YIELDED','CANCELLED','SIDE_EFFECT_UNKNOWN','HOLDER_RECORD_MISSING']){
  const f=setup();await f.submit('terminal');f.jobs.get('terminal.analyze').state=state;await f.engine.tick();await f.engine.tick();assert.equal((await f.sdk('/v2/sdk/jobs/terminal')).state,'FAILED');assert.equal(f.dispatches.length,1);
 }
 for(const reasonCode of ['QUEUE_STARVED_NOT_STARTED','COORDINATOR_OFFLINE','AGENT_NOT_READY','CONTROL_UNAVAILABLE']){
 const f=setup();await f.submit('starved');const j=f.jobs.get('starved.analyze');j.state='REJECTED';j.rejection={record:null,reasonCode};await f.engine.tick();f.engine.port.now=()=>Date.now()+500;await f.engine.tick();assert.equal(f.jobs.get('starved.analyze.r1').state,'ACCEPTED',reasonCode);
 await f.sdk('/v2/sdk/jobs/starved/cancel');await f.engine.tick();assert.equal((await f.sdk('/v2/sdk/jobs/starved')).state,'CANCELLED');assert.equal(f.dispatches.length,2,'user cancellation must never trigger automatic restart');
 }
});

test('original thumbnails become readable individually before any workflow or output exists',async()=>{
 const f=setup(),r=await f.api({route:'/photo-runs',method:'POST',body:{mode:'COOPERATIVE',budgetMs:180000,inputs:[0,1,2].map(i=>({hash:f.input.contentHash,bytes:f.input.bytes,width:1,height:1,name:'p'+i}))}}),url='/runs/'+encodeURIComponent('coop:'+r.id);
 const view=()=>f.engine.display(url,'','','http://localhost:7460','[]').then(JSON.parse);
 assert.deepEqual((await view()).inputs.map(i=>i.url),[null,null,null]);
 await f.api({route:`/photo-runs/${r.id}/input?image=0`,method:'PUT',data:f.bytes.toString('base64')});
 let v=await view();assert.ok(v.inputs[0].url);assert.equal(v.inputs[1].url,null);assert.equal(v.results.length,0);assert.equal(v.workflows.length,0);
 assert.equal(JSON.parse(await f.engine.display(v.inputs[0].url,'','','http://localhost:7460','[]')).data,f.bytes.toString('base64'));
 await f.api({route:`/photo-runs/${r.id}/input?image=1`,method:'PUT',data:f.bytes.toString('base64')});
 v=await view();assert.ok(v.inputs[1].url);assert.equal(v.inputs[2].url,null);assert.equal(f.dispatches.length,0);
 await f.api({route:'/photo-runs/'+r.id,method:'POST',body:{revision:0,state:'RUNNING'}});
});

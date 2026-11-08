const {test}=require('node:test'),assert=require('node:assert/strict'),https=require('node:https'),fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {runtime}=require('./helpers.cjs');
test('dashboard chart scales preserve unknowns, real zero, over-capacity and independent clocks',async()=>{
 const {capacity,clockLanes,costScale,networkLevels}=await import('../../../apps/team-space-web/dispatch-charts.mjs');
 assert.equal(capacity(null,8),null);assert.equal(capacity(0,0),null);assert.equal(capacity(-1,8),null);
 assert.deepEqual(capacity(0,8),{percent:0,fill:0,exceeded:false});
 assert.deepEqual(capacity(3,2),{percent:150,fill:100,exceeded:true});
 assert.deepEqual(costScale([null,20]),[null,100]);assert.deepEqual(costScale([0,0]),[0,0]);
 assert.deepEqual(costScale([10,20]),[50,100]);assert.deepEqual(costScale([-1,NaN]),[null,null]);
 const lanes=clockLanes([
  {spanId:'later',clockDomainId:'a',startMono:130,durationMs:10},
  {spanId:'first',clockDomainId:'a',startMono:100,durationMs:20},
  {spanId:'other-clock',clockDomainId:'b',startMono:999999,durationMs:5},
  {spanId:'point',clockDomainId:'z',startMono:50,durationMs:0}
 ]);
 assert.equal(lanes[0].extent,40);assert.deepEqual(lanes[0].rows.map(r=>[r.offset,r.left,r.width]),[[0,0,50],[30,75,25]]);
 assert.equal(lanes[1].extent,5);assert.deepEqual([lanes[1].rows[0].offset,lanes[1].rows[0].left,lanes[1].rows[0].width],[0,0,100]);
 assert.equal(lanes[2].extent,0);assert.equal(lanes[2].rows[0].width,0);
 assert.deepEqual(networkLevels([{level:'L2'},{level:'L0'},{level:'missing'}]),{L0:1,L1:0,L2:1,L3:0,UNKNOWN:1});
 assert.deepEqual(networkLevels([]),{L0:0,L1:0,L2:0,L3:0,UNKNOWN:0});
});
function browser(r){let cookie='';return async(route,body)=>new Promise((resolve,reject)=>{const data=body===undefined?null:Buffer.from(JSON.stringify(body));const request=https.request(r.url+route,{ca:r.identity.cert,method:data?'POST':'GET',headers:{Cookie:cookie,...(data?{'Content-Type':'application/json'}:{})}},response=>{if(response.headers['set-cookie'])cookie=response.headers['set-cookie'][0].split(';')[0];let text='';response.on('data',b=>text+=b);response.on('end',()=>{let body;try{body=JSON.parse(text);}catch{body=text;}resolve({status:response.statusCode,body,headers:response.headers});});});request.setTimeout(10000,()=>request.destroy(Error('HTTP_TIMEOUT')));request.on('error',reject);request.end(data);});}
test('read-only dashboard uses scoped persisted evidence, keeps UNKNOWN and trace readers, and never registers or dispatches',async()=>{
 const r=await runtime({}, {COORDINATOR_WEB_DIR:path.resolve('../../apps/team-space-web')}),owner=browser(r),viewer=browser(r),outsider=browser(r);
 try{
  assert.equal((await owner('/v2/spaces/missing/telemetry')).status,401);
  const user=(await owner('/v2/spaces/register',{account:randomUUID(),password:'test-password',name:'Owner'})).body.user;
  const group=(await owner('/v2/spaces/',{name:'Readonly telemetry'})).body.id;
  await outsider('/v2/spaces/register',{account:randomUUID(),password:'test-password',name:'Other'});const outsiderGroup=(await outsider('/v2/spaces/',{name:'Other group'})).body.id;
  await viewer('/v2/spaces/register',{account:randomUUID(),password:'test-password',name:'Viewer'});
  const invitation=await owner('/v2/spaces/'+group+'/invites',{role:'VIEWER'});await viewer('/v2/spaces/join',{code:invitation.body.code});
  const profile=JSON.parse(fs.readFileSync('../../contracts/scheduling/v2/fixtures/t2/valid/DeviceProfile.json'));
  const now=Date.now();profile.battery.value=null;profile.battery.source='UNKNOWN';
  for(const sample of [profile.ownerActivity,profile.foreground,profile.charging,profile.powerSave,profile.battery,profile.temperature,...profile.pools.flatMap(p=>[p.total,p.admissionLimit,p.occupied,p.drainMs]),...profile.executors.flatMap(e=>[e.compute,e.queue,e.cold,e.publish,e.uncertainty]),...profile.links.flatMap(l=>[l.fixedMs,l.bytesPerSecond])]){sample.sampledAt=now;sample.ttlMs=30000;}
  const peer={groupId:group,principalId:user.id,deviceId:profile.deviceId,holderInstanceId:profile.holderInstanceId,credentialId:'fixture-credential'};
  await r.directory.ingest(peer,profile);
  const appInvite=await r.apps.register(peer,{label:'Registered shopping app',allowedContracts:['text.count.v1'],maxConcurrent:1,resources:[{resourcePoolId:'cpu',amount:1}],offlineBase:[],onlineExtra:[],declaration:{version:1,revision:'test.1',workflows:[{id:'count',capabilities:['text.count.v1']}]}},r.url);
  const job=randomUUID(),traceId=randomUUID(),offer={task:{groupId:group,workflowId:job,nodeId:'compute',attemptId:job,app:{principalId:user.id},originDeviceId:'source-device',contract:{capability:'text.count.v1'},parameters:'PRIVATE_INPUT_NEVER_RETURN'},target:{targetId:'target1',deviceId:'device1'},reasonCode:'PERSISTED_DECISION',transferPlan:[]};
  await r.db.cpuJob.create({data:{id:job,groupId:group,principalId:user.id,sourceHolderId:'source-holder',state:'WAITING_INPUT',metadataJson:JSON.stringify({offer,holderId:'h1',traceId,request:{now},plan:{snapshotVersion:7,policyVersion:'test-policy',decision:{status:'ready',reason:'PERSISTED_DECISION',baselineMs:12,suggestionMs:8,baseline:[],suggestion:[],rejections:[],planningMs:1}}})}});
  await r.traces.control(offer,traceId,7,'PLAN',10,15);
  for(const scope of [group,outsiderGroup])await r.db.allotment.create({data:{id:JSON.stringify(['allotment',scope,'h1']),groupId:scope,revision:3,metadataJson:JSON.stringify({grant:{groupId:scope,deviceId:'device1',holderInstanceId:'h1',appInstanceId:null,version:3,coordinatorEpoch:1,base:[],extra:[],signature:'PRIVATE_GRANT_SIGNATURE'},reserved:[],ack:{version:3,occupied:[],settlementSeq:1}})}});
  await r.db.transferAuthorization.create({data:{id:randomUUID(),groupId:group,attemptId:job,endpointId:'test-endpoint',requesterCredentialId:'PRIVATE_CREDENTIAL',state:'COMPLETED',expiresAt:now+30000,metadataJson:JSON.stringify({authorization:{operation:'WRITE',bytes:32,endpoint:{deviceId:'device1'},requesterHolderId:'source-holder',issuedAt:now,proofHash:'PRIVATE_PROOF'},signature:'PRIVATE_SIGNATURE'})}});
  const foreignJob=randomUUID();await r.db.cpuJob.create({data:{id:foreignJob,groupId:outsiderGroup,principalId:'other-user',sourceHolderId:'other-holder',state:'WAITING_INPUT',metadataJson:JSON.stringify({offer,traceId:'foreign-trace',request:{now}})}});
  const before=await Promise.all([r.db.registeredApp.count(),r.db.consoleApp.count(),r.db.attempt.count(),r.db.outbox.count()]);
  r.planning.plan=()=>assert.fail('dashboard must not plan');r.planning.preflight=()=>assert.fail('dashboard must not dispatch');
  const url='/v2/spaces/'+group+'/telemetry',response=await viewer(url);assert.equal(response.status,200);assert.equal(response.headers['cache-control'],'no-store');
  const data=response.body;assert.equal(data.domain,'SIMULATED');assert.equal(data.features.readOnly,true);assert.equal(data.jobCount,1);assert.equal(data.devices.length,1);assert.equal(data.devices[0].holders[0].profile.battery.value,null);assert.equal(data.devices[0].holders[0].profile.temperature.value,0);assert.equal(data.devices[0].holders[0].profile.temperature.unit,'level');assert.equal(data.devices[0].allotments.length,1);assert.equal(data.transfers[0].bytes,32);assert.equal(data.jobs[0].plan.baselineMs,12);assert.equal(data.jobs[0].plan.suggestionMs,8);assert.equal(data.jobs[0].resourcesSettled,null);assert.equal(JSON.stringify(data).includes('PRIVATE_'),false);assert.equal(JSON.stringify(data).includes(foreignJob),false);
  assert.equal(data.applications[0].declaration.revision,'test.1');assert.equal(data.applications[0].installations[0].state,'INVITED');assert.equal(JSON.stringify(data).includes(appInvite.code),false);assert.equal(JSON.stringify(data).includes('secretHash'),false);
  assert.equal((await outsider(url)).status,403);assert.equal((await viewer(url+'/traces/'+job)).status,403);assert.equal((await owner(url+'/traces/'+foreignJob)).status,403);
  const trace=await owner(url+'/traces/'+job);assert.equal(trace.status,200);assert.equal(trace.body.spans[0].phase,'PLAN');assert.equal(trace.body.coverage.sourceSdkRoot,false);
  assert.equal((await viewer(url,{})).status,404);
  assert.deepEqual(await Promise.all([r.db.registeredApp.count(),r.db.consoleApp.count(),r.db.attempt.count(),r.db.outbox.count()]),before);
  const stale=structuredClone(profile);stale.sequence++;stale.ownerActivity.sampledAt=now-60000;await r.directory.ingest(peer,stale);assert.equal((await viewer(url)).body.devices[0].holders[0].evidenceFresh,false);
  const page=await viewer('/dispatch.html');assert.equal(page.status,200);assert.match(page.body,/Harmony · 跨设备调度盘/);assert.doesNotMatch(page.body,/定昌|DC_ENP1|45TOPS|1850 RPM|PostgreSQL 16/);
 }finally{await r.close();}
});

test('dashboard formats zero and thermal levels accurately, expires evidence, and withholds incomplete end-to-end conclusions',async()=>{
 const {sample,traceSummary,traceGroups,escapeHtml}=await import('../../../apps/team-space-web/dispatch-view.mjs');
 assert.equal(traceSummary({coverage:{sourceSdkRoot:true,criticalPathPending:true},causality:{complete:true,links:[{}],missing:[]},analysis:{status:'MEASUREMENT_INCOMPLETE',measuredCriticalMs:12,issues:['CROSS_CLOCK_GAP_UNKNOWN']}}).measuredChain,'12.0 ms');
 assert.equal(traceSummary({causality:{links:[{}]},analysis:{measuredCriticalMs:12,issues:['CAUSAL_OVERLAP']}}).measuredChain,'UNKNOWN');
 const evidence={value:0,source:'SIMULATED',sampledAt:100,ttlMs:1000,unit:'level'};
 const grouped=traceGroups([{spanId:'late',clockDomainId:'a',startMono:20},{spanId:'other',clockDomainId:'b',startMono:0},{spanId:'early',clockDomainId:'a',startMono:10}]);assert.deepEqual(grouped.map(g=>g.spans.map(s=>s.spanId)),[['early','late'],['other']]);
 assert.equal(sample(evidence,100).text,'0 级');assert.equal(sample({...evidence,unit:'percent'},100).text,'0%');assert.equal(sample({...evidence,value:null},100).text,'UNKNOWN');assert.equal(sample(evidence,1100).text,'UNKNOWN');assert.equal(sample({...evidence,sampledAt:101},100).text,'UNKNOWN');
 assert.equal(traceSummary({analysis:{status:'MEASUREMENT_INCOMPLETE',endToEndMs:10,criticalPathMs:8,issues:['ROOT_INCOMPLETE']}}).endToEnd,'UNKNOWN');assert.equal(traceSummary({analysis:{status:'COMPLETE',endToEndMs:10,criticalPathMs:8,issues:[]}}).endToEnd,'UNKNOWN');assert.equal(traceSummary({coverage:{sourceSdkRoot:true},analysis:{status:'COMPLETE',endToEndMs:10,criticalPathMs:8,issues:[]}}).endToEnd,'10.0 ms');assert.equal(traceSummary({coverage:{sourceSdkRoot:true,sourceDurationMs:42,criticalPathPending:true},analysis:{status:'COMPLETE',issues:[]}}).endToEnd,'42.0 ms');assert.equal(traceSummary({coverage:{sourceSdkRoot:true,sourceDurationMs:42,criticalPathPending:true},analysis:{status:'COMPLETE',issues:[]}}).critical,'UNKNOWN');assert.equal(escapeHtml('<img onerror="bad">').includes('<img'),false);
 const source=fs.readFileSync('../../apps/team-space-web/dispatch.js','utf8');assert.match(source,/new EventSource/);assert.match(source,/cache:'no-store'/);assert.doesNotMatch(source,/method:\s*['"](?:POST|PUT|DELETE|PATCH)['"]|Math\.random|SchedulerSdk/);
});

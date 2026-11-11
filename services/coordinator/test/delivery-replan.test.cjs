function frontierMock(jobs){jobs.graphProgress=async(peer,ids)=>Promise.all(ids.map(async id=>{const serving=await jobs.winnerFor(peer,id),status=await jobs.status(peer,serving);return {id,serving,state:status.state,output:status.state==='SUCCEEDED'?await jobs.graphOutput(peer,serving):null};}));return jobs;}
const {test}=require('node:test'),assert=require('node:assert/strict');
const {CpuJobs}=require('../dist/cpu-jobs'),{PlanningService}=require('../dist/planning');
function fixture(localOnly=false,arranged=false){
 const now=Date.now(),ref={artifactId:'ref',contentVersion:1,contentHash:'a'.repeat(64),schemaId:'input',schemaVersion:1};
 const request={nodes:[{id:'compute',capability:'cap',dependencies:[],inputs:['ref'],output:{id:'out',bytes:1},baselineTargetId:'target-d',memoryBytes:1,minimumQuality:1,candidates:[]}],artifacts:[{id:'ref',bytes:100,replicas:[{deviceId:'b',holderInstanceId:'b',readMs:0}]}],links:[],deviceResources:[],remainingBudgetMs:10000,networkAllowed:true,privacy:'AUTHORIZED_REMOTE',localDeviceId:'b',domain:'SIMULATED',now,committedNodeIds:[],committedArtifacts:[],inputRelayId:'relay'};
 const data={delivery:{id:'old',senderHolderId:'b',senderEndpointId:'ep-b',senderEpoch:'b1'},sourceAttemptId:'parent',holderId:'c',input:{ref,bytes:100},deadlineAt:now+10000,request,plan:{decision:{suggestion:[{targetId:'target-c',inputEndpointId:'ep-c'}],suggestionMs:20}},offer:{task:{attemptId:'child',groupId:'group',app:{appInstanceId:'app'}},target:{deviceId:'c',targetId:'target-c'}}};
 let stored=structuredClone(data),revoked=0;
 const db={sdkWorkflowJob:{findUnique:async()=>null},transferAuthorization:{count:async()=>0,updateMany:async()=>{revoked++;}},attempt:{findUnique:async()=>arranged===true?{}:null},outbox:{count:async()=>arranged==='outbox'?1:0},cpuJob:{updateMany:async({where,data})=>{if(where.metadataJson!==JSON.stringify(stored))return {count:0};stored=JSON.parse(data.metadataJson);return {count:1};}}};db.$transaction=run=>run(db);
 const candidate={targetId:'target-d',deviceId:'d',holderInstanceId:'d',resourcePoolIds:['shared'],executorId:'exec',capability:'cap',trusted:true,source:'SIMULATED',observedAt:now,ttlMs:30000,availableSlots:1,availableMemoryBytes:100,quality:1,computeMs:1,queueMs:0,coldMs:0,publishMs:0,uncertaintyMs:0};
 const snapshot={groupId:'group',domain:'SIMULATED',version:1,policyVersion:'p',capturedAt:now,devices:[{deviceId:'d',holderInstanceId:'d',deviceInstanceId:'d1',ledgerEpoch:1,sampledAt:now,ttlMs:30000}],resources:[{deviceId:'d',resourcePoolId:'shared',availableSlots:1,availableMemoryBytes:100,observedAt:now,ttlMs:30000}],candidates:[candidate],links:[{from:'c',to:'d',fromHolderInstanceId:'c',toHolderInstanceId:'d',endpointId:'ep-d',endpointEpoch:'d1',endpointOperation:'WRITE',bytesPerSecond:10000,fixedMs:1,effective:false,source:'SIMULATED',observedAt:now,ttlMs:30000}]};
 const policy={version:'p',revoked:false,allowedTargetIds:['target-d'],limits:{maxCandidates:8,lookahead:16,beamWidth:8,planningBudgetMs:20,switchCostMs:0,hysteresisMs:0}};
 const jobs=Object.create(CpuJobs.prototype);Object.assign(jobs,{db,store:{senderInstanceId:'relay'},artifacts:{available:()=>false},directTransfers:{relaySlots:()=>4,relayConfirmed:async()=>false,sourceProblem:async()=>null,inputCopies:async()=>[{deviceId:'c',holderInstanceId:'c',endpointId:'ep-c',endpointEpoch:'c1',readMs:0,transferOperation:'WRITE',localOnly}]}});
 const planner=new PlanningService({});jobs.choose=async(_peer,request)=>{const decision=planner.plan(snapshot,request,policy,{now:Date.now(),monotonic:()=>0});if(!decision.decision.suggestion)throw Error('NO_LEGAL_PLAN');return {decision,profile:{holderInstanceId:'d',sequence:1,ownerActivity:{sampledAt:now}},executor:{target:{deviceId:'d',targetId:'target-d'},resources:[],configurations:[]},grant:{allotmentId:'grant',version:1},planTiming:{start:0,end:0}};};
 return {jobs,data,stored:()=>stored,revoked:()=>revoked};
}
test('input preparation re-plans C copy to D through PlanningService and preserves committed B lineage',async()=>{
 const f=fixture();await f.jobs.prepareDelivery({groupId:'group'},'child',f.data);
 const d=f.stored();assert.equal(d.holderId,'d');assert.equal(d.delivery.senderHolderId,'c');assert.equal(d.delivery.senderEndpointId,'ep-c');assert.notEqual(d.delivery.id,'old');assert.equal(d.sourceAttemptId,'parent');assert.deepEqual(d.input.ref,f.data.input.ref);assert.equal(d.deadlineAt,f.data.deadlineAt);assert.equal(f.revoked(),1);
});
test('a prepared relay download keeps the confirmed upload identity and its remaining-budget evidence',async()=>{
 const f=fixture();f.data.delivery.relay=true;
 f.jobs.artifacts.available=()=>true;
 f.jobs.directTransfers.relayConfirmed=async(id,deliveryId)=>id==='child'&&deliveryId==='old';
 f.jobs.choose=async()=>assert.fail('a completed upload must not be prepared again');
 await f.jobs.prepareDelivery({groupId:'group'},'child',f.data);
 assert.equal(f.data.delivery.id,'old');assert.equal(f.revoked(),0);
});
test('local-only copy and inadequate budget cannot dispatch; an existing attempt blocks preparation mutations',async()=>{
 const local=fixture(true);await assert.rejects(local.jobs.prepareDelivery({groupId:'group'},'child',local.data),/NO_LEGAL_PLAN/);assert.equal(local.stored().delivery.id,'old');
 const budget=fixture();budget.data.deadlineAt=Date.now()+1;await assert.rejects(budget.jobs.prepareDelivery({groupId:'group'},'child',budget.data),/ARTIFACT_UNAVAILABLE|NO_LEGAL_PLAN/);
 for(const existing of [true,'outbox']){const arranged=fixture(false,existing);arranged.jobs.choose=async()=>{throw Error('SHOULD_NOT_REPLAN');};arranged.jobs.directTransfers.sourceProblem=async()=>{throw Error('SHOULD_NOT_INSPECT_SOURCE');};await arranged.jobs.prepareDelivery({groupId:'group'},'child',arranged.data);assert.equal(arranged.stored().holderId,'c');assert.equal(arranged.revoked(),0);}
 const raced=fixture();let dispatched=false;raced.jobs.db.attempt.findUnique=async()=>dispatched?{}:null;raced.jobs.choose=async()=>{dispatched=true;throw Error('NO_LEGAL_PLAN');};await raced.jobs.prepareDelivery({groupId:'group'},'child',raced.data);assert.equal(raced.stored().holderId,'c');
 const busy=fixture();busy.jobs.directTransfers.relayBytes=()=>0;busy.jobs.choose=async()=>{throw Error('NO_AVAILABLE_TARGET');};await assert.rejects(busy.jobs.prepareDelivery({groupId:'group'},'child',busy.data),/NO_AVAILABLE_TARGET/);
});

test('confirmed source loss ends the graph with a distinguishable failure and cancels pending children without replaying the parent',async()=>{
 const {WorkflowJobs}=require('../dist/workflow-jobs');let state='ACTIVE',saved,cancelled=0,starts=0;
 const data={peer:{groupId:'g'},deadlineAt:Date.now()+10000,workflow:{nodes:[{id:'b',dependsOn:[]},{id:'c',inputFrom:'b',dependsOn:['b']}]},nodes:[{id:'b',jobId:'parent',state:'COMMITTED',output:{ref:{artifactId:'r'}}},{id:'c',jobId:'child',state:'SUBMITTED'}]};
 const db={cpuJob:{findMany:async()=>[{id:'child'}]},sdkWorkflowJob:{findUniqueOrThrow:async()=>({state}),updateMany:async({where,data:d})=>{if(state!==where.state)return {count:0};state=d.state;if(d.metadataJson)saved=JSON.parse(d.metadataJson);return {count:1};},update:async({data:d})=>{state=d.state??state;if(d.metadataJson)saved=JSON.parse(d.metadataJson);}}};
 const jobs={winnerFor:async(_peer,id)=>id,status:async()=>({state:'WAITING_INPUT'}),graphOutput:async()=>null,graphInput:async()=>{throw Error('ARTIFACT_UNAVAILABLE:CONFIRMED_MISSING');},start:async()=>{starts++;},cancel:async()=>{cancelled++;return {state:'CANCELLED'};}};
 const graphs=new WorkflowJobs(db,frontierMock(jobs),{context:async()=>({})},{},[]);await graphs.progress('g',data);assert.equal(state,'FAILED');assert.equal(saved.failure.code,'ARTIFACT_UNAVAILABLE');assert.equal(saved.failure.reason,'CONFIRMED_MISSING');assert.equal(cancelled,1);assert.equal(starts,0);assert.equal(saved.nodes[0].jobId,'parent');
});

test('fixed producer publication uses the shared planner cost, refuses missing paths and respects remaining budget',()=>{
 const planner=new PlanningService({}),now=1000,artifact={id:'out',bytes:100,replicas:[{deviceId:'b',readMs:0}]};
 const snapshot={domain:'SIMULATED',policyVersion:'p',links:[{from:'b',to:'relay',bytesPerSecond:1000,fixedMs:2,effective:false,source:'SIMULATED',observedAt:now,ttlMs:100}]},request={domain:'SIMULATED',networkAllowed:true,privacy:'AUTHORIZED_REMOTE',remainingBudgetMs:200},policy={version:'p',revoked:false,limits:{maxCandidates:8,lookahead:16,beamWidth:8,planningBudgetMs:20,switchCostMs:0,hysteresisMs:0}};
 assert.equal(planner.publication(snapshot,request,artifact,'relay',policy,{now,monotonic:()=>0}),102);
 assert.throws(()=>planner.publication(snapshot,{...request,remainingBudgetMs:101},artifact,'relay',policy,{now,monotonic:()=>0}),/BUDGET_EXHAUSTED/);
 assert.throws(()=>planner.publication(snapshot,request,artifact,'relay',policy,{now:2000,monotonic:()=>0}),/PUBLICATION_PATH_UNAVAILABLE/);
 assert.throws(()=>planner.publication(snapshot,{...request,relayCapacity:{deviceId:'relay',availableBytes:99}},artifact,'relay',policy,{now,monotonic:()=>0}),/ARTIFACT_CACHE_FULL/);
});

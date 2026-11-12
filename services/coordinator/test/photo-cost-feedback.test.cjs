const {test}=require('node:test'),assert=require('node:assert/strict');
const {computeHistories}=require('../dist/performance-feedback');
const {PlanningService}=require('../dist/planning');
const key=JSON.stringify(['g','gpu','target']),workKey=JSON.stringify(['neural',2,{model:'pixels',values:{pixels:12544},scale:{parameter:'pixels',reference:12544}},null]);

async function feedback(values,{work=workKey,identity='engine',generation=1,committed=true}={}){
 const samples=values.map((ms,i)=>({id:String(i),ms,workKey:work,configId:'photo-4x',observedAt:10+i}));
 const tx={costObservation:{findMany:async()=>[{id:'execute:'+key,metadataJson:JSON.stringify({identity,generation,samples})}]},
  calibrationJob:{findMany:async()=>[{id:key,metadataJson:JSON.stringify({identity:'engine',generation:1})}]},
  receipt:{findMany:async()=>committed?samples.map(s=>({id:s.id,overheadMs:null,startup:'UNKNOWN'})):[]}};
 return (await computeHistories(tx,'g',new Map([[key,'engine']]),100)).get(key)??[];
}

test('scaled inference learns warm performance without ignoring a new slowdown',async()=>{
 const cold=[1650,1570,1557],warm=[160,150,170,140,160,150];
 const [initial]=await feedback(cold);assert.ok(initial.p90Ms>=1557);
 const [steady]=await feedback([...cold,...warm]);assert.equal(steady.count,8);assert.ok(steady.p90Ms<=170);assert.ok(steady.p50Ms>=140);assert.equal(steady.executionTotal,true);
 const [oneSlow]=await feedback([...cold,...warm,3000]);assert.equal(oneSlow.p90Ms,3000,'new slow execution must immediately increase uncertainty');
 const [slow]=await feedback([...cold,...warm,3000,3100]);assert.ok(slow.p50Ms>=3000,'recent CPU contention or GPU pressure must replace stale fast history');
 const [sparse]=await feedback([3000]);assert.equal(sparse.count,1);assert.equal(sparse.p50Ms,3000);
});

test('feedback keeps identity, generation, committed receipts and non-scaled quantiles intact',async()=>{
 assert.deepEqual(await feedback([10,20,30],{identity:'replaced'}),[]);
 assert.deepEqual(await feedback([10,20,30],{generation:2}),[]);
 assert.deepEqual(await feedback([10,20,30],{committed:false}),[]);
 const [ordinary]=await feedback([10,12,11,150,160],{work:'ordinary'});
 assert.deepEqual([ordinary.count,ordinary.p50Ms,ordinary.p90Ms],[5,12,160]);
});

test('adding an idle slow computer does not divert warmed GPU work; genuine queue delays still permit CPU fallback',async()=>{
 const ms=value=>({value,unit:'ms',source:'SIMULATED',sampledAt:100,ttlMs:900}),demand=[{resourcePoolId:'memory',amount:100}];
 const [learned]=await feedback([1650,1570,1557,160,150,170,140,160,150]);
 const make=(id,time)=>({deviceId:id,targetId:id,holderInstanceId:id,executorId:id,capability:'photo.enhance.v1',resourcePoolIds:['memory'],resourceDemand:demand,holderCapacity:demand,projectedSlots:1,
  trusted:true,source:'SIMULATED',observedAt:100,ttlMs:900,availableSlots:1,availableMemoryBytes:100,quality:1,queueMs:0,configId:'photo-4x',startup:'UNKNOWN',
  costEvidence:{compute:ms(5000),cold:ms(0),publish:ms(30)},computeSamples:[{...learned,p50Ms:time,p90Ms:time+50}]});
 const gpu=make('gpu',160);gpu.computeSamples=[learned];
 const snapshot={version:1,policyVersion:'p',groupId:'g',domain:'SIMULATED',capturedAt:100,candidates:[gpu,make('phone',3000)],links:[],
  devices:['gpu','phone','pc'].map(id=>({deviceId:id,holderInstanceId:id,deviceInstanceId:id,ledgerEpoch:1,sampledAt:100,ttlMs:900})),
  resources:['gpu','phone','pc'].map(deviceId=>({deviceId,resourcePoolId:'memory',available:100,availableMemoryBytes:100,availableSlots:1,observedAt:100,ttlMs:900}))};
 const request={nodes:[{id:'tile',capability:'photo.enhance.v1',dependencies:[],inputs:[],output:{id:'out',bytes:10},baselineTargetId:'',memoryBytes:10,minimumQuality:1,workKey,candidates:[]}],artifacts:[],links:[],deviceResources:[],domain:'SIMULATED',remainingBudgetMs:10000,networkAllowed:true,privacy:'AUTHORIZED_REMOTE',localDeviceId:'phone',now:100,committedNodeIds:[],committedArtifacts:[]};
 const policy={version:'p',revoked:false,allowedTargetIds:['gpu','phone','pc'],limits:{maxCandidates:8,lookahead:16,beamWidth:8,planningBudgetMs:100,switchCostMs:0,hysteresisMs:0}};
 const run=()=>new PlanningService(null).plan(snapshot,request,policy,{now:100,monotonic:()=>0}).decision.suggestion[0];
 assert.equal(run().targetId,'gpu');snapshot.candidates.push(make('pc',1382));assert.equal(run().targetId,'gpu');
 // Replay the observed cold-tail distortion: the old equal-weight P90 made the idle PC appear faster.
 gpu.computeSamples=[{...learned,p50Ms:160,p90Ms:1650}];assert.equal(run().targetId,'pc');
 gpu.computeSamples=[learned];snapshot.inFlight=[{deviceId:'gpu',holderInstanceId:'gpu',targetId:'gpu',resources:demand,releaseAt:ms(600),overdue:false}];
 assert.equal(run().targetId,'gpu','500 ms queue plus warm GPU still beats the idle PC');
 snapshot.inFlight[0].releaseAt=ms(5100);assert.equal(run().targetId,'pc','a long GPU queue must not disable useful CPU work');
 snapshot.candidates=snapshot.candidates.filter(c=>c!==gpu);assert.equal(run().targetId,'pc','offline GPU does not block the task');
});

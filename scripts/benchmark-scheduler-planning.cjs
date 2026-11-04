const {performance}=require('node:perf_hooks');
const assert=require('node:assert/strict');
const os=require('node:os');
const {PlanningService}=require('../services/coordinator/dist/planning');

function benchmark(){
 const service=new PlanningService(null),device='bench-device';
 const candidates=Array.from({length:4},(_,i)=>({targetId:'target-'+i,deviceId:device,executorId:'engine-'+i,capability:'benchmark',
  resourcePoolIds:['ram'],trusted:true,source:'SIMULATED',observedAt:100,ttlMs:1000,availableSlots:1,availableMemoryBytes:100,
  quality:1,computeMs:i+1,queueMs:0,coldMs:0,publishMs:0,uncertaintyMs:0}));
 const limits={maxCandidates:8,lookahead:16,beamWidth:8,planningBudgetMs:20,switchCostMs:0,hysteresisMs:0};
 const policy={version:'bench',revoked:false,allowedTargetIds:candidates.map(c=>c.targetId),limits};
 const snapshot={version:1,policyVersion:policy.version,groupId:'bench',domain:'SIMULATED',capturedAt:100,candidates,links:[],
  devices:[{deviceId:device,deviceInstanceId:'instance',ledgerEpoch:1,sampledAt:100,ttlMs:1000}],
  resources:[{deviceId:device,resourcePoolId:'ram',availableMemoryBytes:100,availableSlots:1,observedAt:100,ttlMs:1000}]};
 const results=[];
 for(const count of [1,4,8,16]){
  const nodes=Array.from({length:count},(_,i)=>({id:'n'+i,capability:'benchmark',dependencies:i?['n'+(i-1)]:[],inputs:[i?'out'+(i-1):'input'],
   output:{id:'out'+i,bytes:10},baselineTargetId:candidates[3].targetId,memoryBytes:10,minimumQuality:1,candidates:[]}));
  const request={nodes,artifacts:[{id:'input',bytes:10,replicas:[{deviceId:device,readMs:0}]}],links:[],deviceResources:[],domain:'SIMULATED',
   remainingBudgetMs:1000,networkAllowed:false,privacy:'LOCAL_ONLY',localDeviceId:device,now:100,committedNodeIds:[],committedArtifacts:[],finalDestination:device};
  const durations=[],reasons={};
  for(let i=-10;i<100;i++){
   const start=performance.now();
   const result=service.plan(snapshot,request,policy,{now:100,monotonic:()=>performance.now()}).decision;
   const elapsed=performance.now()-start;
   assert.equal(result.status,'ready');assert.equal(result.suggestion.length,count);
   if(i>=0){durations.push(elapsed);reasons[result.reason]=(reasons[result.reason]??0)+1;}
  }
  durations.sort((a,b)=>a-b);
  results.push({nodes:count,p50Ms:durations[49],p95Ms:durations[94],maxMs:durations[99],reasons,budgetFallbacks:reasons.PLANNING_BUDGET_BASELINE??0});
 }
 return {measuredAt:new Date().toISOString(),node:process.version,cpu:os.cpus()[0].model,domain:'SIMULATED',clock:'performance.now',
  scope:'PlanningService.plan on one local device; four eligible targets per node, linear DAG, includes budget fallback',limits,warmups:10,samplesPerSize:100,results};
}
module.exports={benchmark};
if(require.main===module)console.log(JSON.stringify(benchmark(),null,2));

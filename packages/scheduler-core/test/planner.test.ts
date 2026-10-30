import { WorkflowPlacementPlanner, PlacementCandidate, PlacementRequest, authorizePlacement, PlacementRollout } from '../src/planner';
const limits={maxCandidates:8,lookahead:16,beamWidth:8,planningBudgetMs:20,switchCostMs:5,hysteresisMs:10};
const now=10000;
const candidate=(deviceId:string,computeMs:number):PlacementCandidate=>({targetId:deviceId,resourcePoolIds:['shared'],deviceId,executorId:deviceId,capability:'crop',trusted:true,source:'REAL',
  observedAt:now,ttlMs:3000,availableSlots:1,availableMemoryBytes:100,quality:1,computeMs,queueMs:0,coldMs:0,publishMs:0,uncertaintyMs:0});
function fixture():PlacementRequest{return {domain:'REAL',deviceResources:['cloud','pc'].map(deviceId=>({deviceId,resourcePoolId:'shared',availableMemoryBytes:100,availableSlots:1,observedAt:now,ttlMs:3000})),nodes:[{id:'a',capability:'crop',dependencies:[],inputs:['input'],output:{id:'out-a',bytes:1000},baselineTargetId:'cloud',memoryBytes:10,minimumQuality:1,candidates:[candidate('cloud',100),candidate('pc',1)]},
  {id:'b',capability:'crop',dependencies:['a'],inputs:['out-a'],output:{id:'out-b',bytes:10},baselineTargetId:'cloud',memoryBytes:10,minimumQuality:1,candidates:[candidate('cloud',100),candidate('pc',1)]}],
  artifacts:[{id:'input',bytes:100,replicas:[{deviceId:'cloud',readMs:0}]}],links:[{from:'cloud',to:'pc',bytesPerSecond:1000,fixedMs:0,effective:true,source:'REAL',observedAt:now,ttlMs:3000},
    {from:'pc',to:'cloud',bytesPerSecond:100,fixedMs:0,effective:true,source:'REAL',observedAt:now,ttlMs:3000}],remainingBudgetMs:1000,networkAllowed:true,privacy:'AUTHORIZED_REMOTE',localDeviceId:'cloud',now,committedNodeIds:[],committedArtifacts:[],finalDestination:'cloud'};}
describe('bounded data-location planner',()=>{
  it('charges intermediate downloads and reuploads for coordinator-relayed execution',()=>{
    const request=fixture();request.links[1].bytesPerSecond=1000;
    const planner=new WorkflowPlacementPlanner(limits,()=>0);
    expect(planner.plan(request).suggestion?.map(a=>a.deviceId)).toEqual(['pc','pc']);
    request.materializeOutputsAt='cloud';
    expect(planner.plan(request).suggestion?.map(a=>a.deviceId)).toEqual(['cloud','cloud']);
    // Force a remote baseline so the exact relay charge can be inspected.
    request.nodes.forEach(n=>n.baselineTargetId='pc');request.remainingBudgetMs=5000;
    expect(planner.plan(request).baselineMs).toBe(2112); // 100 + 1 + 1000 + 1000 + 1 + 10.
  });
  it('compares downstream transfer and uses separate return direction',()=>{
    const request=fixture(),result=new WorkflowPlacementPlanner(limits,()=>0).plan(request);
    // pc a+b: 100 upload +2 compute +100 final download =202; baseline=200.
    expect(result.suggestion?.map(a=>a.deviceId)).toEqual(['cloud','cloud']);expect(result.baselineMs).toBe(200);
    request.links[1].bytesPerSecond=1000;
    expect(new WorkflowPlacementPlanner(limits,()=>0).plan(request).suggestion?.map(a=>a.deviceId)).toEqual(['pc','pc']);
  });
  it('uses legal alternatives when baseline is unavailable and otherwise blocks',()=>{
    const request=fixture();request.nodes.forEach(n=>n.candidates[0].trusted=false);
    const result=new WorkflowPlacementPlanner(limits,()=>0).plan(request);expect(result.baseline).toBeNull();expect(result.status).toBe('ready');
    request.privacy='LOCAL_ONLY';expect(new WorkflowPlacementPlanner(limits,()=>0).plan(request).status).toBe('blocked');
  });
  it('keeps a committed prefix fixed and rejects stale/unknown observations',()=>{
    const request=fixture();request.committedNodeIds=['a'];request.committedArtifacts=[{id:'out-a',bytes:1000,replicas:[{deviceId:'pc',readMs:0}]}];
    const result=new WorkflowPlacementPlanner(limits,()=>0).plan(request);expect(result.suggestion?.map(a=>a.nodeId)).toEqual(['b']);
    request.nodes[1].candidates[1].computeMs=null;request.nodes[1].candidates[0].observedAt=0;
    expect(new WorkflowPlacementPlanner(limits,()=>0).plan(request).rejections.map(r=>r.code)).toEqual(expect.arrayContaining(['COST_UNKNOWN','OBSERVATION_EXPIRED']));
  });
  it('has deterministic pruning and a bounded fallback',()=>{
    const request=fixture(),planner=new WorkflowPlacementPlanner(limits,()=>0);const first=planner.plan(request);
    request.nodes.forEach(n=>n.candidates.reverse());expect(planner.plan(request).suggestion).toEqual(first.suggestion);
    let time=0;const limited=new WorkflowPlacementPlanner({maxCandidates:8,lookahead:16,beamWidth:4,planningBudgetMs:1,switchCostMs:0,hysteresisMs:0},()=>time++);
    expect(limited.plan(request).reason).toBe('PLANNING_BUDGET_BASELINE');
  });
  it('does not dispatch shadow suggestions and respects independent rollout gates',()=>{
    const request=fixture();request.links[1].bytesPerSecond=1000;const decision=new WorkflowPlacementPlanner(limits,()=>0).plan(request);
    const config:PlacementRollout={mode:'SHADOW',policyVersion:'p1',expiresAt:now+1,killSwitch:false,allowedDevices:['cloud','pc'],allowedCapabilities:['crop'],sampleCount:30,minimumSamples:30,
      qualityPassed:true,nonInferiorityPassed:true,failureRate:0,maximumFailureRate:.05,cohortAllowed:true};
    expect(authorizePlacement(decision,config,'crop',now)).toEqual(decision.baseline);
    config.mode='CANARY';expect(authorizePlacement(decision,config,'crop',now)).toEqual(decision.suggestion);
    config.killSwitch=true;expect(authorizePlacement(decision,config,'crop',now)).toEqual(decision.baseline);
  });
});

describe('application-independent placement requirements',()=>{
  it('uses one shared device pool for two independently identified targets',()=>{
    const r=fixture();r.links[1].bytesPerSecond=1000;
    r.nodes.forEach(n=>{const pc=n.candidates[1];pc.targetId='cpu';n.candidates.push({...pc,targetId:'accelerator',executorId:'accelerator',computeMs:0,requiredMemoryBytes:80});});
    r.deviceResources.find(p=>p.deviceId==='pc')!.availableMemoryBytes=50;
    const decision=new WorkflowPlacementPlanner(limits,()=>0).plan(r);
    expect(decision.suggestion?.map(a=>a.targetId)).toEqual(['cpu','cpu']);
    expect(decision.rejections.filter(x=>x.targetId==='accelerator').map(x=>x.code)).toEqual(['SHARED_CAPACITY_UNAVAILABLE','SHARED_CAPACITY_UNAVAILABLE']);
    r.deviceResources.find(p=>p.deviceId==='pc')!.availableMemoryBytes=null;
    expect(new WorkflowPlacementPlanner(limits,()=>0).plan(r).suggestion?.map(a=>a.deviceId)).toEqual(['cloud','cloud']);
  });
  it('isolates simulated evidence and rejects duplicate targets',()=>{
    const r=fixture();r.nodes.forEach(n=>n.candidates.forEach(c=>c.source='SIMULATED'));
    expect(new WorkflowPlacementPlanner(limits,()=>0).plan(r).status).toBe('blocked');
    r.domain='SIMULATED';r.links.forEach(l=>l.source='SIMULATED');
    expect(new WorkflowPlacementPlanner(limits,()=>0).plan(r).status).toBe('ready');
    r.nodes[0].candidates.push({...r.nodes[0].candidates[0]});
    expect(new WorkflowPlacementPlanner(limits,()=>0).plan(r).reason).toBe('DUPLICATE_TARGET');
  });
  it('uses executor memory and enforces the application ceiling',()=>{
    const r=fixture();
    r.nodes.forEach(n=>{n.memoryBytes=1000;n.maxMemoryBytes=50;n.candidates.forEach(c=>c.requiredMemoryBytes=20);});
    expect(new WorkflowPlacementPlanner(limits,()=>0).plan(r).status).toBe('ready');
    r.nodes.forEach(n=>n.candidates.forEach(c=>c.requiredMemoryBytes=60));
    expect(new WorkflowPlacementPlanner(limits,()=>0).plan(r).status).toBe('blocked');
  });
  it('compares lower-is-better metrics only with matching evaluation evidence',()=>{
    const r=fixture();
    r.nodes.forEach(n=>{
      n.qualityRequirements=[{metric:'wer',evaluationId:'speech.zh.v1',direction:'lower',value:0.1}];
      n.candidates.forEach(c=>{c.quality=null;c.qualityEvidence=[{metric:'wer',evaluationId:'speech.zh.v1',direction:'lower',value:0.08}];});
    });
    expect(new WorkflowPlacementPlanner(limits,()=>0).plan(r).status).toBe('ready');
    r.nodes.forEach(n=>n.candidates.forEach(c=>c.qualityEvidence![0].evaluationId='other'));
    expect(new WorkflowPlacementPlanner(limits,()=>0).plan(r).status).toBe('blocked');
    r.nodes.forEach(n=>n.candidates.forEach(c=>{c.qualityEvidence![0].evaluationId='speech.zh.v1';c.qualityEvidence![0].value=0.2;}));
    expect(new WorkflowPlacementPlanner(limits,()=>0).plan(r).rejections.some(x=>x.code==='QUALITY_REQUIREMENT_UNMET')).toBe(true);
  });
});

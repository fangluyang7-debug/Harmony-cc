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

describe('direct input routing',()=>{
  it('prices retained intermediate outputs through the producer endpoint',()=>{
    const r=fixture();r.finalDestination=undefined;r.inputRelayId='cloud';r.materializeOutputsAt='cloud';
    r.nodes[0].baselineTargetId='pc';r.nodes[0].allowedTargetIds=['pc'];r.nodes[1].allowedTargetIds=['cloud'];
    for(const node of r.nodes){node.candidates[0].holderInstanceId='source';node.candidates[1].holderInstanceId='worker';node.candidates[1].dataEndpoint={id:'producer',epoch:'epoch'};}
    // PlanningService filters allowedTargetIds before invoking this pure planner.
    r.nodes[0].candidates=r.nodes[0].candidates.filter(c=>c.targetId==='pc');
    r.nodes[1].candidates=r.nodes[1].candidates.filter(c=>c.targetId==='cloud');
    r.links.push({from:'pc',to:'cloud',fromHolderInstanceId:'worker',toHolderInstanceId:'source',endpointId:'producer',endpointEpoch:'epoch',endpointOperation:'READ',bytesPerSecond:100000,fixedMs:0,effective:true,source:'REAL',observedAt:now,ttlMs:3000});
    const planner=new WorkflowPlacementPlanner(limits,()=>0);
    expect(planner.plan(r).status).toBe('blocked'); // Mandatory relay publication exceeds the budget.
    r.nodes[0].output.retainAtExecutor=true;
    const result=planner.plan(r);
    expect(result.suggestionMs).toBe(211);
    expect(result.suggestion?.[0].outputEndpointId).toBe('producer');
    expect(result.suggestion?.[1].inputEndpointOperation).toBe('READ');
    r.nodes[0].candidates[0].dataEndpoint=undefined;
    expect(planner.plan(r).status).toBe('blocked');
  });
  function directFixture(){
    const r=fixture();r.nodes=r.nodes.slice(0,1);r.finalDestination=undefined;
    r.originHolderId='source';r.inputRelayId='relay';
    r.artifacts[0].replicas=[{deviceId:'cloud',holderInstanceId:'source',readMs:0}];
    r.nodes[0].candidates[0].holderInstanceId='source';r.nodes[0].candidates[1].holderInstanceId='worker';
    r.links=[
      {from:'cloud',to:'relay',bytesPerSecond:1000,fixedMs:0,effective:true,source:'REAL',observedAt:now,ttlMs:3000},
      {from:'relay',to:'pc',bytesPerSecond:1000,fixedMs:0,effective:true,source:'REAL',observedAt:now,ttlMs:3000},
      {from:'cloud',to:'pc',bytesPerSecond:100000,fixedMs:0,effective:true,source:'REAL',observedAt:now,ttlMs:3000,endpointId:'ep',endpointEpoch:'epoch',endpointOperation:'WRITE',fromHolderInstanceId:'source',toHolderInstanceId:'worker'}];
    return r;
  }
  it('compares direct, relay and local using the same planner',()=>{
    const r=directFixture(),planner=new WorkflowPlacementPlanner(limits,()=>0);
    expect(planner.plan(r).suggestion?.[0].inputEndpointId).toBe('ep');
    r.links[2].observedAt=0;
    expect(planner.plan(r).suggestion?.[0].deviceId).toBe('cloud');
    r.links[0].bytesPerSecond=r.links[1].bytesPerSecond=100000;
    const selected=planner.plan(r).suggestion?.[0];
    expect(selected?.deviceId).toBe('pc');expect(selected?.inputEndpointId).toBeUndefined();
    expect(selected?.inputTransferMs).toBe(2);
  });
  it('prices a completed relay fallback from its actual replica',()=>{
    const r=directFixture(),planner=new WorkflowPlacementPlanner(limits,()=>0);
    r.artifacts[0].replicas[0].localOnly=true;
    r.artifacts[0].replicas.push({deviceId:'relay',readMs:0});r.links[1].bytesPerSecond=100000;
    const selected=planner.plan(r).suggestion?.[0];
    expect(selected?.deviceId).toBe('pc');expect(selected?.inputEndpointId).toBeUndefined();
    expect(selected?.inputTransferMs).toBe(1);
  });
  it('does not reuse another holder or direction evidence',()=>{
    const r=directFixture();r.links[2].toHolderInstanceId='other';
    expect(new WorkflowPlacementPlanner(limits,()=>0).plan(r).suggestion?.[0].deviceId).toBe('cloud');
    r.links[2].toHolderInstanceId='worker';r.links[2].from='pc';r.links[2].to='cloud';
    expect(new WorkflowPlacementPlanner(limits,()=>0).plan(r).suggestion?.[0].deviceId).toBe('cloud');
  });
  it('does not use a source GET endpoint as the destination of an upload',()=>{
    const r=directFixture();r.links[2].endpointOperation='READ';
    expect(new WorkflowPlacementPlanner(limits,()=>0).plan(r).suggestion?.[0].deviceId).toBe('cloud');
  });
  it('selects source GET evidence for an explicitly pullable committed replica',()=>{
    const r=directFixture();r.artifacts[0].replicas[0].transferOperation='READ';r.links[2].endpointOperation='READ';
    const selected=new WorkflowPlacementPlanner(limits,()=>0).plan(r).suggestion?.[0];
    expect(selected?.deviceId).toBe('pc');expect(selected?.inputEndpointOperation).toBe('READ');
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


describe('D4 DAG critical path and shared resource calendar',()=>{
  function branches(slots:number):PlacementRequest {
    const r=fixture();r.finalDestination=undefined;r.links=[];r.artifacts[0].replicas=[{deviceId:'pc',readMs:0}];
    r.deviceResources=[{deviceId:'pc',resourcePoolId:'shared',availableMemoryBytes:100,availableSlots:slots,observedAt:now,ttlMs:3000}];
    r.nodes=['a','b','join'].map((id,i)=>({id,capability:'crop',dependencies:i===2?['a','b']:[],inputs:i===2?['out-a','out-b']:['input'],output:{id:'out-'+id,bytes:10},baselineTargetId:id,memoryBytes:10,minimumQuality:1,candidates:[{...candidate('pc',i===2?20:100),targetId:id}]}));return r;
  }
  it('estimates independent branches by critical path rather than their sum',()=>{
    const result=new WorkflowPlacementPlanner(limits,()=>0).plan(branches(2));
    expect(result.suggestionMs).toBe(120);expect(result.suggestion?.map(a=>a.startMs)).toEqual([0,0,100]);
  });
  it('serializes branches when their shared device pool has one slot',()=>{
    const result=new WorkflowPlacementPlanner(limits,()=>0).plan(branches(1));
    expect(result.suggestionMs).toBe(220);expect(result.suggestion?.map(a=>a.startMs)).toEqual([0,100,200]);
  });
  it('shares RAM across distinct CPU/GPU targets and refuses an impossible deadline',()=>{
    const r=branches(2);r.nodes.forEach(n=>n.candidates.forEach(c=>c.requiredMemoryBytes=60));r.remainingBudgetMs=150;
    expect(new WorkflowPlacementPlanner(limits,()=>0).plan(r).status).toBe('blocked');
    r.remainingBudgetMs=300;expect(new WorkflowPlacementPlanner(limits,()=>0).plan(r).suggestionMs).toBe(220);
  });
});

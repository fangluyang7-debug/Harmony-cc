import { MacroSchedulerService, DeviceCandidate, TaskGraph } from '../../src/core/runtime/macro-scheduler.service';
import { DEFAULT_SELECTION_POLICY, selectionPolicy } from '../../src/core/runtime/scheduling-selection-policy';

const graph: TaskGraph = {capability:'image.crop.v1', inputs:[], tasks:[{
  id:'crop', capability:'image.crop.v1', dependencies:[], inputs:[], outputBytes:10, memoryMB:1, minQuality:1
}]};
const context = {budgetMs:5000, networkAllowed:true, privacyLevel:'AUTHORIZED_REMOTE' as const,
  userWaiting:false, importance:0, materializeOutputsAt:'cloud-runtime'};
function device(deviceId:string, meanMs:number):DeviceCandidate {
  return {deviceId, deviceType:deviceId === 'cloud-runtime' ? 'CLOUD' : 'PHONE', executorId:deviceId,
    costScope:'coordinator-roundtrip', capabilities:['image.crop.v1'], trusted:true, observedAt:Date.now(), ttlMs:60000,
    resourceSnapshot:{availableSlots:1,availableMemoryMB:100,queueLength:0},
    history:{quality:1,meanMs,stddevMs:0,sampleCount:5}};
}
describe('device selection comparison policies',()=>{
  const saved = process.env.SCHEDULING_SELECTION_POLICY;
  afterEach(()=>{if(saved === undefined)delete process.env.SCHEDULING_SELECTION_POLICY;else process.env.SCHEDULING_SELECTION_POLICY=saved;});
  it('uses the branch default and rejects misspelled overrides',()=>{
    delete process.env.SCHEDULING_SELECTION_POLICY;
    expect(selectionPolicy()).toBe(DEFAULT_SELECTION_POLICY);
    process.env.SCHEDULING_SELECTION_POLICY='typo';
    expect(selectionPolicy).toThrow('SCHEDULING_SELECTION_POLICY_INVALID');
  });
  it('cloud baseline keeps cloud for a 5ms gain, peers choose the faster phone',async()=>{
    const candidates=[device('cloud-runtime',100),device('phone',95)];
    process.env.SCHEDULING_SELECTION_POLICY='CLOUD_BASELINE';
    expect((await new MacroSchedulerService().schedule(graph,candidates,context)).deviceId).toBe('cloud-runtime');
    process.env.SCHEDULING_SELECTION_POLICY='PEER_FASTEST';
    expect((await new MacroSchedulerService().schedule(graph,candidates,context)).deviceId).toBe('phone');
  });
  it('peers work when the cloud candidate has no capacity',async()=>{
    process.env.SCHEDULING_SELECTION_POLICY='PEER_FASTEST';
    const cloud=device('cloud-runtime',100);cloud.resourceSnapshot.availableSlots=0;
    const decision=await new MacroSchedulerService().schedule(graph,[cloud,device('phone',110)],context);
    expect(decision.deviceId).toBe('phone');
    expect(decision.baselineAssignments).toEqual([]);
    expect(decision.baseline.estimatedMs).toBeNull();
  });
  it('explicit background calibration can choose a slower phone',async()=>{
    process.env.SCHEDULING_SELECTION_POLICY='BACKGROUND_CALIBRATION';
    const candidates=[device('cloud-runtime',100),device('phone',1000)];
    expect((await new MacroSchedulerService().schedule(graph,candidates,context)).deviceId).toBe('cloud-runtime');
    const decision=await new MacroSchedulerService().schedule(graph,candidates,{...context,calibrationDeviceId:'phone'});
    expect(decision.deviceId).toBe('phone');expect(decision.reason).toBe('BACKGROUND_CALIBRATION');
    await expect(new MacroSchedulerService().schedule(graph,candidates,{...context,userWaiting:true,calibrationDeviceId:'phone'}))
      .rejects.toThrow('CALIBRATION_REQUIRES_BACKGROUND_POLICY');
  });
  it('calibration still rejects forbidden transfer, unknown quality and insufficient budget',async()=>{
    process.env.SCHEDULING_SELECTION_POLICY='BACKGROUND_CALIBRATION';
    const candidates=[device('cloud-runtime',100),device('phone',1000)];
    await expect(new MacroSchedulerService().schedule(graph,candidates,{...context,calibrationDeviceId:'phone',networkAllowed:false}))
      .rejects.toThrow('CALIBRATION_TARGET_NOT_FEASIBLE');
    await expect(new MacroSchedulerService().schedule(graph,candidates,{...context,calibrationDeviceId:'phone',budgetMs:500}))
      .rejects.toThrow('CALIBRATION_TARGET_NOT_FEASIBLE');
    candidates[1].history=undefined;
    await expect(new MacroSchedulerService().schedule(graph,candidates,{...context,calibrationDeviceId:'phone'}))
      .rejects.toThrow('CALIBRATION_TARGET_NOT_FEASIBLE');
  });
  it('ordinary Worker needs measured links even under peer selection',async()=>{
    process.env.SCHEDULING_SELECTION_POLICY='PEER_FASTEST';
    const worker=device('worker',1);worker.costScope='execution';
    expect((await new MacroSchedulerService().schedule(graph,[device('cloud-runtime',100),worker],context)).deviceId).toBe('cloud-runtime');
  });
});

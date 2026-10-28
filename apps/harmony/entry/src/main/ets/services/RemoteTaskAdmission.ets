import { Backend, CancellationSignal, DuplicatePolicy, ExecutionPlan, ExecutorResult, InferenceLocation,
  Interruptibility, ModelTier, PrivacyPolicy, SchedulerClient, SchedulerRuntime, TaskTemplate, TaskType,
  WorkloadExecutor, WorkflowHandle } from 'scheduler';

export interface MacroTaskContext { baselineDevice: string; selectedReason: string; urgency: boolean; budgetMs: number; }
export const REMOTE_CROP_EXECUTOR_VERSION: string = 'imagekit-crop-v2';

interface Operation { run: () => Promise<string>; }

class RemoteOperationExecutor implements WorkloadExecutor<Operation, string> {
  readonly capability: string = 'image.crop.v1';
  readonly inferenceLocation: InferenceLocation = InferenceLocation.LOCAL_DEVICE;
  supports(plan: ExecutionPlan): boolean {
    return plan.inferenceLocation === InferenceLocation.LOCAL_DEVICE && plan.backend === Backend.CPU;
  }
  async execute(input: Operation, _plan: ExecutionPlan, signal: CancellationSignal): Promise<ExecutorResult<string>> {
    if (signal.isCancellationRequested) { throw new Error('REMOTE_TASK_CANCELLED'); }
    const output = await input.run();
    // ImageKit is non-preemptive; wait for settlement before acknowledging cancellation.
    if (signal.isCancellationRequested) { throw new Error('REMOTE_TASK_CANCELLED'); }
    return {output:output};
  }
  async dispose(): Promise<void> {}
}

export class RemoteTaskAdmission {
  readonly executorVersion: string = REMOTE_CROP_EXECUTOR_VERSION;
  private readonly client: SchedulerClient;
  constructor(runtime: SchedulerRuntime) {
    this.client = new SchedulerClient(runtime);
    const template: TaskTemplate = {capability:'image.crop.v1',taskType:TaskType.USER_INITIATED,
      inferenceLocation:InferenceLocation.LOCAL_DEVICE,privacyPolicy:PrivacyPolicy.REMOTE_ALLOWED,
      interruptibility:Interruptibility.NON_INTERRUPTIBLE,duplicatePolicy:DuplicatePolicy.KEEP_ALL,timeoutMs:25000,
      resourceHints:{modelVersion:REMOTE_CROP_EXECUTOR_VERSION,expectedMemoryMb:128},
      qualityLevels:[{id:'imagekit',modelTier:ModelTier.HIGH_ACCURACY,estimatedLatencyMs:1000,estimatedMemoryMb:128,
        relativeEnergyCost:1,supportedBackends:[Backend.CPU],supportedThreadCounts:[1]}]};
    this.client.registerTemplate(template);
    this.client.registerExecutor(new RemoteOperationExecutor());
  }
  submit(run:()=>Promise<string>,context?:MacroTaskContext):WorkflowHandle<string> {
    const budget=context?.budgetMs??25000;
    if (!Number.isFinite(budget) || budget<=0) { throw new Error('REMOTE_TASK_BUDGET_EXHAUSTED'); }
    return this.client.submit<Operation,string>('image.crop.v1',{run:run},{userVisible:false,
      userWaiting:context?.urgency===true,accuracyFloor:ModelTier.HIGH_ACCURACY,networkAllowed:true,
      deadlineMs:Math.min(25000,budget)});
  }
  async dispose():Promise<void> { await this.client.dispose(); }
}

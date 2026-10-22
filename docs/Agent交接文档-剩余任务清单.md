# 智调鸿枢核心重构 - Agent交接文档

> **2026-10-22 最新验收**：请先阅读 [统一调度链路接入与验收](27-统一调度链路接入与验收-20261022.md)。动态设备目录、资源心跳、配对手机候选接入、端内准入和持久化成本反馈已接通；API 285 项单测与 10 项 HTTP 测试通过。下文保留历史审查背景，其“待修复”条目不能直接当作当前状态。购物整图联合放置、更多硬件执行器和双实机验收仍需继续。


**版本**: v1.0-final  
**创建时间**: 2026-10-22 00:10  
**目标读者**: 后续完成剩余任务的AI Agent / 开发者

---

## 一、已完成的核心工作 ✅

### 1. MacroSchedulerService - 宏观调度器通用化

**文件**: `services/api-server/src/core/runtime/macro-scheduler.service.ts`

**核心突破**:
- ✅ 接收任意任务图 (不限于购物12阶段)
- ✅ 动态候选设备 (不读环境变量)
- ✅ 保留WorkflowPlacementPlanner束搜索算法
- ✅ 输出宏观上下文 (`macroContext`) 传递给微观调度

**接口定义**:
```typescript
interface TaskGraph {
  capability: string;
  tasks: TaskSpec[];  // 动态任务列表
}

interface DeviceCandidate {
  deviceId: string;
  deviceType: 'CLOUD' | 'WORKER' | 'PHONE' | 'EDGE';
  capabilities: string[];
  resourceSnapshot: { availableSlots, availableMemoryMB, queueLength };
  history?: { quality, meanMs, stddevMs, sampleCount };
}

interface SchedulingDecision {
  deviceId: string;
  estimatedMs: number;
  baseline: { deviceId, estimatedMs };
  suggestion: { deviceId, estimatedMs };
  mode: 'BASELINE' | 'OPTIMIZED' | 'FALLBACK';
  
  // 关键: 宏观上下文传递给微观调度
  macroContext: {
    baselineDevice: string;
    selectedReason: string;
    urgency: boolean;
    budgetMs: number;
  };
}
```

**调用示例**:
```typescript
const decision = await macroScheduler.schedule(
  {
    capability: 'image.crop.v1',  // 或任意其他capability
    tasks: [{ 
      id: 'crop', 
      capability: 'image.crop.v1',
      dependencies: [],
      outputBytes: 1024*1024,
      memoryMB: 128,
      minQuality: 1
    }]
  },
  candidates,  // 动态查询的设备列表
  {
    budgetMs: 5000,
    networkAllowed: true,
    privacyLevel: 'AUTHORIZED_REMOTE',
    userWaiting: true,
    importance: 1
  }
);

// 设备知道为什么被选中
console.log(decision.macroContext);
// {
//   baselineDevice: 'cloud-runtime',
//   selectedReason: 'COST_REDUCTION_150ms',
//   urgency: true,
//   budgetMs: 2000
// }
```

### 2. WorkerPolicy - Worker微观调度策略

**文件**: `services/device-worker/worker-policy.mjs`

**核心功能**:
- ✅ 资源准入决策 (`admit`)
- ✅ 执行配置选择 (`selectConfig`)
- ✅ 利用宏观上下文调整策略

**关键逻辑**:
```javascript
// 准入决策
const admission = policy.admit(task, state, macroContext);
// { allowed: true, reason: 'RESOURCE_AVAILABLE', score: 150 }

// 配置选择 - 根据urgency调整
const config = policy.selectConfig(task, state, macroContext);
// 如果 macroContext.urgency === true
// → { threads: 8, priority: 'CRITICAL' }
// 否则
// → { threads: 4, priority: 'NORMAL' }
```

**策略细节**:
1. 硬约束: 槽位/内存/CPU检查
2. 软约束: 队列长度 (优化方案+urgency允许更长队列)
3. 配置选择:
   - `urgency=true` → 提高线程数和优先级
   - `baselineDevice='cloud-runtime'` → 尽力完成优化方案
   - 多任务并发 → 降低单任务线程数
   - CPU压力 → 保守配置

### 3. DeviceDispatchService - 通用派发方法

**文件**: `services/api-server/src/core/runtime/device-dispatch.service.ts`

**新增方法**:
- ✅ `dispatch(graph, context)` - 通用派发入口
- ✅ `queryCandidates(capability)` - 动态查询设备
- 🚧 `executeOnWorker()` - 待实现
- 🚧 `executeOnCloud()` - 待实现

**关键改动**:
```typescript
// 注入MacroScheduler
constructor(
  @Optional() private readonly performanceRegistry?: PerformanceRegistryService,
  @Optional() private readonly macroScheduler?: MacroSchedulerService  // 新增
) {}

// 通用派发
async dispatch(graph: TaskGraph, context: SchedulingContext) {
  const candidates = await this.queryCandidates(graph.capability);
  const decision = await this.macroScheduler.schedule(graph, candidates, context);
  
  if (decision.deviceId === 'cloud-runtime') {
    return this.executeOnCloud(graph, decision.macroContext);
  } else {
    return this.executeOnWorker(decision.deviceId, graph, decision.macroContext);
  }
}
```

### 4. Module注册

**文件**: `services/api-server/src/modules/runtime/runtime.module.ts`

**已注册**:
- ✅ `MacroSchedulerService` 加入 providers
- ✅ 导出供其他模块使用

---

## 二、剩余任务清单 (按优先级)

### P0: 核心功能完善 (必须完成)

#### Task 1: 实现 executeOnWorker
**文件**: `services/api-server/src/core/runtime/device-dispatch.service.ts`

**当前状态**: 抛出 `NOT_IMPLEMENTED` 错误

**需要实现**:
```typescript
private async executeOnWorker(
  deviceId: string, 
  graph: TaskGraph,
  macroContext: any
): Promise<any> {
  const device = this.devices().find(d => d.deviceId === deviceId);
  if (!device) throw new Error('WORKER_NOT_FOUND');
  
  const ownerId = RuntimeWorkScope.ownerId()!;
  const signal = RuntimeWorkScope.signal();
  
  // 1. 上传输入数据
  const inputArtifacts = await this.uploadArtifacts(device, graph.inputs, signal);
  
  // 2. 申请租约
  const lease = await this.call<Receipt>(device, ownerId, 'leases', {
    attemptId: 'attempt_' + randomUUID(),
    memoryBytes: graph.tasks[0].memoryMB * 1024 * 1024,
    remainingBudgetMs: macroContext.budgetMs
  }, signal);
  
  // 3. 提交执行 - 关键: 传递macroContext
  await this.call(device, ownerId, 'execute', {
    leaseId: lease.leaseId,
    fencingToken: lease.fencingToken,
    capability: graph.tasks[0].capability,
    input: inputArtifacts[0],
    parameters: {}, // 根据task获取
    privacy: 'AUTHORIZED_REMOTE',
    networkAllowed: true,
    
    // 新增: 传递宏观上下文给Worker
    macroContext: macroContext
  }, signal);
  
  // 4. 轮询结果
  while (true) {
    const receipt = await this.call<Receipt>(device, ownerId, 'query', {
      leaseId: lease.leaseId
    }, signal);
    
    if (receipt.settled) {
      if (receipt.errorCode) throw new Error(receipt.errorCode);
      
      // 下载输出
      const output = await this.call<Buffer>(
        device, 
        ownerId, 
        'artifacts/resolve', 
        receipt.output.artifact, 
        signal
      );
      
      return { buffer: output, metadata: receipt.output.metadata };
    }
    
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
```

**验收标准**:
- [ ] Worker收到macroContext参数
- [ ] 执行成功返回结果
- [ ] 失败时正确抛出错误

---

#### Task 2: Worker集成WorkerPolicy
**文件**: `services/device-worker/worker.mjs`

**当前状态**: Worker直接执行任务,没有微观调度

**需要修改**:
```javascript
import { WorkerExecutor } from './worker-policy.mjs';

// 初始化
const executor = new WorkerExecutor();

// POST /v1/execute
app.post('/v1/execute', async (req, res) => {
  const { leaseId, fencingToken, capability, input, parameters, macroContext } = req.body;
  
  try {
    // 使用WorkerExecutor执行,传递macroContext
    const result = await executor.execute({
      task: {
        id: leaseId,
        capability,
        input,
        parameters,
        memoryMB: 128,  // 从lease获取
        defaultThreads: 4
      },
      macroContext: macroContext || {}  // 关键!
    });
    
    // 更新lease状态
    updateLease(leaseId, { state: 'SETTLED', output: result });
    
    res.json({ success: true });
  } catch (error) {
    if (error.message.startsWith('ADMISSION_REJECTED')) {
      // 资源不足,拒绝任务
      res.status(503).json({ error: 'CAPACITY_FULL' });
    } else {
      updateLease(leaseId, { state: 'FAILED', errorCode: error.message });
      res.status(500).json({ error: error.message });
    }
  }
});
```

**验收标准**:
- [ ] Worker准入决策生效 (资源不足拒绝任务)
- [ ] urgency=true时提高线程数
- [ ] 执行配置正确应用 (通过日志验证)

---

#### Task 3: 扩展 InferenceLocation 枚举
**文件**: `apps/harmony/scheduler/src/main/ets/api/SchedulerTypes.ets`

**当前状态**:
```typescript
export enum InferenceLocation {
  LOCAL_DEVICE = 'LOCAL_DEVICE',
  REMOTE_CLOUD = 'REMOTE_CLOUD'
}
```

**需要修改**:
```typescript
export enum InferenceLocation {
  LOCAL_DEVICE = 'LOCAL_DEVICE',
  REMOTE_CLOUD = 'REMOTE_CLOUD',
  ADAPTIVE = 'ADAPTIVE'  // 新增: 由调度中枢决定
}
```

**验收标准**:
- [ ] 枚举编译通过
- [ ] SchedulerClient能处理ADAPTIVE值

---

#### Task 4: ShoppingTaskService 改用 ADAPTIVE
**文件**: `apps/harmony/entry/src/main/ets/services/ShoppingTaskService.ets`

**当前状态** (第25行):
```typescript
private readonly template: TaskTemplate = {
  capability: 'shopping.image.search.v1',
  taskType: TaskType.USER_INITIATED,
  inferenceLocation: InferenceLocation.REMOTE_CLOUD,  // ← 写死云端
  allowLocalFallback: false,
  // ...
};
```

**需要修改**:
```typescript
private readonly template: TaskTemplate = {
  capability: 'shopping.image.search.v1',
  taskType: TaskType.USER_INITIATED,
  inferenceLocation: InferenceLocation.ADAPTIVE,  // ← 改为自适应
  allowLocalFallback: true,  // ← 允许降级
  // ...
};
```

**验收标准**:
- [ ] 编译通过
- [ ] 运行时不再固定使用云端
- [ ] 实际执行设备由云端调度决定

---

### P1: 统一派发层

#### Task 5: 创建 UnifiedDispatchService
**新文件**: `services/api-server/src/core/runtime/unified-dispatch.service.ts`

**功能**: 聚合三条路径 (Cloud/Worker/PhoneB) 的统一入口

**实现**:
```typescript
import { Injectable, Logger } from '@nestjs/common';
import { DeviceDispatchService } from './device-dispatch.service';
import { PhoneDispatchService } from '../../modules/runtime/phone-dispatch.service';
import { MacroSchedulerService, TaskGraph, SchedulingContext } from './macro-scheduler.service';

@Injectable()
export class UnifiedDispatchService {
  private readonly logger = new Logger(UnifiedDispatchService.name);
  
  constructor(
    private readonly macroScheduler: MacroSchedulerService,
    private readonly deviceDispatch: DeviceDispatchService,
    private readonly phoneDispatch: PhoneDispatchService
  ) {}
  
  /**
   * 统一派发入口
   */
  async dispatch(
    capability: string,
    context: SchedulingContext,
    graphBuilder?: (capability: string) => TaskGraph
  ): Promise<any> {
    // 1. 构建任务图
    const graph = graphBuilder ? 
      graphBuilder(capability) : 
      this.buildSingleNodeGraph(capability);
    
    // 2. 收集所有候选设备
    const candidates = await this.gatherCandidates(capability);
    
    // 3. 宏观调度
    const decision = await this.macroScheduler.schedule(graph, candidates, context);
    
    this.logger.log(
      `Unified dispatch for ${capability}: ` +
      `selected=${decision.deviceId}, mode=${decision.mode}`
    );
    
    // 4. 派发到目标设备
    if (decision.deviceId === 'cloud-runtime') {
      return this.executeOnCloud(graph, decision.macroContext);
    } else if (decision.deviceId.startsWith('phone-')) {
      return this.phoneDispatch.dispatch(decision.deviceId, {
        graph,
        macroContext: decision.macroContext
      });
    } else {
      return this.deviceDispatch.executeOnWorker(
        decision.deviceId, 
        graph, 
        decision.macroContext
      );
    }
  }
  
  private async gatherCandidates(capability: string) {
    const candidates = [];
    
    // Cloud
    candidates.push({
      deviceId: 'cloud-runtime',
      deviceType: 'CLOUD' as const,
      capabilities: ['*'],
      // ...
    });
    
    // Workers
    const workers = await this.deviceDispatch.queryCandidates(capability);
    candidates.push(...workers);
    
    // Phones
    const phones = await this.phoneDispatch.queryPhones(capability);
    candidates.push(...phones);
    
    return candidates;
  }
  
  private buildSingleNodeGraph(capability: string): TaskGraph {
    return {
      capability,
      inputs: [],
      tasks: [{
        id: 'main',
        capability,
        dependencies: [],
        inputs: [],
        outputBytes: 1024 * 1024,
        memoryMB: 128,
        minQuality: 1
      }]
    };
  }
}
```

**验收标准**:
- [ ] 能同时查询Worker和Phone
- [ ] 宏观调度能选择任意设备
- [ ] 三条路径都能正确派发

---

#### Task 6: PhoneDispatchService 支持 capability 查询
**文件**: `services/api-server/src/modules/runtime/phone-dispatch.service.ts`

**新增方法**:
```typescript
/**
 * 查询当前在线且支持该capability的手机
 */
async queryPhones(capability: string): Promise<DeviceCandidate[]> {
  const onlinePhones = this.getOnlinePhones();
  const candidates: DeviceCandidate[] = [];
  
  for (const phone of onlinePhones) {
    // TODO: 手机需要上报自己支持的capabilities
    // 当前假设所有手机支持shopping相关
    if (this.phoneSupportsCapability(phone, capability)) {
      candidates.push({
        deviceId: phone.deviceId,
        deviceType: 'PHONE',
        executorId: 'phone-runtime',
        capabilities: phone.capabilities || ['shopping.*'],
        trusted: true,
        observedAt: Date.now(),
        ttlMs: 60000,
        resourceSnapshot: {
          availableSlots: 1,
          availableMemoryMB: phone.availableMemoryMB || 512,
          queueLength: 0
        }
      });
    }
  }
  
  return candidates;
}

private phoneSupportsCapability(phone: any, capability: string): boolean {
  // 简化实现: 手机支持shopping和image相关
  return capability.startsWith('shopping') || 
         capability.startsWith('image');
}
```

---

### P2: 动态设备注册

#### Task 7: Worker自注册
**文件**: `services/device-worker/worker.mjs`

**新增逻辑**:
```javascript
// 启动时向云端注册
async function registerSelf() {
  const cloudUrl = process.env.CLOUD_ENDPOINT || 'http://localhost:3001';
  
  try {
    await fetch(cloudUrl + '/api/v1/runtime/workers/register', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.WORKER_TOKEN
      },
      body: JSON.stringify({
        deviceId: process.env.WORKER_ID || 'worker-001',
        capabilities: ['image.crop.v1', 'image.resize.v1'],
        capacity: {
          slots: 2,
          memoryBytes: 4 * 1024 * 1024 * 1024
        },
        networkInfo: {
          uploadMbps: 100,
          downloadMbps: 100,
          rttMs: 10
        }
      })
    });
    
    console.log('[Worker] Registered successfully');
  } catch (error) {
    console.error('[Worker] Registration failed:', error.message);
  }
}

// 启动时立即注册
await registerSelf();

// 定时心跳 (30秒)
setInterval(registerSelf, 30000);
```

---

#### Task 8: Phone状态上报
**新文件**: `apps/harmony/entry/src/main/ets/services/DeviceProfileReporter.ets`

```typescript
export class DeviceProfileReporter {
  private timer: number = -1;
  private readonly cloudUrl: string;
  
  constructor(cloudUrl: string) {
    this.cloudUrl = cloudUrl;
  }
  
  start() {
    this.report(); // 立即上报
    this.timer = setInterval(() => this.report(), 30000);
  }
  
  stop() {
    if (this.timer !== -1) {
      clearInterval(this.timer);
      this.timer = -1;
    }
  }
  
  private async report() {
    const state = globalThis.schedulerRuntime?.getDeviceState();
    if (!state) return;
    
    try {
      await fetch(this.cloudUrl + '/api/v1/runtime/phones/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: 'phone-' + deviceInfo.udid,
          capabilities: this.discoverCapabilities(),
          resourceSnapshot: {
            thermalLevel: state.thermalLevel,
            batteryPercent: state.batteryPercent,
            availableMemoryMb: state.availableMemoryMb,
            availableSlots: state.availableSlots
          }
        })
      });
    } catch (error) {
      console.error('[DeviceProfileReporter] Report failed:', error.message);
    }
  }
  
  private discoverCapabilities(): string[] {
    const caps = ['shopping.image.search.v1'];
    
    // 检查本地是否有模型文件
    if (this.hasLocalEmbeddingModel()) {
      caps.push('image.embedding.v1');
    }
    
    return caps;
  }
  
  private hasLocalEmbeddingModel(): boolean {
    // TODO: 检查模型文件是否存在
    return false;
  }
}
```

**集成到EntryAbility**:
```typescript
// EntryAbility.ets
import { DeviceProfileReporter } from './services/DeviceProfileReporter';

export default class EntryAbility extends UIAbility {
  private reporter?: DeviceProfileReporter;
  
  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam) {
    this.reporter = new DeviceProfileReporter('https://your-cloud-url.com');
    this.reporter.start();
  }
  
  onDestroy() {
    this.reporter?.stop();
  }
}
```

---

### P3: 测试与验证

#### Task 9: 端到端测试
**新文件**: `services/api-server/test/macro-scheduler.e2e.spec.ts`

```typescript
describe('MacroScheduler E2E', () => {
  it('should handle single-node task (image crop)', async () => {
    const graph: TaskGraph = {
      capability: 'image.crop.v1',
      inputs: [],
      tasks: [{
        id: 'crop',
        capability: 'image.crop.v1',
        dependencies: [],
        inputs: [],
        outputBytes: 1024 * 1024,
        memoryMB: 128,
        minQuality: 1,
        estimatedMs: 500
      }]
    };
    
    const candidates = [
      { deviceId: 'cloud-runtime', deviceType: 'CLOUD', ... },
      { deviceId: 'worker-001', deviceType: 'WORKER', ... }
    ];
    
    const decision = await macroScheduler.schedule(graph, candidates, {
      budgetMs: 5000,
      networkAllowed: true,
      privacyLevel: 'AUTHORIZED_REMOTE',
      userWaiting: true,
      importance: 1
    });
    
    expect(decision.deviceId).toBeDefined();
    expect(decision.macroContext).toBeDefined();
    expect(decision.macroContext.urgency).toBe(true);
  });
  
  it('should handle multi-node task (shopping 12 stages)', async () => {
    // 构建12阶段购物图
    const graph = buildShoppingGraph();
    
    const decision = await macroScheduler.schedule(graph, candidates, context);
    
    expect(decision.mode).toBeOneOf(['BASELINE', 'OPTIMIZED', 'FALLBACK']);
  });
  
  it('should fallback to cloud when worker unavailable', async () => {
    const candidates = [
      { deviceId: 'cloud-runtime', ... }
      // 没有Worker
    ];
    
    const decision = await macroScheduler.schedule(graph, candidates, context);
    
    expect(decision.deviceId).toBe('cloud-runtime');
    expect(decision.mode).toBe('BASELINE');
  });
});
```

---

#### Task 10: 集成测试 - 购物流程
**文件**: `services/api-server/src/core/runtime/shopping-runtime.service.ts`

**当前状态**: 直接调用RuntimeRunner,固定云端

**需要改为**:
```typescript
import { UnifiedDispatchService } from './unified-dispatch.service';

@Injectable()
export class ShoppingRuntimeService {
  constructor(
    private readonly unifiedDispatch: UnifiedDispatchService
  ) {}
  
  async executeImageSearch(request: any): Promise<any> {
    // 构建购物12阶段的图
    const graph: TaskGraph = {
      capability: 'shopping.image.search.v1',
      inputs: [request.imageArtifact],
      tasks: [
        { id: 'crop', capability: 'image.crop.v1', dependencies: [], ... },
        { id: 'embedding', capability: 'image.embedding.v1', dependencies: ['crop'], ... },
        { id: 'category', capability: 'shopping.stage.category', dependencies: ['embedding'], ... },
        // ... 12阶段
      ]
    };
    
    // 调用统一派发
    return this.unifiedDispatch.dispatch(
      'shopping.image.search.v1',
      {
        budgetMs: 60000,
        networkAllowed: true,
        privacyLevel: 'AUTHORIZED_REMOTE',
        userWaiting: true,
        importance: 1
      },
      () => graph  // 自定义图构建器
    );
  }
}
```

**验收标准**:
- [ ] Worker可用时优先使用Worker
- [ ] Worker失败时自动降级到Cloud
- [ ] 端到端延迟与原系统持平

---

## 三、架构验收标准

### 解耦验收
- [ ] 新增翻译App可无缝接入 (只声明capability)
- [ ] Phone和Worker地位平等,都经过统一派发
- [ ] 购物App不再写死REMOTE_CLOUD

### 可插拔验收
- [ ] Worker下线,自动降级到Cloud
- [ ] Worker上线,自动加入候选池
- [ ] 新增Edge设备,只需实现descriptor协议即可接入

### 宏微观分离验收
- [ ] 宏观: 云端决策"用哪个设备"
- [ ] 微观: Worker知道urgency,调整线程数
- [ ] Phone: ConstrainedPolicy继续工作,不受影响

### 性能验收
- [ ] 宏观调度决策 < 20ms
- [ ] 微观准入决策 < 5ms
- [ ] 端到端延迟与原系统持平或更优

---

## 四、关键技术细节

### 1. 宏观→微观数据流

**设计原则**: 微观调度需要知道为什么被选中

```typescript
// 宏观调度输出
const decision = await macroScheduler.schedule(...);
decision.macroContext = {
  baselineDevice: 'cloud-runtime',  // 如果是Cloud,说明Worker是优化方案
  selectedReason: 'COST_REDUCTION_150ms',
  urgency: true,  // 用户在等
  budgetMs: 2000
};

// 微观调度利用这些信息
const config = workerPolicy.selectConfig(task, state, decision.macroContext);
if (macroContext.urgency) {
  config.threads *= 1.5;  // 提高线程数
}
if (macroContext.baselineDevice === 'cloud-runtime') {
  config.priority = 'HIGH';  // 尽力完成优化方案
}
```

### 2. 冷启动估算

**问题**: 新设备/新任务没有历史样本

**解决**: 基于设备类型的系数估算
```typescript
coldStartEstimate(device, task) {
  const base = task.estimatedMs ?? 1000;
  const factor = {
    'CLOUD': 1.0,    // 云端最可靠
    'WORKER': 1.2,   // Worker稍慢
    'PHONE': 1.5,    // 手机最慢
    'EDGE': 1.3
  }[device.deviceType] ?? 1.5;
  
  return base * factor;
}
```

### 3. 门禁策略

**问题**: 频繁切换设备导致不稳定

**解决**: 收益<10ms不切换
```typescript
applyGates(decision, context) {
  const improvementMs = baselineMs - suggestionMs;
  
  if (improvementMs < 10) {
    return { 
      deviceId: baseline.deviceId,
      mode: 'BASELINE',
      reason: `IMPROVEMENT_TOO_SMALL_${improvementMs}ms`
    };
  }
  
  return { 
    deviceId: suggestion.deviceId,
    mode: 'OPTIMIZED'
  };
}
```

### 4. 历史样本更新

**策略**: EWMA (指数加权移动平均)
```typescript
recordExecution(deviceId, capability, result) {
  const alpha = 0.25;
  history.meanMs = alpha * result.durationMs + (1 - alpha) * history.meanMs;
  history.stddevMs = alpha * Math.abs(result.durationMs - history.meanMs) + (1 - alpha) * history.stddevMs;
  history.sampleCount++;
}
```

---

## 五、常见问题

### Q1: MacroScheduler和WorkflowPlacementPlanner什么关系?

**A**: 
- `MacroScheduler` 是通用入口,处理capability查询、设备注册等业务逻辑
- `WorkflowPlacementPlanner` 是纯算法,只做束搜索
- MacroScheduler构建输入后调用Planner,再处理输出

### Q2: 为什么不重写WorkflowPlacementPlanner?

**A**: 
- 束搜索算法已验证,论文级别的实现
- 核心问题不是算法本身,而是业务绑定
- 保留算法,解耦业务,是最小化改动

### Q3: Worker如何知道自己支持哪些capability?

**A**: 
- Worker启动时注册自己的capabilities列表
- 例如: `['image.crop.v1', 'image.resize.v1', 'nlp.translation.zh-en']`
- MacroScheduler查询时过滤匹配的Worker

### Q4: 如果Worker拒绝任务怎么办?

**A**: 
- Worker返回503状态码 + `CAPACITY_FULL`错误
- DeviceDispatch捕获后,降级到baseline (通常是Cloud)
- 记录拒绝事件,下次调度时调整评分

### Q5: Phone和Worker地位真的平等吗?

**A**: 
- 是的,从MacroScheduler视角完全平等
- 都是DeviceCandidate,只有deviceType不同
- 调度算法不区分来源,只看capability和成本

---

## 六、下一步建议

### 立即执行 (本周)
1. Task 1-4: 完成P0核心功能
2. Task 9: 编写基础测试

### 第二周
3. Task 5-6: 统一派发层
4. Task 10: 集成购物流程

### 第三周
5. Task 7-8: 动态设备注册
6. 完整端到端验证

---

## 七、参考文档

- **架构方案**: `docs/核心调度算法重构方案-FINAL.md`
- **工作日志**: `.workbuddy-ai/memory/2026-10-22.md`
- **核心文件**:
  - `services/api-server/src/core/runtime/macro-scheduler.service.ts`
  - `services/device-worker/worker-policy.mjs`
  - `services/api-server/src/core/runtime/device-dispatch.service.ts`

---

**联系方式**: 如有问题,参考上述文档或查看代码注释

**最后更新**: 2026-10-22 00:10

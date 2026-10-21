# 智调鸿枢核心调度算法重构方案 - FINAL

## 一、问题诊断 (算法层面)

### 当前算法架构

```
宏观层 (云端): WorkflowPlacementPlanner
  - 束搜索选择设备
  - ❌ 被写死在 DeviceDispatchService.crop() 中
  - ❌ 只处理购物12阶段的固定图
  - ❌ 候选设备静态读取环境变量

微观层 (各设备):
  - Phone: ConstrainedPolicy (完整实现)
  - Worker: 只有LeaseManager (资源准入,无调度)
  - Cloud: RuntimeRunner (只有阶段编排,无调度)
  
❌ 核心问题: 两层算法数据流不通
```

### 算法的真实缺陷

**缺陷1: 宏观算法被业务绑定**
```typescript
// device-dispatch.service.ts:52 - crop方法
async crop(bytes, parameters, local) {
  // 问题1: 方法名写死crop,无法处理其他capability
  // 问题2: 硬编码12阶段购物流程 (line 95-101)
  for (const stage of ['category','product-profile',...]) {
    // 这是购物业务,不是通用调度
  }
}
```

**缺陷2: 宏观选了设备,微观不知道**
```typescript
// 宏观层选择: 
const decision = planner.plan({nodes, candidates});
// → 选中 worker-001

// 但Worker内部不知道为什么被选中:
// - 不知道当前任务的urgency
// - 不知道其他候选设备的情况
// - 无法做本地优化决策
```

**缺陷3: 微观算法覆盖不全**
- Phone: 有ConstrainedPolicy (热状态/电量/内存 → 选择profile)
- Worker: **没有** (直接执行,不管资源压力)
- Cloud: **没有** (固定使用Runtime默认配置)

## 二、核心算法重构

### 重构目标

```
App层: 只声明 capability + context
  ↓
宏观调度器: 通用化,不绑定业务
  - 输入: capability, 候选设备列表, 任务上下文
  - 算法: WorkflowPlacementPlanner (保留,已验证)
  - 输出: 最优设备 + 派发参数
  ↓
微观调度器: 统一实现
  - Phone: ConstrainedPolicy (保留)
  - Worker: WorkerPolicy (新增,简化版ConstrainedPolicy)
  - Cloud: RuntimePolicy (新增,最简配置)
  ↓
执行层: 硬件调用
```

### 算法核心修改

#### 修改1: 宏观调度器通用化

**新文件**: `services/api-server/src/core/runtime/macro-scheduler.service.ts`

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { WorkflowPlacementPlanner, PlacementRequest, PlacementNode, PlacementCandidate } from './workflow-placement-planner';

/**
 * 宏观调度器 - 不依赖具体业务
 */
@Injectable()
export class MacroSchedulerService {
  private readonly logger = new Logger(MacroSchedulerService.name);
  private readonly planner = new WorkflowPlacementPlanner();
  
  /**
   * 核心调度方法 - 通用化
   * 
   * @param graph 任务DAG图 (可以是单节点或多节点)
   * @param candidates 候选设备列表 (动态查询,不写死)
   * @param context 任务上下文
   * @returns 设备分配决策
   */
  async schedule(
    graph: TaskGraph,
    candidates: DeviceCandidate[],
    context: SchedulingContext
  ): Promise<SchedulingDecision> {
    
    // 1. 将业务图转换为Planner的输入格式
    const nodes = this.buildPlacementNodes(graph, candidates);
    const artifacts = this.locateArtifacts(graph.inputs);
    const links = this.buildNetworkTopology(candidates);
    
    // 2. 构建PlacementRequest
    const request: PlacementRequest = {
      nodes,
      artifacts,
      links,
      remainingBudgetMs: context.budgetMs,
      networkAllowed: context.networkAllowed,
      privacy: context.privacyLevel,
      localDeviceId: context.localDeviceId ?? 'cloud-runtime',
      now: Date.now(),
      committedNodeIds: [],
      committedArtifacts: [],
      finalDestination: context.finalDestination ?? 'cloud-runtime'
    };
    
    // 3. 调用束搜索算法
    const decision = this.planner.plan(request);
    
    // 4. 应用门禁策略
    const authorized = this.applyGates(decision, context);
    
    this.logger.log(
      `Scheduled ${graph.capability}: ` +
      `baseline=${decision.baseline?.[0]?.deviceId}, ` +
      `suggestion=${decision.suggestion?.[0]?.deviceId}, ` +
      `actual=${authorized.deviceId}`
    );
    
    return authorized;
  }
  
  /**
   * 构建PlacementNode - 不再写死购物阶段
   */
  private buildPlacementNodes(
    graph: TaskGraph,
    candidates: DeviceCandidate[]
  ): PlacementNode[] {
    const nodes: PlacementNode[] = [];
    
    for (const task of graph.tasks) {
      // 为每个任务筛选支持的候选
      const taskCandidates: PlacementCandidate[] = candidates
        .filter(c => c.capabilities.includes(task.capability))
        .map(c => this.buildCandidate(c, task));
      
      nodes.push({
        id: task.id,
        capability: task.capability,
        dependencies: task.dependencies,
        inputs: task.inputs,
        output: { id: task.id + '-output', bytes: task.outputBytes },
        baselineDeviceId: this.selectBaseline(taskCandidates),
        memoryBytes: task.memoryMB * 1024 * 1024,
        minimumQuality: task.minQuality,
        candidates: taskCandidates
      });
    }
    
    return nodes;
  }
  
  /**
   * 构建候选设备 - 包含实时资源状态
   */
  private buildCandidate(
    device: DeviceCandidate,
    task: TaskSpec
  ): PlacementCandidate {
    return {
      deviceId: device.deviceId,
      executorId: device.executorId,
      capability: task.capability,
      trusted: device.trusted,
      source: 'REAL',
      observedAt: device.observedAt,
      ttlMs: device.ttlMs,
      
      // 资源状态 (来自设备上报)
      availableSlots: device.resourceSnapshot.availableSlots,
      availableMemoryBytes: device.resourceSnapshot.availableMemoryMB * 1024 * 1024,
      
      // 性能预估 (来自历史样本)
      quality: device.history?.quality ?? null,
      computeMs: device.history?.meanMs ?? this.coldStartEstimate(device, task),
      queueMs: device.resourceSnapshot.queueLength * 100, // 简化估算
      coldMs: device.history ? 0 : 50,
      uncertaintyMs: device.history?.stddevMs ?? 0,
      publishMs: 0
    };
  }
  
  /**
   * 冷启动估算 - 基于设备类型和任务复杂度
   */
  private coldStartEstimate(device: DeviceCandidate, task: TaskSpec): number {
    const base = task.estimatedMs ?? 1000;
    const factor = {
      'CLOUD': 1.0,
      'WORKER': 1.2,
      'PHONE': 1.5,
      'EDGE': 1.3
    }[device.deviceType] ?? 1.5;
    
    return base * factor;
  }
}

/**
 * 任务图 - 通用表示,不绑定购物
 */
export interface TaskGraph {
  capability: string; // 主capability (用于日志)
  inputs: ArtifactRef[];
  tasks: TaskSpec[];
}

export interface TaskSpec {
  id: string;
  capability: string; // 该任务需要的能力
  dependencies: string[]; // 依赖的前序任务
  inputs: string[]; // 输入artifact ID
  outputBytes: number;
  memoryMB: number;
  minQuality: number;
  estimatedMs?: number; // 冷启动参考
}

/**
 * 设备候选 - 动态查询结果
 */
export interface DeviceCandidate {
  deviceId: string;
  deviceType: 'CLOUD' | 'WORKER' | 'PHONE' | 'EDGE';
  executorId: string;
  capabilities: string[]; // 支持的capability列表
  trusted: boolean;
  observedAt: number;
  ttlMs: number;
  
  resourceSnapshot: {
    availableSlots: number;
    availableMemoryMB: number;
    queueLength: number;
    thermalLevel?: string;
    batteryPercent?: number;
  };
  
  history?: {
    quality: number;
    meanMs: number;
    stddevMs: number;
    sampleCount: number;
  };
}

export interface SchedulingContext {
  budgetMs: number;
  networkAllowed: boolean;
  privacyLevel: 'LOCAL_ONLY' | 'AUTHORIZED_REMOTE';
  localDeviceId?: string;
  finalDestination?: string;
  userWaiting: boolean;
  importance: number;
}

export interface SchedulingDecision {
  deviceId: string;
  executorId: string;
  estimatedMs: number;
  baseline: { deviceId: string; estimatedMs: number };
  reason: string;
  mode: 'BASELINE' | 'OPTIMIZED' | 'FALLBACK';
}
```

#### 修改2: Worker微观调度器

**新文件**: `services/device-worker/worker-policy.mjs`

```javascript
/**
 * Worker微观调度策略 - 简化版ConstrainedPolicy
 * 
 * 职责: 根据当前Worker的资源压力,决定是否接受新任务
 */
export class WorkerPolicy {
  constructor(config) {
    this.maxSlots = config.maxSlots || 2;
    this.maxMemoryMB = config.maxMemoryMB || 4096;
    this.cpuThreshold = config.cpuThreshold || 0.8;
  }
  
  /**
   * 准入决策 - 是否接受新任务
   */
  admit(task, state) {
    // 1. 资源硬约束
    if (state.activeSlots >= this.maxSlots) {
      return { allowed: false, reason: 'SLOTS_FULL' };
    }
    
    if (state.usedMemoryMB + task.memoryMB > this.maxMemoryMB * 0.9) {
      return { allowed: false, reason: 'MEMORY_INSUFFICIENT' };
    }
    
    // 2. CPU压力检查
    if (state.cpuUsage > this.cpuThreshold) {
      return { allowed: false, reason: 'CPU_HIGH_LOAD' };
    }
    
    // 3. 任务队列长度
    if (state.queueLength >= 3) {
      return { allowed: false, reason: 'QUEUE_TOO_LONG' };
    }
    
    return { allowed: true, reason: 'RESOURCE_AVAILABLE' };
  }
  
  /**
   * 配置选择 - 决定使用多少线程
   */
  selectConfig(task, state) {
    // 基于当前负载和任务优先级
    const baseThreads = task.defaultThreads || 4;
    
    // 如果有其他任务在执行,降低线程数
    if (state.activeSlots > 0) {
      return { threads: Math.max(2, Math.floor(baseThreads / 2)) };
    }
    
    // 如果CPU已有压力,保守配置
    if (state.cpuUsage > 0.5) {
      return { threads: Math.max(2, Math.floor(baseThreads * 0.75)) };
    }
    
    return { threads: baseThreads };
  }
}
```

#### 修改3: 宏观→微观数据流

**关键**: 宏观调度选中设备后,需要传递任务上下文给微观调度

```typescript
// 宏观调度输出
const macroDecision = await macroScheduler.schedule(graph, candidates, context);

// 派发到目标设备时,携带宏观决策信息
await deviceExecutor.execute({
  task: taskSpec,
  macroContext: {
    baseline: macroDecision.baseline, // 告诉设备: 基线方案是什么
    selected: macroDecision.deviceId, // 告诉设备: 为什么选你
    urgency: context.userWaiting, // 告诉设备: 用户是否在等
    budgetMs: macroDecision.estimatedMs // 告诉设备: 你的预算
  }
});

// Worker微观调度使用这些信息
class WorkerExecutor {
  async execute(request) {
    // 微观调度可以知道:
    // 1. 如果baseline是Cloud,说明我是优化方案,要尽力完成
    // 2. 如果用户在等,提高优先级
    // 3. 根据budgetMs调整线程配置
    
    const policy = new WorkerPolicy();
    const state = this.getResourceState();
    
    const admission = policy.admit(request.task, state);
    if (!admission.allowed) {
      // 拒绝任务,让宏观调度降级到baseline
      throw new Error(admission.reason);
    }
    
    const config = policy.selectConfig(request.task, state);
    
    // 使用选定的配置执行
    return this.run(request.task, config);
  }
}
```

## 三、修改清单 (按优先级)

### P0: 核心算法重构 (必须完成)

**1. 宏观调度器通用化**
- 新建 `macro-scheduler.service.ts`
- 接口: `schedule(graph, candidates, context)`
- 不依赖购物业务,不写死阶段

**2. DeviceDispatchService重构**
- 删除 `crop()` 方法
- 新增 `dispatch(capability, context)` 通用方法
- 动态查询Worker列表,不读环境变量

**3. Worker微观调度**
- 新建 `worker-policy.mjs`
- 实现 `admit()` 和 `selectConfig()`
- 参考ConstrainedPolicy思想

**4. 宏观→微观数据流**
- 修改执行器接口,传递宏观决策上下文
- Worker/Phone都能知道为什么被选中

### P1: 统一派发层

**5. InferenceLocation扩展**
- 新增 `ADAPTIVE` 枚举值
- ShoppingTaskService改用ADAPTIVE

**6. 统一派发入口**
- 新建 `unified-dispatch.service.ts`
- 聚合Cloud/Worker/Phone三条路径
- 调用MacroScheduler

### P2: 动态设备发现

**7. Worker自注册**
- 利用现有descriptor协议
- 启动时POST注册,定时心跳

**8. Phone状态上报**
- 新建 `DeviceProfileReporter.ets`
- 定时上报资源状态和capabilities

## 四、算法验证方案

### 验证点1: 宏观算法通用性
```typescript
// 测试用例1: 单阶段任务 (图片裁剪)
const graph1 = {
  capability: 'image.crop.v1',
  tasks: [{ id: 'crop', capability: 'image.crop.v1', ... }]
};

// 测试用例2: 多阶段任务 (购物)
const graph2 = {
  capability: 'shopping.image.search.v1',
  tasks: [
    { id: 'crop', capability: 'image.crop.v1', dependencies: [] },
    { id: 'embedding', capability: 'image.embedding.v1', dependencies: ['crop'] },
    // ...
  ]
};

// 测试用例3: 完全不同的任务 (翻译)
const graph3 = {
  capability: 'nlp.translation.zh-en',
  tasks: [{ id: 'translate', capability: 'nlp.translation.zh-en', ... }]
};

// 同一个宏观调度器应该都能处理
```

### 验证点2: 微观调度覆盖
- Phone: ConstrainedPolicy (已有)
- Worker: WorkerPolicy (新增) - 验证资源准入
- Cloud: RuntimePolicy (可简化为固定配置)

### 验证点3: 宏微观数据流
- 宏观选择Worker优化方案
- Worker收到任务,知道urgency=high
- Worker微观调度分配更多线程
- 执行完成,宏观记录实际耗时

## 五、关键技术细节

### 细节1: 候选设备查询接口

```typescript
interface DeviceRegistry {
  /**
   * 查询支持特定capability的在线设备
   */
  queryDevices(capability: string): Promise<DeviceCandidate[]>;
}

// 实现:
class DeviceRegistryService implements DeviceRegistry {
  async queryDevices(capability: string) {
    const devices: DeviceCandidate[] = [];
    
    // 1. Cloud总是可用
    devices.push({
      deviceId: 'cloud-runtime',
      deviceType: 'CLOUD',
      capabilities: ['*'], // 支持所有
      resourceSnapshot: { availableSlots: 10, ... }
    });
    
    // 2. 查询Worker (从descriptor协议)
    const workers = await this.queryWorkers(capability);
    devices.push(...workers);
    
    // 3. 查询Phone (从配对服务)
    const phones = await this.queryPhones(capability);
    devices.push(...phones);
    
    return devices;
  }
}
```

### 细节2: 任务图构建

```typescript
// 业务层负责构建图
class ShoppingRuntimeService {
  async executeImageSearch(request) {
    // 构建购物12阶段的图
    const graph: TaskGraph = {
      capability: 'shopping.image.search.v1',
      inputs: [request.imageArtifact],
      tasks: [
        { id: 'crop', capability: 'image.crop.v1', dependencies: [], ... },
        { id: 'embedding', capability: 'image.embedding.v1', dependencies: ['crop'], ... },
        // ... 12阶段
      ]
    };
    
    // 查询候选设备
    const candidates = await this.deviceRegistry.queryDevices('shopping.image.search.v1');
    
    // 调用宏观调度
    const decision = await this.macroScheduler.schedule(graph, candidates, context);
    
    // 派发执行
    return this.dispatch(decision, graph);
  }
}
```

### 细节3: 历史样本收集

```typescript
// 执行完成后更新历史
class MacroSchedulerService {
  async recordExecution(deviceId: string, capability: string, result: ExecutionResult) {
    const sample = {
      deviceId,
      capability,
      actualMs: result.durationMs,
      success: !result.error,
      timestamp: Date.now()
    };
    
    await this.historyStore.append(sample);
    
    // EWMA更新
    const history = await this.historyStore.get(deviceId, capability);
    const alpha = 0.25;
    history.meanMs = alpha * result.durationMs + (1 - alpha) * history.meanMs;
    history.stddevMs = alpha * Math.abs(result.durationMs - history.meanMs) + (1 - alpha) * history.stddevMs;
    history.sampleCount++;
    
    await this.historyStore.update(history);
  }
}
```

## 六、执行路线图

### 第1周: 核心算法
- Day 1-2: 实现MacroSchedulerService
- Day 3-4: 重构DeviceDispatchService
- Day 5-6: 实现WorkerPolicy
- Day 7: 打通宏微观数据流

### 第2周: 统一派发
- Day 8-9: UnifiedDispatchService
- Day 10-11: 修改ShoppingRuntimeService接入
- Day 12-13: 扩展InferenceLocation
- Day 14: 端到端测试

### 第3周: 动态发现
- Day 15-16: Worker自注册
- Day 17-18: Phone状态上报
- Day 19-20: 多capability测试
- Day 21: 完整验收

## 七、成功标准

### 算法验收
- [ ] 宏观调度可处理任意capability任务图
- [ ] 微观调度覆盖Phone/Worker/Cloud
- [ ] 宏观选的设备,微观知道为什么被选中

### 解耦验收
- [ ] 新增翻译App无需修改调度算法
- [ ] Worker下线自动降级,无需手动配置
- [ ] Phone和Worker地位完全平等

### 性能验收
- [ ] 宏观调度决策 < 20ms
- [ ] 微观准入决策 < 5ms
- [ ] 端到端延迟与原系统持平

---

**核心理念**: 
- 算法通用化,不绑定业务
- 两层调度数据流通
- 终端地位平等,动态插拔

**不做的事**:
- 不重写WorkflowPlacementPlanner (算法已验证)
- 不重写ConstrainedPolicy (Phone端已完善)
- 不发明新协议 (利用descriptor/配对机制)

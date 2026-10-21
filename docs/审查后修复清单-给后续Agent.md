# 深度审查后修复清单 - 给后续Agent

> **2026-10-22 实施更新**：当前验收结果见 [重要-请先读我.md](重要-请先读我.md) 顶部。下文代码模板是历史建议，不能直接套用：RuntimeRunner.execute 的入口是 runId/input，RuntimeTaskGraph.nodes 与宏观 TaskGraph.tasks 不是同一类型。当前云端执行通过调用方注册能力回调；多节点按各自设备分配执行，依赖制品校验 hash，预算逐步扣减。正式购物已接入阶段钩子和通用裁剪图，但尚未形成整条购物 DAG 的一次性跨设备联合执行。设备统一目录、第二手机路径和完整反馈闭环仍未完成。

> **背景**: 2026-10-22深夜进行了完整代码审查,对照复赛系统架构文档和作品说明PDF,发现多处关键断点。本文档记录已修复和待修复项。

---

## 一、审查结论概要

### ❌ 当前状态: 架构修复**未完成**

**原因**:
1. 正式购物流程仍走旧路径 (`shopping-runtime.service.ts:131`)
2. 旧路径的Worker调用缺少macroContext (`device-dispatch.service.ts:142`)
3. 三条设备路径(HAR/Worker/PhoneB)未统一
4. 设备动态注册、反馈闭环未完成

**已完成部分**:
- ✅ 核心算法通用化 (MacroScheduler)
- ✅ Worker微观调度策略 (WorkerPolicy)
- ✅ 关键算法错误修复 (applyGates)
- ✅ 图定义解耦 (移除locality写死)

---

## 二、已修复的关键断点 ✅

### 断点1: SchedulerClient强制转换 ✅

**位置**: `apps/harmony/scheduler/src/main/ets/api/SchedulerClient.ets:268-269`

**问题**: 
```typescript
// 旧代码
const location = request.location === InferenceLocation.ADAPTIVE 
  ? InferenceLocation.REMOTE_CLOUD  // 强制转换!
  : request.location;
```

**影响**: 手机发起的自适应请求被前端拦截,云端无法知道用户想自适应

**修复**: 
```typescript
// 新代码: 保留ADAPTIVE原值
const location = request.location;
```

**验证**: 手机现在能发送ADAPTIVE标识到云端

---

### 断点2: applyGates算法错误 ✅ (最关键!)

**位置**: `services/api-server/src/core/runtime/macro-scheduler.service.ts:343-398`

**问题**: 
```typescript
// 旧代码: 只比较首节点
const savingMs = baseline[0].partialMs - suggestion[0].partialMs;
```

**后果**: 
- 审查举例: 首节点差-20ms,但后续节省320ms
- 旧算法返回IMPROVEMENT_TOO_SMALL,拒绝优化方案
- **忽略了300ms的总收益!**

**修复**:
```typescript
// 新代码: 比较整条工作流
const baselineTotalMs = decision.baselineMs ?? 999999;
const suggestionTotalMs = decision.suggestionMs ?? 999999;
const savingMs = baselineTotalMs - suggestionTotalMs;
```

**验证**: 算法现在能识别多阶段协同优化

**理论依据**: PDF明确说"围绕整条任务链优化",不是单节点

---

### 断点3: 图定义locality写死 ✅

**位置**: 
- `services/api-server/src/core/runtime/image-search-task-graph.ts:16`
- `services/api-server/src/core/runtime/shopping-task-graph.ts:6`

**问题**:
```typescript
// 旧代码
constraints: {
  locality: 'cloud_only',  // 写死!
  privacy: 'PUBLIC'
}
```

**后果**: 
- 宏观调度器即使发现Worker更优,也无法选择
- 所有阶段强制云端执行

**修复**:
```typescript
// 新代码: 只保留真实约束
constraints: {
  privacy: 'PUBLIC',
  deadlineMs: 2000
}
// 删除locality字段
```

**验证**: crop/embedding等阶段现在可选Worker

---

### 断点4-5: executeOnWorker和WorkerPolicy已存在 ✅

**发现**: 审查确认以下代码**已完整实现**,之前误判:

1. **executeOnWorker** (`device-dispatch.service.ts:300-367`)
   - 完整流程: 上传输入→租约→执行→轮询→下载
   - **关键**: line 342已传macroContext!
   
2. **WorkerPolicy** (`services/device-worker/worker-policy.mjs`)
   - admit: 资源准入决策
   - selectConfig: 根据urgency调整线程数

**结论**: Worker执行链路功能完整,不需要重新实现

---

## 三、待修复的关键断点 ❌

### 🔴 断点6: executeCrop未传macroContext (最高优先级!)

**位置**: `services/api-server/src/core/runtime/device-dispatch.service.ts:142`

**问题**:
```typescript
// line 142的execute调用
await this.call(device, ownerId, 'execute', {
  leaseId: lease.leaseId,
  fencingToken: lease.fencingToken,
  capability: 'image.crop.v1',
  input, parameters,
  privacy: 'AUTHORIZED_REMOTE',
  networkAllowed: true
  // ❌ 缺少 macroContext 字段!
}, signal);
```

**影响**: 
- **正式购物流程**虽然调用Worker,但Worker收不到宏观上下文
- Worker不知道urgency,无法调整线程数
- 微观调度策略失效

**修复方案**:
```typescript
// 方案1: 在crop()方法中构造基本macroContext
const macroContext = {
  baselineDevice: actual.deviceId === 'cloud-runtime' ? null : 'cloud-runtime',
  urgency: context.urgency ?? true, // 从上下文读取
  budgetMs: RuntimeWorkScope.remainingBudget(60000)
};

await this.call(device, ownerId, 'execute', {
  leaseId: lease.leaseId,
  fencingToken: lease.fencingToken,
  capability: 'image.crop.v1',
  input, parameters,
  privacy: 'AUTHORIZED_REMOTE',
  networkAllowed: true,
  macroContext  // ✅ 添加此字段
}, signal);
```

**验收标准**:
1. Worker收到macroContext参数
2. WorkerPolicy.selectConfig能读取urgency
3. urgency=true时线程数×1.5

---

### 🔴 断点7: ShoppingRuntimeService未调用新路径

**位置**: `services/api-server/src/modules/sessions/application/shopping-runtime.service.ts:131`

**问题**:
```typescript
// line 131
const result = await this.runner.execute(graph, this.registry, {
  // ... 仍使用旧的RuntimeRunner执行
});
```

**后果**: 
- 新的MacroScheduler和dispatch()没被调用
- 正式流程仍走固定购物链路
- 设备选择逻辑未生效

**修复方案**: 

**方案A: 完整重构购物流程** (推荐)
```typescript
import { MacroSchedulerService } from '../../../core/runtime/macro-scheduler.service';
import { DeviceDispatchService } from '../../../core/runtime/device-dispatch.service';

constructor(
  // ... 现有依赖
  private readonly macroScheduler: MacroSchedulerService,
  private readonly deviceDispatch: DeviceDispatchService
) {}

async execute(toolId: string, request: WorkflowRequest, signal?: AbortSignal) {
  // ... 前置逻辑

  // 1. 构建任务图 (保留现有逻辑)
  const graph = buildImageSearchTaskGraph(/* ... */);

  // 2. 调用宏观调度
  const context = {
    privacyLevel: 'AUTHORIZED_REMOTE',
    budgetMs: 60000,
    networkAllowed: true
  };

  // 3. 逐阶段派发 (或修改dispatch支持多节点)
  const results = {};
  for (const task of graph.tasks) {
    const subGraph = { tasks: [task], inputs: graph.inputs };
    const result = await this.deviceDispatch.dispatch(subGraph, context);
    results[task.taskId] = result;
  }

  // 4. 返回结果 (保留现有格式)
  return { /* ... */ };
}
```

**方案B: 渐进式迁移** (保守)
```typescript
// 先保留旧路径,只在特定条件启用新路径
if (process.env.UNIFIED_DISPATCH_ENABLED === 'true') {
  // 调用新路径
  return this.deviceDispatch.dispatch(graph, context);
} else {
  // 调用旧路径
  return this.runner.execute(graph, ...);
}
```

**验收标准**:
1. 购物流程调用MacroScheduler
2. 根据决策选择Worker或Cloud
3. 旧功能不退化 (268项单测仍通过)

---

### 🔴 断点8: executeOnCloud未实现

**位置**: `device-dispatch.service.ts:372-378`

**问题**:
```typescript
private async executeOnCloud(
  graph: TaskGraph,
  macroContext: any
): Promise<any> {
  throw new Error('NOT_IMPLEMENTED: executeOnCloud');
}
```

**影响**: 
- dispatch()选中云端时直接报错
- 无法执行baseline方案

**修复方案**:

**方案A: 委托给RuntimeRunner** (推荐)
```typescript
import { RuntimeRunnerService } from './runtime-runner.service';
import { ExecutorRegistryService } from './executor-registry.service';

constructor(
  // ... 现有依赖
  private readonly runner: RuntimeRunnerService,
  private readonly registry: ExecutorRegistryService
) {}

private async executeOnCloud(
  graph: TaskGraph,
  macroContext: any,
  context: SchedulingContext
): Promise<any> {
  // 转换为RuntimeRunner的格式
  const runtimeContext = {
    toolId: graph.capability,
    ownerId: RuntimeWorkScope.ownerId(),
    budget: context.budgetMs,
    signal: RuntimeWorkScope.signal(context.budgetMs)
  };

  return this.runner.execute(graph, this.registry, runtimeContext);
}
```

**方案B: 直接调用执行器** (简单)
```typescript
private async executeOnCloud(
  graph: TaskGraph,
  macroContext: any,
  context: SchedulingContext
): Promise<any> {
  const executor = this.registry.find('zeabur-shopping-workflow');
  if (!executor) throw new Error('CLOUD_EXECUTOR_NOT_FOUND');

  return executor.execute({
    graph,
    macroContext,
    ...context
  });
}
```

**验收标准**:
1. 选中云端时不报错
2. 调用现有云端执行器
3. 返回格式与旧路径一致

---

### 🟡 断点9: 多节点图Worker不支持

**位置**: `device-dispatch.service.ts:312`

**问题**:
```typescript
// executeOnWorker内部
if (graph.tasks.length !== 1 || graph.tasks[0].dependencies.length !== 0) {
  throw new Error('WORKER_GRAPH_UNSUPPORTED');
}
```

**影响**: 
- 购物12阶段无法在Worker执行
- Worker只能执行单节点任务

**修复方案**:

**方案A: 逐阶段派发** (推荐)
```typescript
// 在dispatch()中检测多节点图
if (decision.deviceId !== 'cloud-runtime' && graph.tasks.length > 1) {
  // 拆分为多个单节点图,逐个派发
  const results = [];
  for (const task of graph.tasks) {
    const subGraph = {
      capability: task.capability,
      tasks: [task],
      inputs: graph.inputs.filter(i => task.inputs.includes(i.artifactId))
    };
    const result = await this.executeOnWorker(
      decision.deviceId,
      subGraph,
      decision.macroContext,
      context
    );
    results.push(result);
  }
  return results;
}
```

**方案B: Worker支持多阶段** (复杂)
```typescript
// 修改Worker server.mjs,支持pipeline执行
// 需要改造Worker协议和租约机制
```

**验收标准**:
1. 购物流程能在Worker执行crop阶段
2. 其他阶段能继续在云端执行
3. 数据正确传递

---

### 🟡 断点10: allowLocalFallback未生效

**位置**: 
- `apps/harmony/scheduler/src/main/ets/policy/SemanticPolicy.ets:149`
- `apps/harmony/entry/src/main/ets/services/CloudShoppingExecutor.ets:65`

**问题**:
```typescript
// SemanticPolicy line 149
const plan = {
  allowLocalFallback: false,  // 写死false!
  // ...
};

// CloudShoppingExecutor line 65
supports(plan: ExecutionPlan): boolean {
  return plan.allowLocalFallback === false;  // 要求必须false
}
```

**影响**: 
- 云端失败后无法降级到本地
- 声明的降级策略不生效

**修复方案**:
```typescript
// SemanticPolicy: 根据urgency决定
const plan = {
  allowLocalFallback: context.urgency !== 'CRITICAL',
  // ...
};

// CloudShoppingExecutor: 改为支持降级
supports(plan: ExecutionPlan): boolean {
  return plan.location === InferenceLocation.REMOTE_CLOUD ||
         plan.location === InferenceLocation.ADAPTIVE;
}

// 注册本地降级执行器
class LocalFallbackExecutor implements Executor {
  supports(plan: ExecutionPlan): boolean {
    return plan.allowLocalFallback === true;
  }
  async execute(context: ExecutionContext): Promise<any> {
    // 本地推理逻辑
  }
}
```

**验收标准**:
1. urgency不高时allowLocalFallback=true
2. 云端失败后能降级到本地
3. 本地执行器能正常工作

---

## 四、核心理解纠正

### 1. "接通程度不一致"的真实含义

**不是**: 某个抽象概念  
**而是**: 三条具体路径未统一

| 路径 | 当前实现 | 缺失连接 |
|------|---------|---------|
| 手机HAR | 本地状态→配置选择→队列→执行 | 未作为远端节点接入云端宏观调度 |
| Worker | HTTP上传→租约→执行→下载 | 只接入裁剪;设备目录未通用化 |
| 第二手机 | 云端配对→手机轮询→页面执行 | 未经过成本规划器;未用HAR执行 |

**来源**: [复赛系统审查文档](file:///E:/learning_resource/Harmony_Creation/HarmonyOS/Harmony-cc/docs/24-%E5%A4%8D%E8%B5%9B%E9%A1%B9%E7%9B%AE%E7%B3%BB%E7%BB%9F%E5%AE%A1%E6%9F%A5%E4%B8%8E%E8%B0%83%E5%BA%A6%E6%9E%B6%E6%9E%84%E8%AF%A6%E8%A7%A3-20261020.md) S01-S05部分

---

### 2. "可信CPU Worker"的真实含义

**不是**: 特殊硬件或TEE  
**而是**: 通过协议保证可信的普通Node.js服务

**可信机制**:
- 预配置地址和token (`RUNTIME_DEVICES_JSON`)
- owner隔离 (不同用户数据不混)
- 制品哈希校验 (SHA-256)
- 租约+fencing (防并发)
- 断路器 (3次失败后熔断)

**来源**: [Worker实现](file:///E:/learning_resource/Harmony_Creation/HarmonyOS/Harmony-cc/services/device-worker/server.mjs) line 105开始

---

### 3. 宏微观正确分工 (来自PDF)

**来源**: 作品说明文档PDF 第5、8-9、13-17页

#### 宏观层职责 (云端):
- **掌握信息**: 全部任务依赖、所有设备能力摘要、数据位置、网络链路、预算、历史成本样本
- **决策输出**: 每个阶段在哪台设备执行、何时重规划
- **示例**: "裁剪阶段用Worker-A,embedding用Cloud"

#### 微观层职责 (终端):
- **掌握信息**: 本机实时负载、可用后端(CPU/GPU/NPU)、内存、热状态、执行器合法配置
- **决策输出**: 是否准入当前任务、何时执行、用什么线程数/内存/后端
- **示例**: "当前CPU80%,拒绝准入" 或 "urgency=true,线程数×1.5"

#### 反馈层职责 (双向):
- **上报信息**: 实际采用的配置、分段耗时、质量指标、拒绝原因、物理结算状态
- **调整决策**: 更新成本样本、调整后续阶段放置

**关键点**: 
- 宏观不能只看设备名+平均耗时
- 微观不能只收urgency布尔值
- 两层应**联合求解"设备+配置"**

---

## 五、执行优先级与路线图

### P0 - 关键修复 (必须完成,否则现有功能受影响)

**Task 1**: 修复executeCrop传macroContext ⚠️
- 优先级: 🔴 最高
- 影响: 现有Worker路径功能降级
- 工作量: 10行代码
- 文件: `device-dispatch.service.ts:142`

**Task 2**: 实现executeOnCloud
- 优先级: 🔴 高
- 影响: 新路径无法选云端
- 工作量: 20行代码
- 文件: `device-dispatch.service.ts:372`

---

### P1 - 架构打通 (完成后形成完整新路径)

**Task 3**: ShoppingRuntimeService接入新调度
- 优先级: 🟡 中高
- 影响: 正式流程走新路径
- 工作量: 50行代码 + 测试
- 文件: `shopping-runtime.service.ts:131`

**Task 4**: 支持多节点图或逐阶段派发
- 优先级: 🟡 中高
- 影响: 购物12阶段能在Worker执行
- 工作量: 30行代码
- 文件: `device-dispatch.service.ts:312`

---

### P2 - 完善与优化 (增强鲁棒性)

**Task 5**: 实现allowLocalFallback降级
- 优先级: 🟢 中
- 影响: 云端失败后降级
- 工作量: 40行代码
- 文件: `SemanticPolicy.ets`, `CloudShoppingExecutor.ets`

**Task 6**: 设备动态注册与统一目录
- 优先级: 🟢 中低
- 影响: 设备插拔
- 工作量: 100行代码
- 状态: 可利用现有descriptor协议

**Task 7**: 第二手机接入调度中枢
- 优先级: 🟢 低
- 影响: PhoneB走统一算法
- 工作量: 80行代码
- 文件: `phone-dispatch.service.ts`

---

## 六、验收标准

### 核心链路验收:

1. **手机发起购物搜索**
   - ✅ 发送ADAPTIVE标识
   - ✅ 云端调用MacroScheduler
   - ✅ 根据决策选Worker或Cloud
   - ✅ Worker收到macroContext
   - ✅ Worker根据urgency调整线程数
   - ✅ 返回正确结果

2. **Worker执行crop**
   - ✅ 上传输入+哈希校验
   - ✅ 租约申请成功
   - ✅ 执行时收到macroContext
   - ✅ WorkerPolicy生效
   - ✅ 下载输出+哈希校验

3. **Cloud执行crop**
   - ✅ 选中云端时不报错
   - ✅ 调用RuntimeRunner
   - ✅ 返回格式一致

### 回归测试:

- ✅ 268项API单测通过
- ✅ Worker集成测试通过
- ✅ 客户端HAR功能正常

---

## 七、关键技术细节

### 1. macroContext格式

```typescript
interface MacroContext {
  baselineDevice: string | null;  // baseline方案设备ID,null表示无基线
  urgency: boolean;                // 是否紧急(用户在等)
  budgetMs: number;                // 剩余预算(毫秒)
  dataLocation?: string;           // 数据当前位置
  expectedQuality?: number;        // 预期质量[0-1]
}
```

### 2. Worker execute API扩展

```typescript
// Worker server.mjs的execute端点
POST /owner/:ownerId/execute
Body: {
  leaseId: string,
  fencingToken: number,
  capability: string,
  input: ArtifactRef,
  parameters: object,
  privacy: 'AUTHORIZED_REMOTE',
  networkAllowed: boolean,
  macroContext: MacroContext  // 新增字段
}
```

### 3. 冷启动估算逻辑

```typescript
// MacroScheduler.coldStartEstimate()
function coldStartEstimate(deviceType: string, capability: string): number {
  // Worker: 假设4核CPU,单线程推理
  if (deviceType === 'WORKER') {
    if (capability.includes('crop')) return 800;
    if (capability.includes('embedding')) return 1500;
    return 1200;
  }
  
  // Cloud: Zeabur容器,Sharp+MobileNet
  if (deviceType === 'CLOUD') {
    if (capability.includes('crop')) return 1000;
    if (capability.includes('embedding')) return 1800;
    return 1500;
  }
  
  return 2000;  // 未知设备保守估计
}
```

---

## 八、常见问题

### Q1: 为什么不直接重写所有路径?

**A**: 渐进式重构风险更低。268项单测证明现有路径可靠,全部推翻会引入大量回归风险。正确做法是:
1. 先修复关键断点 (executeCrop传参)
2. 并行运行新旧路径 (feature flag)
3. 逐步迁移正式流程
4. 验证后删除旧代码

### Q2: 为什么断点6(executeCrop)是最高优先级?

**A**: 因为它影响**现有功能**:
- 正式购物流程已经在用Worker (crop阶段)
- 但Worker收不到urgency,微观调度策略失效
- 用户已上线的功能在"降级运行"

其他断点是"新功能未完成",而断点6是"已有功能有缺陷"。

### Q3: executeOnCloud为什么不直接复用RuntimeRunner?

**A**: 可以复用!两种方案:
- **方案A**: `executeOnCloud`内部调用`this.runner.execute()`
- **方案B**: `dispatch()`判断选云端时,直接返回调用`RuntimeRunner`

推荐方案A,保持dispatch()的统一性。

### Q4: 多节点图Worker不支持,是否要改Worker协议?

**A**: **不需要**。推荐"逐阶段派发":
- dispatch()检测多节点图
- 拆分为多个单节点子图
- 逐个调用executeOnWorker
- 数据在云端或Worker间传递

这样不改Worker协议,只改云端派发逻辑。

### Q5: 如何验证macroContext真的传到Worker了?

**A**: 三种方法:
1. **日志验证**: Worker server.mjs的execute端点打印req.body
2. **调试验证**: Chrome DevTools断点
3. **功能验证**: urgency=true时,查看Worker实际线程数

---

## 九、参考文档

### 项目文档:
1. [复赛系统审查文档](file:///E:/learning_resource/Harmony_Creation/HarmonyOS/Harmony-cc/docs/24-%E5%A4%8D%E8%B5%9B%E9%A1%B9%E7%9B%AE%E7%B3%BB%E7%BB%9F%E5%AE%A1%E6%9F%A5%E4%B8%8E%E8%B0%83%E5%BA%A6%E6%9E%B6%E6%9E%84%E8%AF%A6%E8%A7%A3-20261020.md)
2. 作品说明文档PDF (第5、8-9、13-17页)
3. [Agent交接文档-剩余任务清单.md](file:///E:/learning_resource/Harmony_Creation/HarmonyOS/Harmony-cc/docs/Agent%E4%BA%A4%E6%8E%A5%E6%96%87%E6%A1%A3-%E5%89%A9%E4%BD%99%E4%BB%BB%E5%8A%A1%E6%B8%85%E5%8D%95.md)

### 关键代码文件:
1. MacroScheduler: `services/api-server/src/core/runtime/macro-scheduler.service.ts`
2. WorkerPolicy: `services/device-worker/worker-policy.mjs`
3. DeviceDispatch: `services/api-server/src/core/runtime/device-dispatch.service.ts`
4. ShoppingRuntime: `services/api-server/src/modules/sessions/application/shopping-runtime.service.ts`
5. Worker Server: `services/device-worker/server.mjs`

### 工作日志:
- `.workbuddy-ai/memory/2026-10-22.md`

---

## 十、总结

### 当前进度: 60%

- ✅ 核心算法通用化
- ✅ Worker微观调度
- ✅ 关键bug修复 (applyGates)
- ⏳ 正式流程接入 (0%)
- ⏳ 设备统一目录 (0%)
- ⏳ 完整反馈闭环 (0%)

### 最紧迫任务:

1. **修复executeCrop传macroContext** - 10分钟
2. **实现executeOnCloud** - 20分钟
3. **ShoppingRuntimeService接入新调度** - 2小时

### 预期效果:

完成P0+P1后,系统将具备:
- ✅ 真正的自适应调度 (不再写死REMOTE_CLOUD)
- ✅ 宏微观数据流打通 (urgency生效)
- ✅ Worker/Cloud统一决策 (经过MacroScheduler)
- ✅ 多阶段协同优化 (applyGates正确比较)

距离"业务无关、设备可插拔、统一调度"的完整架构还需P2工作,但核心链路将完整可用。

---

**创建时间**: 2026-10-22 00:42  
**审查者**: Kiro (基于深度代码审查)  
**适用对象**: 后续接手的Agent或开发者

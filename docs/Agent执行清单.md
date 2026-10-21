# Agent执行清单 - 统一调度架构重构

> **目标受众:** 其他Agent/模型  
> **目标:** 完成智调鸿枢项目从"购物专用"到"通用AI任务调度系统"的核心链路重构  
> **优先级:** 按P0→P1→P2顺序执行

---

## 📋 执行前置条件检查

在开始任何修改前,请确认:

- [ ] 已阅读 `docs/重构方案-统一调度架构.md` 全文
- [ ] 已阅读 `docs/24-复赛项目系统审查与调度架构详解-20261020.md`
- [ ] 理解当前架构的核心问题(文档S01-S28引用)
- [ ] 理解新架构的三层调控体系(云端宏观/设备微观/设备内硬件)

---

## 🔴 P0任务 - 核心链路(必须完成)

### Task 1: 实现统一设备注册中心

**文件:** `services/api-server/src/core/runtime/unified-device-registry.service.ts`

**任务描述:**
创建新的设备注册服务,替代当前分散的设备管理机制。

**关键要求:**
1. 实现 `UnifiedDeviceProfile` 接口(参考重构方案2.1节)
2. 支持设备动态注册(`registerDevice`)和注销(`unregisterDevice`)
3. 实现TTL自动过期机制(使用setTimeout)
4. 实现按capability查询设备(`getDevicesForCapability`)
5. 支持增量更新设备状态(`updateDeviceState`)

**验收标准:**
```typescript
// 测试用例示例
const registry = new UnifiedDeviceRegistryService();

// 注册一个Worker设备
registry.registerDevice({
  deviceId: 'worker-001',
  deviceType: 'WORKER',
  capabilities: ['image.crop.v1', 'vector.normalize.v1'],
  resourceSnapshot: { availableSlots: 2, ... },
  // ... 其他字段
  observedAt: Date.now(),
  ttlMs: 60000,
  source: 'REAL',
  trusted: true
});

// 查询支持裁剪能力的设备
const devices = registry.getDevicesForCapability('image.crop.v1');
expect(devices).toContainEqual(expect.objectContaining({ deviceId: 'worker-001' }));

// 60秒后设备自动过期
await sleep(61000);
expect(registry.getDevicesForCapability('image.crop.v1')).toHaveLength(0);
```

**注意事项:**
- Map操作注意线程安全(Node.js单线程,但要考虑异步竞争)
- TTL过期使用setTimeout,不要用setInterval轮询
- 设备列表最多256个,超出时删除最老的

**预计工作量:** 2-3小时

---

### Task 2: 实现通用AI任务调度器

**文件:** `services/api-server/src/core/runtime/unified-task-scheduler.service.ts`

**任务描述:**
创建统一的任务调度入口,接收 `AITaskProfile`,返回 `DeviceAssignment`。

**关键要求:**
1. 实现 `AITaskProfile` 和 `DeviceAssignment` 接口(重构方案2.2节)
2. 依赖注入 `UnifiedDeviceRegistryService` 和 `WorkflowPlacementPlanner`
3. 实现 `scheduleTask()` 方法:
   - 查询候选设备
   - 转换为 `PlacementCandidate` 格式
   - 调用 `WorkflowPlacementPlanner.plan()`
   - 应用门禁策略
   - 返回最终分配结果

**验收标准:**
```typescript
const scheduler = new UnifiedTaskSchedulerService(registry, planner);

const task: AITaskProfile = {
  taskId: 'test-001',
  capability: 'image.crop.v1',
  resourceRequirements: {
    memoryMB: 256,
    budgetMs: 3000,
    privacyLevel: 'PUBLIC'
  },
  inputArtifacts: [{ id: 'img-1', ... }],
  outputSpec: { estimatedBytes: 1024*1024 },
  context: { userWaiting: true, ... }
};

const assignment = await scheduler.scheduleTask(task);

expect(assignment).toMatchObject({
  taskId: 'test-001',
  assignedDeviceId: expect.any(String),
  baseline: { deviceId: 'cloud-runtime', ... },
  suggestion: { deviceId: expect.any(String), ... }
});
```

**注意事项:**
- 冷启动估算使用保守值(重构方案 `estimateColdStart`)
- 质量评估基于历史样本,无样本返回null
- baseline选择最可靠设备(通常是云端)
- 网络拓扑构建要区分上传/下载方向

**依赖:** Task 1必须完成

**预计工作量:** 4-5小时

---

### Task 3: 手机端设备画像上报

**文件:** `apps/harmony/entry/src/main/ets/services/DeviceProfileUploader.ets`

**任务描述:**
在鸿蒙App中实现定时上报设备画像到云端。

**关键要求:**
1. 实现 `DeviceProfileUploader` 类(重构方案2.3节)
2. 定时30秒上报一次
3. 动态发现本地capabilities(不写死)
4. HTTP POST到云端 `/api/v1/devices/register`
5. 在 `EntryAbility.onCreate()` 中启动

**验收标准:**
```typescript
// 在EntryAbility中
const uploader = new DeviceProfileUploader(schedulerService, cloudUrl);
uploader.start();

// 检查云端是否收到注册
// (需要配合Task 4的云端接口)
```

**注意事项:**
- `discoverCapabilities()` 方法要实际检查本地文件/模型是否存在
- 不要写死 `['shopping.crop', 'shopping.search']` 这类业务相关能力
- 网络估算可以先用固定值,后续优化
- 错误处理:上报失败不应崩溃App

**依赖:** Task 1完成(云端有接收接口)

**预计工作量:** 3-4小时

---

### Task 4: 云端设备注册接口

**文件:** `services/api-server/src/modules/runtime/controllers/device-registry.controller.ts`

**任务描述:**
创建REST API接收设备注册请求。

**关键要求:**
```typescript
@Controller('devices')
export class DeviceRegistryController {
  constructor(private readonly registry: UnifiedDeviceRegistryService) {}
  
  @Post('register')
  async registerDevice(@Body() profile: UnifiedDeviceProfile) {
    this.registry.registerDevice(profile);
    return { success: true };
  }
  
  @Get('capabilities/:capability')
  async getDevices(@Param('capability') capability: string) {
    return this.registry.getDevicesForCapability(capability);
  }
}
```

**验收标准:**
```bash
# 测试注册
curl -X POST http://localhost:3100/api/v1/devices/register \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"test-001","deviceType":"WORKER",...}'

# 测试查询
curl http://localhost:3100/api/v1/devices/capabilities/image.crop.v1
```

**注意事项:**
- 添加 `@nestjs/common` 的验证管道
- 鉴权:至少验证 `Authorization` header
- 限流:防止恶意注册

**依赖:** Task 1

**预计工作量:** 1-2小时

---

### Task 5: 修改购物流程使用新调度器

**修改文件:**
1. `apps/harmony/entry/src/main/ets/services/ShoppingTaskService.ets`
2. `services/api-server/src/modules/sessions/application/shopping-runtime.service.ts`

**任务描述:**
将现有购物流程从硬编码 `REMOTE_CLOUD` 改为调用 `UnifiedTaskSchedulerService`。

**关键修改:**

**修改1: ShoppingTaskService.ets**
```typescript
// 删除
export const SHOPPING_TASK_TEMPLATE: TaskTemplate = {
  id: 'product_search',
  location: 'REMOTE_CLOUD',  // ❌ 删除这行
  // ...
};

// 改为
export const SHOPPING_TASK_TEMPLATE: TaskTemplate = {
  id: 'product_search',
  location: 'HYBRID',  // ✅ 允许本地或远端
  capability: 'shopping.image.search.v1',  // ✅ 新增
  // ...
};
```

**修改2: shopping-runtime.service.ts**
```typescript
// 新增依赖注入
constructor(
  // ... 原有依赖
  private readonly unifiedScheduler: UnifiedTaskSchedulerService
) {}

async executeImageSearch(request: ShoppingRequest): Promise<ShoppingResult> {
  // 构建AI任务画像
  const taskProfile: AITaskProfile = {
    taskId: randomUUID(),
    capability: 'shopping.image.search.v1',
    resourceRequirements: {
      memoryMB: 512,
      budgetMs: request.budgetMs ?? 150000,
      privacyLevel: 'PUBLIC'
    },
    inputArtifacts: [request.imageArtifact],
    outputSpec: { schema: 'ShoppingResult', estimatedBytes: 1024*1024 },
    context: {
      userWaiting: request.userWaiting,
      userVisible: request.userVisible,
      importance: request.importance ?? 5
    }
  };
  
  // 调用统一调度器
  const assignment = await this.unifiedScheduler.scheduleTask(taskProfile);
  
  // 根据分配结果执行
  if (assignment.assignedDeviceId === 'cloud-runtime') {
    return this.executeOnCloud(request, assignment);
  } else {
    return this.executeOnDevice(request, assignment);
  }
}
```

**验收标准:**
- 购物流程仍能正常工作
- 日志中可见调度决策(baseline/suggestion/actual)
- 不再看到硬编码的 `REMOTE_CLOUD` 路径

**注意事项:**
- 保持向后兼容,渐进式迁移
- 先用环境变量控制新旧路径切换
- 充分测试后再删除旧代码

**依赖:** Task 1, 2, 4

**预计工作量:** 3-4小时

---

## 🟡 P1任务 - 能力扩展(重要但非阻塞)

### Task 6: 外部任务适配器

**文件:** `apps/harmony/scheduler/src/main/ets/api/ExternalTaskAdapter.ets`

**任务描述:**
允许HAR接收云端派发的非本地发起任务。

**关键要求:**
参考重构方案2.4节实现 `ExternalTaskAdapter` 类。

**预计工作量:** 2-3小时

---

### Task 7: Worker动态注册

**修改文件:** `services/device-worker/worker.mjs`

**任务描述:**
Worker启动时主动向云端注册,替代环境变量 `RUNTIME_DEVICES_JSON`。

**关键修改:**
```javascript
// 启动时注册
async function registerWorker() {
  const profile = {
    deviceId: process.env.WORKER_DEVICE_ID,
    deviceType: 'WORKER',
    capabilities: ['image.crop.v1', 'vector.normalize.v1'],
    resourceSnapshot: {
      availableSlots: 2,
      totalMemoryMB: 4096,
      availableMemoryMB: 3072
    },
    // ...
  };
  
  await fetch(cloudUrl + '/api/v1/devices/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(profile)
  });
  
  // 定时续约
  setInterval(registerWorker, 30000);
}

registerWorker();
```

**预计工作量:** 2小时

---

### Task 8: 硬件能力精细化

**新文件:** `apps/harmony/scheduler/src/main/ets/state/HardwareProfileAdapter.ets`

**任务描述:**
读取设备更详细的硬件信息(CPU核心数/GPU可用性等)。

**预计工作量:** 3-4小时

---

## 🟢 P2任务 - 完善优化(可后续迭代)

### Task 9: 执行遥测反馈

实现任务执行完成后上报遥测,更新 `executionHistory`。

### Task 10: 网络拓扑实时测量

实现设备间带宽/RTT的定期探测。

### Task 11: 集成测试

接入一个非购物AI任务,验证端到端链路。

---

## 📊 验收检查表

完成所有P0任务后,执行以下验收:

### 基础功能验收

- [ ] Worker可成功注册并在云端查询到
- [ ] Phone定时上报画像,云端收到
- [ ] 购物任务调用新调度器,返回设备分配
- [ ] 调度日志显示baseline/suggestion/actual
- [ ] 设备TTL过期后自动从注册表移除

### 解耦性验收

- [ ] 删除 `REMOTE_CLOUD` 硬编码
- [ ] 新增AI任务(非购物)可成功调度
- [ ] 不同capability的任务路由到不同设备

### 统一性验收

- [ ] Phone/Worker/Cloud使用同一 `UnifiedDeviceProfile` 格式
- [ ] 所有设备通过 `UnifiedDeviceRegistry` 查询
- [ ] `WorkflowPlacementPlanner` 不区分设备来源

---

## ⚠️ 关键注意事项

### 1. 不要过度重构

**只修改核心链路,不要动不相关代码:**
- ✅ 修改设备注册、任务调度、购物流程
- ❌ 不要重构UI组件、日志系统、数据库schema

### 2. 保持向后兼容

**渐进式迁移,不要一次性替换:**
- 用环境变量控制新旧路径
- 新旧并行运行一段时间
- 对比结果无误后再删除旧代码

### 3. 避免写死业务逻辑

**错误示例:**
```typescript
// ❌ 不要这样写
if (capability === 'shopping.crop') {
  return 'use-phone';
} else if (capability === 'shopping.search') {
  return 'use-cloud';
}
```

**正确示例:**
```typescript
// ✅ 应该这样写
const devices = registry.getDevicesForCapability(capability);
return scheduler.selectOptimalDevice(devices, task);
```

### 4. 测试覆盖

每完成一个Task,至少写2个测试用例:
- 正常流程测试
- 边界条件测试(空设备列表/超时/设备离线等)

---

## 🔧 调试建议

### 查看设备注册状态
```bash
curl http://localhost:3100/api/v1/devices/capabilities/image.crop.v1 | jq
```

### 查看调度决策日志
```bash
# 在云端API日志中搜索
grep "PLACEMENT_DECISION" logs/api-server.log
```

### 手动触发设备注册
```bash
curl -X POST http://localhost:3100/api/v1/devices/register \
  -H "Content-Type: application/json" \
  -d @test-device-profile.json
```

---

## 📚 参考资料

- 重构方案详细文档: `docs/重构方案-统一调度架构.md`
- 原架构分析: `docs/24-复赛项目系统审查与调度架构详解-20261020.md`
- 源码索引: 文档末尾S01-S28引用
- 测试用例参考: `services/api-server/test/unit/*.spec.ts`

---

## 🆘 遇到问题时

1. **编译错误:** 检查TypeScript类型定义是否完整
2. **运行时错误:** 检查依赖注入是否正确
3. **逻辑错误:** 对照重构方案的设计意图
4. **性能问题:** 暂时接受,后续优化(P2任务)

**如有疑问,请回头查阅重构方案对应章节,不要凭空猜测。**
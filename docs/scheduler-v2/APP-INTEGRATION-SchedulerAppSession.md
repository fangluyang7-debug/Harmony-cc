# 鸿蒙 App 接入调度系统：SchedulerAppSession

`SchedulerAppSession` 封装在 `scheduler` HAR 中（`apps/harmony/scheduler/src/main/ets/v2/app/SchedulerAppSession.ets`）。App 引入后，就能自动接入调度系统，同时作为任务的**提交方**和**执行方**。

## 它做了什么

1. **获取应用身份**：首次进入前台时，调起「调度连接」App（`org.harmonycc.agent` 的 `EnrollmentAbility`）。用户点一次「允许并返回应用」后，凭据保存在本 App 内，之后每次启动自动恢复，不再询问。用户如果拒绝，会被记住，不会每次切回前台都弹窗。
2. **在本 App 进程内运行 NativeAgent**：手机既能提交任务，也能接收协调中心分配下来的子任务。
3. **跟随前后台**：App 在前台时，本机参与资源分配；退到后台时停止接单（鸿蒙会冻结后台进程），已经提交的任务由其他设备继续执行。

前提：设备上已安装「调度连接」App，并且已经和协调中心配对。

## 三步接入

### 1. 依赖

在 `entry/oh-package.json5` 里依赖 `scheduler` HAR（与 SoleAI、图片 App 相同）。

### 2. 声明能力并创建会话

```ts
import { SchedulerAppSession } from 'scheduler';

export const schedulerSession = new SchedulerAppSession({
  storeName: 'my-app-scheduler',            // 每个 App 唯一
  declaration: {
    label: '我的 App',                       // 显示在授权页
    allowedContracts: ['image.crop.contract'], // 允许提交的任务契约
    maxConcurrent: 2,
    resources: [{ resourcePoolId: 'cpu', amount: 4 }, { resourcePoolId: 'ram', amount: 1073741824 }],
    offlineBase: [],
    onlineExtra: [{ resourcePoolId: 'cpu', amount: 2 }, { resourcePoolId: 'ram', amount: 268435456 }],
  },
  // services: [...],   // 可选：本 App 在前台时额外提供的执行能力（NativeServiceAdapter）
  // autoEnroll: false, // 可选：不自动申请，改由 connect() 手动触发
});
```

### 3. 接入生命周期（EntryAbility）

```ts
onCreate()     { schedulerSession.initialize(this.context); }
onForeground() { schedulerSession.lifecycle(true); }   // 自动恢复或首次申请授权
onBackground() { schedulerSession.lifecycle(false); }
onDestroy()    { void schedulerSession.close(); }
```

## 提交任务

```ts
const sdk = schedulerSession.sdk();          // 未接入或已暂停时为 null
if (sdk) {
  const task = await sdk.submit({ ... }, { requestId, budgetMs: 30000, ... });
  const result = await task.result();
} else {
  // 走 App 原有的本机路径
}
```

建议始终保留原有的本机路径作为兜底，`sdk()` 返回 null 时直接使用。

## 其他接口

| 接口 | 用途 |
|---|---|
| `status()` / `onStatus(cb)` | 当前状态：`IDLE`、`CONNECTING`、`CONNECTED`、`PAUSED`、`UNAVAILABLE`、`DECLINED`、`NEEDS_AGENT`，附中文说明，可直接显示 |
| `isReady()` | 已连接，可以提交和执行任务 |
| `pause()` / `resume()` | 用户暂停或恢复协同（身份保留）；`resume()` 也可用于用户拒绝后重新授权 |
| `connect(true)` | 用户主动触发连接或重新授权 |
| `port()` | 已认证的控制端口，可访问 `/v2/apps/me`、`/v2/devices`、`/v2/display` 等 |
| `host()` / `deviceId()` / `holderId()` | 本 App 内的宿主及其身份 |

## 失败处理

- 网络错误或协调中心暂时不可达：保留身份，下次进入前台自动重试。
- 凭据被撤销、设备已离开空间、声明版本不匹配（传入了 `revision` 时）：清除身份，下次重新申请授权。
- 授权结果不确定（凭据交换中断）：不会重复注册，状态提示需要先在协调中心核对。

## 现有接入方

- **SoleAI**（`apps/harmony/entry/src/main/ets/services/CooperativeSession.ets`）已改为基于本组件实现，原来的「使用协同调度」开关改为「暂停 / 恢复」。
- **图片 App**（`imageprocessing` 分支的 `PhotoSession.ets`）实现了同样的机制，合并后可以改用本组件。

# main 分支修改记录

用途：记录在 `main` 分支上做的每一项修订，合并队友分支时对照取舍。新的修订追加到最上方。

- 基线提交：`82080d0`（Retire legacy desktop packaging and unify distribution entry）
- 未纳入本记录的本地改动（非本记录作者所改，未提交）：`scripts/prepare-harmony-distribution.cjs`、`scripts/start-coordinator-lan.cjs`、`services/coordinator/src/main.ts`、`提交文件/` 下的文件

合并时需特别注意的冲突点：
- `NativeAgent.ets` 的 `create()` 配对段、`connect()`、`tick()`、`adoptCeiling()`、`close()` 前新增的 `coordinatorGone()`
- `services/coordinator/src/spaces.ts` 的 `autoContribution` 预留比例（1/4 → 1/8）
- `apps/team-space-web/dispatch.js` 的 `renderMetrics` / `renderTopology` / `pool` 以及快照接收处的过滤

---

## 2026-11-11 · 通用 App 接入组件 SchedulerAppSession（第 2 次提交）

### 1. 新增 `SchedulerAppSession`（scheduler HAR）
- 新文件 `apps/harmony/scheduler/src/main/ets/v2/app/SchedulerAppSession.ets`，从 `v2/Index.ets` 导出。
- 把 SoleAI `CooperativeSession` 和图片 App `PhotoSession`（`imageprocessing` 分支）里重复的逻辑抽成通用组件：经调度连接 App 授权 → 凭据持久化 → 恢复 → 在本 App 进程启动 `NativeAgent` → 跟随前后台。
- 与原实现的差别：首次进入前台**自动**申请授权（拒绝会被记住，不重复弹窗）；只有确定的撤销才清除身份；新增 `pause()/resume()`、状态回调、`NEEDS_AGENT` 状态。
- 开发者文档：`docs/scheduler-v2/APP-INTEGRATION-SchedulerAppSession.md`。

### 2. SoleAI 改用该组件
- `apps/harmony/entry/src/main/ets/services/CooperativeSession.ets`：删除自带的授权、持久化、宿主管理代码，改为委托 `SchedulerAppSession`；对外接口（`setEnabled`、`client`、`capacity`、`preparePhoto` 等）和 AppStorage 键保持不变。preferences 文件名沿用 `cooperative-shopping-3`，已授权的用户无需重新授权。
- `setEnabled(false/true)` 语义改为暂停 / 恢复；`V2ImageSearchPage.ets` 开关文案改为「协同调度（自动接入，可暂停）」。

### 合并注意
- 图片 App 的 `PhotoSession.ets` 在 `imageprocessing` 分支，本次未改动；合并后建议改用 `SchedulerAppSession`（注意其 preferences 名为 `photo-app-v1`，迁移时沿用即可保留授权）。

---

## 2026-11-11 · 调度盘与设备连接（第 1 次提交）

### 1. 配对失败 `PAIRING_RECONCILIATION_REQUIRED` 永久卡死
- **现象**：一次配对请求失败后，同一协调中心再也无法配对。
- **原因**：`pairing-pending:<holder>` 标记只在 `SPACE_SWITCH_BUSY` 时清除，其他失败永久残留，且无对账实现。
- **修改**：
  - `NativeTransport.ets`：新增 `lastStatus`（HTTP 状态码；`-1` 表示请求确定未送达：解析失败 / 连接拒绝 / TLS 拒绝）。
  - `NativeAgent.ets`：只拦截"同一邀请"重试；换新邀请放行；4xx / 未送达时清标记；配对成功后清标记；旧版全局 `pairing-pending` 标记不再拦截。
  - `ConnectionLauncher.ets`：该错误码显示中文提示（请重新生成邀请）。
- **测试**：`tests/sdk/native-space-switch.test.cjs` 新增对应场景。

### 2. 曾配对过其他协调中心的设备无法配对（401 `PAIRING_REJECTED`）
- **原因**：设备把旧协调中心的设备 ID 作为 `previousDeviceId` 发送，新协调中心查不到即抛 `DEVICE_FORBIDDEN`，事务回滚，被统一包装成 401。
- **修改**：
  - 设备端 `NativeAgent.ets`：仅当旧身份证书指纹与本次邀请相同时才发送 `previousDeviceId`。
  - 协调中心 `device-membership.ts`：查不到的 `previousDeviceId` 忽略（与 `knownDeviceIds` 一致）；属于其他用户的仍拒绝。
- **测试**：`services/coordinator/test/device-membership.test.cjs`、`native-space-switch.test.cjs`。

### 3. 设备端贡献上限实时同步
- `NativeAgent.ets`：`/v2/device-settings` 轮询提前到控制通道就绪之前，每次 tick 都同步并采纳协调中心算出的上限。
- `adoptCeiling` 的持久化改为按协调中心作用域写入 `contribution:<holder>`、`identity:<holder>`（原先写入未分作用域的键，重启后读不到）。
- `error()` 日志附带原始错误信息，便于排查（不再只有 `NATIVE_AGENT_FAILED`）。

### 4. 内存自动预留比例 1/4 → 1/8（全部设备）
- `services/coordinator/src/spaces.ts` `autoContribution`：预留 = max(1 GiB, 总内存/8)。
- 示例：11.32 GiB 手机预留 1.41 GiB（原 2.83 GiB），上限约 9.9 GiB；8 GiB 设备预留 1 GiB、上限 7 GiB。
- 准入公式未改：`min(上限, 已占用 + max(0, 可用内存 − 预留))`（鸿蒙与 PC 调度件一致）。
- **测试**：`services/coordinator/test/spaces.test.cjs` 预期值按新规则更新。

### 5. 协调中心关闭后设备断开并清除配对
- 协调中心 `channel.ts`：`close()` 先向所有设备发送 WebSocket 关闭码 `4001 COORDINATOR_SHUTDOWN`，300 ms 后再强制断开。
- 设备端 `NativeAgent.ets`：收到 4001，或连续 20 秒确定连不上协调中心（`lastStatus === -1`），调用 `coordinatorGone()`：删除活动 `identity`（保留 `identity:<holder>` 历史供 `knownDeviceIds` 使用），停止宿主，状态显示"协调中心已断开，请重新配对"。
- `NativePlatform.ets`：新增 `NativeDatabase.delete()`。
- `AgentRuntime.ets`：注册 `onCoordinatorGone`，置 `agentPaired=false`，界面回到配对页。
- `ConnectionLauncher.ets`：配对页顶部显示断开提示。
- **注意**：网络中断超过 20 秒同样会清除配对。
- **测试**：`services/coordinator/test/channel.test.cjs` 新增 4001 用例。

### 6. 调度盘（`apps/team-space-web`）
- 快照新增 `paired` 字段（`telemetry-view.ts`：有凭据历史或当前有画像即为已配对）；前端过滤未兑换邀请产生的空壳设备（旧协调中心无该字段时不过滤）。
- 指标改名："设备规模"→"接入设备"（附在线/离线数），"有效画像设备"→"在线设备"；拓扑节点只显示"在线 · 可调度 / 离线"。
- 删除导航中的「购物协同」入口（`dispatch.html` 及 `dispatch.js` 对应链接设置；`shopping.html` 本身保留）。
- 资源卡片准入上限为 0 时注明原因：调度件在后台 / 过热·省电·低电量 / 设备端暂停接收 / 可用内存低于系统预留（`dispatch.js` `zeroReason`，样式 `dispatch.css .zero-reason`）。

### 7. 设备调度件界面
- 删除手机版和鸿蒙电脑版的「空间与调度盘」按钮（`pages/Index` 页面文件保留未删）。「结果展示」保留。

### 分发产物（不入库，仅供参考）
- `dist/调度系统分发-20261110-r2/01-Coordinator-Windows-x64/...` 已就地替换 `channel.js`、`device-membership.js`、`telemetry-view.js`、`spaces.js`、`dispatch.html`、`dispatch.js`、`dispatch.css`，原文件备份在包内 `.backup-20261111/`。
- `dist/调度系统分发-20261110-r5/03-Device-Agent-HarmonyOS/` 为最新设备调度件 HAP。

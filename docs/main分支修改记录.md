# main 分支修改记录

用途：记录在 `main` 分支上做的每一项修订，合并队友分支时对照取舍。新的修订追加到最上方。

- 基线提交：`82080d0`（Retire legacy desktop packaging and unify distribution entry）
- 未纳入本记录的本地改动（非本记录作者所改，未提交）：`scripts/prepare-harmony-distribution.cjs`、`scripts/start-coordinator-lan.cjs`、`services/coordinator/src/main.ts`、`提交文件/` 下的文件

合并时需特别注意的冲突点：
- `NativeAgent.ets` 的 `create()` 配对段、`connect()`、`tick()`、`adoptCeiling()`、`close()` 前新增的 `coordinatorGone()`
- `services/coordinator/src/spaces.ts` 的 `autoContribution` 预留比例（1/4 → 1/8）
- `apps/team-space-web/dispatch.js` 的 `renderMetrics` / `renderTopology` / `pool` 以及快照接收处的过滤
- `scripts/runtime-desktop.cjs` 的 `RuntimeControl`（`launch` / `startAgent` / 新增 `retirePairing` / `snapshot`）

---

## 2026-11-11 · 独显设备接入画像、照片包完整性、SoleAI 协同链（第 5 次提交）

对应队友报告 [WINDOWS-GPU-PHOTO-PACKAGE-DIAGNOSIS-20261111.md](scheduler-v2/WINDOWS-GPU-PHOTO-PACKAGE-DIAGNOSIS-20261111.md) 的 P1～P4 与风险 1，以及本分支核对出的 SoleAI 网关缺陷。`imageprocessing` 已是 `main` 的祖先（`715c3d5` 合并），以下文件在两分支完全一致，可整体 cherry-pick。

### 1. P2：显存额度随设备画像自动分配（协调中心 + Windows 调度件）
- **现象**：`host-main.ts` 只有在 `contribution.maxVramBytes > 0` 时才探测 GPU，而默认邀请是 `capacityMode: 'auto'` 且不带显存额度；`autoContribution` 只算 CPU/RAM。结果独显机即使装齐引擎也永远只报 CPU 执行器。
- **修改**：
  - `services/coordinator/src/spaces.ts`：`MeasuredCapacity` 新增可选 `vramBytes`（旧调度件不带该字段仍合法）；`autoContribution` 按上报显存减 256 MiB 得 `maxVramBytes`（不足 512 MiB 不分配；上报 0 则撤销原份额）；`deviceSettings` 的"未变化"判断加入显存。`capacityVector` 已有的 gpu/vram 池随之进入设备额度。
  - `services/pc-agent/src/host.ts`：`/v2/device-settings` 的 measured 带 `vramBytes`（= 已打开的 GPU 后端显存总量，没有 GPU 后端则 0）；旧协调中心返回 `MEASUREMENT_INVALID` 时自动退回 CPU/RAM 字段并记住（两端兼容）。采纳自动上限时同步 `maxVramBytes` 并写回 `contribution.json`。
  - `services/pc-agent/src/host-main.ts`：只要装有 Vulkan 引擎且（自动额度 或 固定额度已给显存）就探测 GPU；固定额度为 0 时输出 `PHOTO_GPU_NOT_CONTRIBUTED`。探测成功输出 `PHOTO_GPU_READY: VULKAN device N, <MiB>`。
- **语义**：设备先探测 GPU → 上报显存 → 中心确定份额 → 设备采纳；"有显卡"不等于"有份额"，份额只在 GPU 引擎真正打开后出现，调度盘不会出现无执行器的 GPU 额度。固定额度模式下用户"不共享显卡"的设置照旧生效。

### 2. P4 / 风险 1：双显卡选择与可区分的失败原因
- `services/pc-agent/src/photo-accelerator.ts`：新增 `parseVulkanDevices()`、`selectVulkanDevice()`。先跑一次参考推理拿到 Vulkan 设备列表，选出名称与 `nvidia-smi` 匹配的索引（不再假设 0 是独显）；若与当前索引不同则在选中的设备上重跑参考推理，再做质量阈值判断。显式 `HARMONY_PHOTO_GPU_ID` 必须本身就是 NVIDIA 设备。
- 失败原因拆分：`PHOTO_GPU_RUNTIME_MISSING`（无引擎文件）、`PHOTO_GPU_DRIVER_MISSING`（nvidia-smi 不可用）、`PHOTO_GPU_DEVICE_UNMATCHED`、`PHOTO_GPU_MEMORY_TOO_SMALL`、`PHOTO_GPU_PROBE_FAILED`、`PHOTO_GPU_QUALITY_FAILED`；`host-main.ts` 对每种给出中文可读处理建议。
- **测试**：`services/pc-agent/test/photo-accelerator.test.cjs`（集显为 0、独显为 1 的日志选 1；显式 0 拒绝）。

### 3. P1 / P3：照片运行库打包不再静默漏包
- 新增 `scripts/lib/photo-runtime-package.cjs` `stagePhotoRuntime()`：校验模型三件（param/bin/manifest）、CPU runner、Vulkan EXE 均存在；Vulkan EXE 放到 `dist/photo/vulkan/` 并携带同目录全部 DLL（必须含 `vcomp140.dll`，不带驱动提供的 `vulkan-1.dll`）；缺任何一项抛 `PHOTO_RUNTIME_INCOMPLETE`。
- `scripts/prepare-harmony-distribution.cjs`：未设置 `HARMONY_PHOTO_RUNTIME` 时**默认失败**（`PHOTO_RUNTIME_REQUIRED`）；显式 `HARMONY_PHOTO_RUNTIME_OPTIONAL=1` 才允许生成不含照片运行库的 02 包，并在包根写 `PHOTO-RUNTIME-NOT-INCLUDED.txt`、在 `00-使用说明.md` 标明。02 包 README 增加照片/GPU 说明。
- **测试**：`scripts/photo-runtime-package.test.cjs`。

### 4. Windows 调度件界面
- `scripts/runtime-desktop.cjs` `deviceStatus()` 返回 `vram`、`capacityMode`；`apps/runtime-desktop/agent.html` 贡献上限新增"显存"；`desktop.js` 未探测前显示"启动后探测"、运行中无 GPU 引擎显示"无 GPU 引擎"。`capabilities/capability-hints.json` 的 `photo.enhance.v1` 安装提示同步更新。

### 5. SoleAI 协同链实际不会触发（本分支核对发现）
- **现象**：`AiTaskGateway.ets` 调 `plan('shopping.image')` / `plan('shopping.text')`，而 `CooperativeSession.ets` 声明的工作流 id 是 `shopping.photo.prepare` / `shopping.compare` / `shopping.photo.match`，一个都不匹配，`nodes` 永远为空；前缀列表里的 `image.quality.v1` 也没有能力包。于是图片链永远走本机，报告只显示"部分协同"。
- **修改**：`searchImage` 改用声明中的 `shopping.photo.prepare`，可调度前缀为 `['image.crop.v1']`；`plan()` 对未声明的工作流直接返回 `LOCAL`（不再出现零节点的 PARTIAL）；`searchText` / 会话操作本来就没有声明工作流，现在如实显示本机模式。
- 两个分支的该文件完全一致；`CooperativeSession.ets` 在 `main` 上已改用 `SchedulerAppSession`，manifest 部分未动。

### 6. 鸿蒙侧
- 鸿蒙调度件本轮无代码改动（设备只贡献 CPU/RAM，没有 GPU/NPU 执行器，这是现状不是本轮回退）。`NativeAgent.ets` 的 `MeasuredCapacity` 不带 `vramBytes`，协调中心按"未知"处理，不影响手机额度。
- SoleAI HAP（04）因网关修改需重新构建；设备调度件 HAP（03）沿用 r5（与 `.test/s2-harmony-agent` 产物 SHA-256 一致）。

### 7. 验证
- 新增 `services/coordinator/test/auto-contribution.test.cjs` 3/3、`services/pc-agent/test/photo-accelerator.test.cjs` 3/3、`scripts/photo-runtime-package.test.cjs` 2/2；`scripts/runtime-desktop(.integration).test.cjs` 6/6；pc-agent `system-resources` / `profile-publisher` / `photo-profile` 通过；coordinator、pc-agent `tsc` 通过。
- `services/coordinator/test/spaces.test.cjs` 的"paired CPU host"用例在本机 180 秒超时，**改动前基线同样超时**（本机没有照片/视觉原生运行库，宿主能力无法全部 ACTIVE），与本次修改无关；其余两例通过。
- 本机没有 `nvidia-smi` 和 `.test/photo-tools`，GPU 路径只做了单元级验证；独显真机验收待队友在装有运行库和 NVIDIA 驱动的机器上完成，验收口径见 §5 与诊断报告第 6 节。

### 8. 分发产物
- 按用户要求直接替换 `dist/调度系统分发-20261110-r2/` 内容（`SHA256SUMS.txt` 已重算）：01 协调中心、02 Windows 调度件、03 鸿蒙调度件（HAR 与 HAP 均重编，包含 `715c3d5` 合并进来的队友改动；此前 r5 的 03 HAP 构建于合并之前）、04 SoleAI（含签名包）、05 图片 App（未签名，`harmony-photo --har`；本机无 HARMONY_NCNN_DIR / 模型，手机本地增强仍是桩实现，与 r5 相同）。鸿蒙构建顺序：`harmony-v2-build.cjs` → `harmony-v2-app-build.cjs <app> --har`；SoleAI 不带 `--har` 会因跨模块相对导入失败。本机无照片运行库，02 以 `HARMONY_PHOTO_RUNTIME_OPTIONAL=1` 构建，包根带 `PHOTO-RUNTIME-NOT-INCLUDED.txt`。
- **需要队友在有 `.test/photo-tools/runtime.json` 的机器上重打 02 包**：`HARMONY_PHOTO_RUNTIME=.test/photo-tools/runtime.json HARMONY_ELECTRON_DIST=<electron dist> node scripts/prepare-harmony-distribution.cjs 调度系统分发-20261110-r3`（或任意新目录）。脚本会校验模型、runner、Vulkan EXE 与 `vcomp140.dll`，缺一失败。
- Electron 运行时本机以 r2 协调中心包还原为 `dist/electron-44.7.2-win-x64/`（不入库）。

---

## 2026-11-11 · Windows 设备调度件：残留旧配对时可直接重新配对（第 4 次提交）

- **现象**：设备目录残留旧配对（或未完成的配对）时，输入新协调中心的配对码报"安装目录已存在，请恢复该设备或选择新目录；不覆盖账本"，无法配对。
- **修改**（`scripts/runtime-desktop.cjs` `pair()`）：在兑换一次性配对码之前先判断：
  - 目录是同一协调中心（证书指纹相同）的配对 → 提示"本机已与该协调中心配对，请直接打开设备调度件电源"，不消耗配对码；
  - 目录是其他协调中心的配对，或只有 `pairing.pending` 的未完成配对 → 配对码兑换成功后，把旧目录改名为 `<目录>.retired-<时间>`（账本保留），再继续配对；兑换失败则不动旧目录；
  - 不是设备安装目录（没有 `agent.json` / `pairing.pending`）→ 仍按原逻辑拒绝。
  - 新增辅助函数 `pairingTarget()`、`deviceInstallation()`。
- **测试**：`scripts/runtime-desktop.test.cjs` 新增用例；`runtime-desktop.integration.test.cjs` 通过。
- **分发产物**：Windows 设备调度件 zip 与协调中心包内的 `runtime-desktop.cjs` 已直接替换，`SHA256SUMS.txt` 已更新。

### 鸿蒙版同类问题：旧协调中心不可达时无法切换到新协调中心
- **现象**：鸿蒙设备调度件已有配对时，配对新协调中心要先 `closeForSwitch()`；旧账本里有未结算任务或正在连接时抛 `SPACE_SWITCH_BUSY`。旧协调中心已关闭时这些任务永远无法结算，配对新协调中心被永久阻塞。
- **修改**：
  - `NativeAgent.ets`：`closeForSwitch(abandon=false)`，`abandon` 时只等待 3 秒并跳过未结算检查直接关闭（按 holder 作用域的账本保留在本地）；新增 `coordinatorFingerprint()`。
  - `AgentRuntime.ets`：目标协调中心证书指纹与当前不同、且当前未连接时，以 `abandon` 方式切换；旧协调中心仍在线或是同一协调中心时，未结算任务照旧拒绝切换。
- **测试**：`tests/sdk/native-space-switch.test.cjs` 新增对应断言。
- **分发产物**：`dist/调度系统分发-20261110-r5/03-Device-Agent-HarmonyOS/` HAP 已更新，并已安装到手机。

---

## 2026-11-11 · Windows 设备调度件：协调中心关闭后断开并清除配对（第 3 次提交）

- **现象**：新 Windows 设备保留旧配对，协调中心换 IP 或关闭后无限重试，日志刷 `CPU_HOST_IO_ERROR:EHOSTUNREACH / ECONNREFUSED`，看不出原因，也无法直接配对新协调中心。
- **修改**：
  - 新增 `services/pc-agent/src/coordinator-gone.ts`：`CoordinatorGoneDetector`。收到关闭码 4001（`CHANNEL_CLOSED_4001_*`），或连续 20 秒确定不可达（`ECONNREFUSED` / `EHOSTUNREACH` / `ENETUNREACH` / `ENOTFOUND` / `EADDRNOTAVAIL`，中间静默超过 8 秒则重新计时）即判定协调中心已断开；超时（`ETIMEDOUT`）不计入。
  - `services/pc-agent/src/host-main.ts`：判定后输出 `COORDINATOR_GONE`，停止宿主，退出码 3。
  - `scripts/runtime-desktop.cjs`：看到 `COORDINATOR_GONE` 后，进程退出时把设备目录改名为 `<目录>.retired-<时间>`（保留账本，不删除），快照增加 `coordinatorGone`；下次启动清除该标记。
  - `apps/runtime-desktop/desktop.js`：收到 `coordinatorGone` 后回到发现页，提示"协调中心已关闭，本机已断开并清除配对"。
- **注意**：网络中断超过 20 秒也会清除配对，需要重新配对。
- **测试**：新增 `services/pc-agent/test/coordinator-gone.test.cjs`；`scripts/runtime-desktop.test.cjs` 新增清除配对用例。
- **分发产物**：已就地更新 `dist/调度系统分发-20261110-r2/02-Device-Agent-Windows-x64/02-Device-Agent-Windows-x64.zip`（直接替换，未保留旧包），并更新 `SHA256SUMS.txt`；协调中心包内同步替换 `runtime-desktop.cjs`、`desktop.js`（备份在 `.backup-20261111/`）。

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

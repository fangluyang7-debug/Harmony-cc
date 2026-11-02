# Harmony 只读调度盘

正式页面源码为 [`apps/team-space-web/dispatch.html`](../../apps/team-space-web/dispatch.html)，样式与数据逻辑分别在同目录的 `dispatch.css`、`dispatch.js`、`dispatch-view.mjs`。协调者访问路径为 **`/dispatch.html?space=<空间 ID>`**，也可登录后在页面中选择空间。

原 [`调度盘/code.html`](../../调度盘/code.html) 已改为入口说明，移除旧产品名称与固定硬件数字；[`调度盘/DESIGN.md`](../../调度盘/DESIGN.md) 保留为视觉参考。新页面沿用石墨底色、青色强调色以及 Inter / JetBrains Mono 字体栈，未引入 CDN 脚本或在线字体依赖；未安装对应字体时使用系统字体回退。

## 启动与入口

在仓库根目录安装和构建现有协调者及 PC 代理：

```powershell
npm ci
npm run conformance:build
```

按 [局域网协调者说明](LOCAL-COORDINATOR-20261031.md) 启动。以下 IP 必须替换成协调者本机网卡的实际 IPv4：

```powershell
npm run coordinator:lan -- 192.168.1.20 7443
```

该启动器已经将 `COORDINATOR_WEB_DIR` 设置为 `apps/team-space-web`，并执行数据库迁移。手动启动现有协调者时，将该变量指向此目录的绝对路径即可，不需要另建网页服务器。

1. 通过已有控制台登录，创建或加入空间。
2. 进入空间，在右上方点击“只读调度盘”；VIEWER 也可进入。
3. 在调度盘中选择任务，查看持久化决策和有权读取的阶段追踪。

直接以 `file://` 打开 HTML 不能读取已认证的协调者数据。调度盘没有登录、创建成员或提交任务的新流程，这些操作继续使用现有控制台与 SDK。它不自动创建示例设备、任务或“演示指标”。

## 数据来自哪里

| 面板 | 只读数据来源与展示范围 |
| --- | --- |
| 设备与执行目标 | 当前空间的 `SpaceDevice`、`DeviceDirectory.profiles()` 和能力资格记录；包括未在网页登记、但已有正式画像的 SDK 宿主；同一物理设备按 holder 分别显示 |
| 资源占用与排空 | 画像中的各资源池、当前空间的额度 grant / ack / reserved；协同槽位与任务占用不冒充整机利用率，多个 holder 的物理总量不重复相加 |
| 网络状态 | 既有 `DirectTransfers.dashboard()` 的每宿主 L0–L3 分级、成对探测与 TTL，以及方向开销/带宽拟合；没有证据时显示 UNKNOWN，不能从拓扑连线推定直连成功 |
| 直传记录 | 当前空间 `TransferAuthorization` 的状态、方向、字节数和端点设备；COMPLETED 表示端点已确认；不返回签名、proof 或凭据 |
| 调度决策 | `CpuJob` 中已保存的 plan、快照/策略版本、目标、原因、基线与所选成本、候选拒绝码；全部成本明确标为规划估计；页面不调用规划器重新排序 |
| 任务追踪 | 复用 `TraceService.read()` 的跨度和分析结果；沿用原有 principal reader 范围，非授权任务返回 403；同域按 `startMono` 排序，不比较跨设备绝对时间 |
| 异常与恢复 | 当前记录窗口的拒绝、失败、未知状态、YieldNotice 与资源结算状态；备份执行、故障改派暂按 S6“尚未接入”显示 |

每份快照带 `domain` 和 `updatedAt`。SIMULATED 数据域在顶部明确提示。未知、无效、未来或过期的 sample 不显示为 0；真实的 0 会保留。温度单位为 `level` 时显示“级”，不会转换成摄氏度。样本的来源在资源池或指标提示中保留。

当前只持久化了基线、所选方案与拒绝信息，没有完整的全候选成本表，因此缺少的备选成本继续显示 UNKNOWN。完整端到端与完整关键路径仍缺来源 SDK 起讫根跨度；即使现有分析器认为某一小组 span 结构完整，也不能据此报告提交至结果的耗时。接口的 `coverage.sourceSdkRoot` 当前明确为 false，阶段实测区间仍正常展示。

## 接口与刷新

| 接口 | 行为 |
| --- | --- |
| `GET /v2/spaces/:spaceId/telemetry` | 返回授权空间的只读投影，最多显示最近 100 条执行记录；不返回输入、结果内容、原始 offer 参数或传输凭据 |
| `GET /v2/spaces/:spaceId/telemetry/traces/:jobId` | 取得该执行记录的授权追踪；无跨度时返回等待证据，权限不足返回 403 |
| `GET /v2/spaces/:spaceId/events` | 复用已有 SSE 失效提示；收到 changed 后重新读取快照 |

认证使用已有 HttpOnly 会话 cookie 和空间成员检查；接口发送 `Cache-Control: no-store`。没有数据写入、App 自动注册、额度签发、规划或派发操作。没有新增提交按钮。

除了 SSE，前台每 15 秒做一次快照校对以刷新 TTL、追踪晚到区间与遗漏事件；这是显示层校对，不是任务领取或派发轮询。重新进入页面或切换空间时重新读取授权快照。事件断开、快照失败会明确提示；读取失败后保留的内容标为历史快照，401/403 会清除当前数据。

实现入口：[`telemetry-view.ts`](../../services/coordinator/src/telemetry-view.ts) 只读投影，由 `spaces.ts` 的已有会话边界接入，`app.ts` 完成依赖装配；没有改变 PlanningService、代理执行或额度续租逻辑。

## 计划测试拓扑

下面是后续搭建建议，**不是已连接设备清单或验收结果**：

| 设备 | 分工 | 准备事项 |
| --- | --- | --- |
| PC-A | 局域网协调者与浏览器调度盘 | Node.js 22、npm、OpenSSL、稳定局域网地址；不要求独立显卡。未启动代理并上报画像时，不自动算作执行资源 |
| PC-B | 计算终端；显卡放在此机 | 运行正式配对的 PC 代理，贡献上限由所有者设置；GPU 目标/指标只有实际采集、注册并满足相应条件后显示，不能因机器装有显卡就补造数值 |
| 手机 / 平板 | 后续 SDK 来源与执行终端 | 画像未到位显示 UNKNOWN；真机待验，模拟器相关测试继续遵守 STATUS 中的暂停安排 |

当前网页不要求 PC-A 安装 CUDA。GPU 执行能力和真实性验收仍按相应 S7 工作包进行，不能由调度盘替代。两台 PC 的直连、中转和网络退化须由 S5 的真实探测及传输记录验证。

## 验证与当前范围

本轮验证、已知问题及下一步统一记录在 [STATUS.md §32](STATUS.md)。页面属于用户要求先行搭建的 E2 最小只读预接入，不代表 E1/E2 或 S5 完整验收通过。S5 额度续租/派发竞争继续保留；本轮未修复该问题，未重跑其最终全量，没有修改鸿蒙代码、启动模拟器、进行真机/GPU/双物理设备验收或更新 Railway。

相关接口、会话和显示语义测试可运行：

```powershell
npm run conformance:build
Push-Location services/coordinator
node --test --test-concurrency=1 test/telemetry.test.cjs test/space-events.test.cjs test/spaces.test.cjs test/direct-transfers.test.cjs
Pop-Location
npm run architecture:deps
```

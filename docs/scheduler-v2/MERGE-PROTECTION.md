# 图片演示与调度中心：修改记录和合并保护清单

最后更新：2026-11-11。本文是双方合并时持续维护的入口，不是一次性的性能报告。后续修改请更新对应功能编号、文件位置、验证结果和提交基线；可以重构实现，但必须保留下面的用户行为与接口语义。

**新增待处理问题（仅诊断，未改代码/重打包）**：[Windows 独显照片节点分发包排查](WINDOWS-GPU-PHOTO-PACKAGE-DIAGNOSIS-20261111.md)。已确认用户 ZIP 缺少模型与 CPU/GPU 引擎，普通邀请缺显存额度；现用打包脚本还需处理 GPU DLL。后续合并不能把“有 GPU 代码”当作“交付包已具备 GPU 能力”，须完成报告中的整包及独显真机验证。

## 1. 本次交付基线

- 集成来源分支：`origin/imageprocessing`。
- 本轮优化代码、测试及性能证据提交：[`52f58656eb630c8cb76d32ef7b00f92deb4f207d`](https://github.com/fangluyang7-debug/Harmony-cc/commit/52f58656eb630c8cb76d32ef7b00f92deb4f207d)。本文随其后的文档提交交付，接续时应取包含本文的分支最新提交。
- 本轮优化之前的基线：`cee4fa3`。`52f5865` 仅是本轮增量，**不能单独 cherry-pick 到缺少图片 App、原生宿主或新版中心集成的旧分支上**。
- 已在历史中整合协作者新版协调中心，包括 `82080d0`、`5c0bb11`；`c4e8bcd` 是图片业务与新版中心、单空间设备生命周期的集成提交。继续保留新版中心的前后端和 EXE 启动方式，不恢复旧控制中心。
- 关键前序提交：`7a3a1fa` 独立图片 App；`9ef3112` 中心迁移后的授权恢复及反馈；`a9e960d` 本机/协作统一原生界面；`637cbc8` 仅展示连接持久恢复。
- 不修改协作者的工作分支。本次交付目标只是 `imageprocessing`，由协作者在自己的集成分支合并。

**旧文档说明**：`HANDOFF-PHOTO-DEMO-20261110.md` 中“在调度 App 内进入图片工作台”“单机是联网编排”的操作属于历史版本，不能作为当前产品行为。本机真正独立处理、独立图片 App、统一电脑展示页以本文及 STATUS §113～§118 为准。规格阅读顺序仍按 README 执行。

## 2. 必须保留的产品行为

路径均相对于仓库根目录；不要从 `.test` 中的生成工程反向覆盖源码。

| 编号 | 合并后必须保留的效果 | 主要源码位置 |
| --- | --- | --- |
| P01 三个独立 App | 调度连接 App 管接入、贡献和业务授权；图片 App 与 SoleAI 是同级业务 App。图片业务不能重新塞回调度 App，也不能复用 SoleAI 的身份、包名或签名。 | `apps/harmony-agent/`；`apps/harmony-photo/`；`apps/harmony/` |
| P02 图片独立可用 | 没有空间、未授权、协调中心关闭时，图片 App 仍可选图并在手机本机增强。联网协调不能成为进入图片首页或本机处理的前置条件。 | `apps/harmony-photo/entry/src/main/ets/pages/Index.ets`；`apps/harmony/scheduler/src/main/ets/v2/host/executors/PhotoLocal.ets` |
| P03 一套原生操作页 | 本机与协作使用同一选图、开始、进度、结果和保存界面。授权后只更新模式/连接反馈，保留已选照片，不跳回旧 WebView 工作台；图片不能横向溢出、底部按钮不能遮挡结果。 | 图片 App `pages/Index.ets`、`PhotoSession.ets`、`PhotoBatch.ets` |
| P04 主动保存图库 | 成品先存 App 私有目录，逐张提供保存按钮；只有用户点击后写入相册。不得恢复处理完成自动保存。 | 图片 App `PhotoFiles.ets`、`pages/Index.ets` 的系统 SaveButton |
| P05 仅展示连接 | 手机不加入空间也能向电脑同步选图、实际进度和结果。该连接只传展示事件，不注册计算设备、不赋予电脑派发/计算身份。展示故障不能使手机本机处理失败。 | 图片 App `PhotoDisplay.ets`；`scripts/photo-display-server.cjs`、`photo-display-records.cjs` |
| P06 重启恢复与清空 | 仅展示连接在 App 重启后恢复，界面显示连接/失败状态；电脑“清空”使旧展示连接码失效并等待重连。清空展示不能删除协调中心任务回执、设备身份或正在计算的任务。 | `PhotoDisplay.ets`；`photo-display-server.cjs` 的 `/reset`、持久化状态及 generation；`apps/team-space-web/photo-display.js` |
| P07 统一电脑展示 | 同一电脑展示页容纳手机本机和多设备协作轮次、对比完成耗时；跟随新版中心当前空间，不要求用户每次填空间 ID。保留左右原图/成品布局、实际完成后逐张出现的成品，以及实时任务规划与设备分工。标题“真机任务演示”，主要统计在完成后呈现。 | `apps/team-space-web/photo-display.html/.css/.js`、`photo-display-compare.mjs`；`scripts/photo-display-coordinator.cjs`；现有 `photo.html/.css/.js`、`photo-gallery.mjs` 的业务观察组件 |
| P08 新版中心与便捷接入 | 使用新版 Windows 协调中心/执行器启动程序及鸿蒙原生调度连接页；保留扫码和短码配对、电脑 App 启动执行器。设备配对码与“仅展示连接码”含义不同，不得互换。 | `apps/runtime-desktop/`；`scripts/runtime-desktop.cjs`、`runtime-device-binding.cjs`；`apps/harmony-agent/entry/src/main/ets/pages/Index.ets`；`docs/scheduler-v2/DEVICE-PAIRING-CODE.md` |
| P09 同设备只在一个空间 | 保留跨中心/空间稳定的设备身份、单空间约束及切换时旧绑定处理。不得只在界面隐藏其他空间，服务端和设备身份约束也必须保留；不得为绕过检查生成一个新设备 ID。 | `services/coordinator/src/spaces.ts`；`scripts/runtime-device-binding.cjs`；鸿蒙原生宿主接入/切换逻辑；STATUS §113 |
| P10 业务授权与恢复 | 设备已入空间不等于业务 App 已授权。保留独立 App 注册、授权回传、恢复连接、旧中心失效后的重新授权及可见状态；不能出现授权完成却没有反馈。未结算任务先处理再换绑。 | `apps/harmony-agent/entry/src/main/ets/entryability/EnrollmentAbility.ets`、`pages/Enrollment.ets`；图片 App `PhotoSession.ets`；`services/coordinator/src/apps.ts` |
| P11 统一真实调度 | 图片任务依旧通过 SchedulerSdk → 工作流 → CpuJobs / PlanningService；展示页只观察，不新增直派入口。规划、目标设备和完成状态取实际记录，不能为展示预设“手机做 A、电脑做 B”。 | 图片 App `PhotoWorkflow.ets`、`PhotoBatch.ets`；`services/coordinator/src/workflow-jobs.ts`、`cpu-jobs.ts`、`photo-runs.ts` |
| P12 真实效率与完整结果 | 输入来自手机当次选择，模型可预装，任务素材/成品不得预先放到其他执行器来冒充计算。以完整批次端到端时间比较；逐图交付校验、唯一尝试、剩余预算、取消结算均保留。实际同时计算的证据是两端执行回执，不是页面显示“在线”。 | SDK、照片各执行器、任务追踪、`PhotoBatch.ets`；本轮性能 MD / JSON |

P07 的“实时”指根据真实任务状态刷新，不是播放预排动画；P05 与 P10 是两种不同连接。单机演示不应被再次改造成“先加入协调中心、然后把设备固定为手机”的联网基线。

## 3. 本轮新增修改：合并冲突时逐项检查

| 编号 | 文件 | 必须保留的实现语义 |
| --- | --- | --- |
| M01 资源策略 | `services/coordinator/src/spaces.ts` / `autoContribution` | 自动系统内存余量为 RAM 的 1/16、限定 256 MiB～1 GiB；专用 CPU 上限为逻辑线程 3/4，其他模式一半。继续遵守实际可用内存和用户固定配置。不要恢复按 RAM 1/4 预留，导致已连接电脑无法通过能力验证。阈值可依据实测改进，不能无证据回退。 |
| M02 原生输入共用 | 图片 App `PhotoSession.ets`；scheduler `v2/host/NativeAgent.ets` | `sdkPort()` 共享原生宿主输入存储，`workflowPort.stageInput` 必须委托给它；不能重新建立一个没有本地输入存储的独立 SDK Port。 |
| M03 来源本地输入 | 图片 App `PhotoBatch.ets` | 提交使用 `inputLocation: 'ORIGIN'`、`resultDestination: 'ORIGIN'`；与 M02 一起保留，不能只保留一个选项却丢失对应数据通路。 |
| M04 按边留存 | `services/coordinator/src/workflow-jobs.ts` | 保留 `retainableOutput`：线性消费者允许执行端留存，直接进入 fan-in 的产物仍需物化；混合 fan-in + 线性消费者也不能丢掉合并所需副本。最终结果仍可由展示端取得。不要再次对整图启用 forceRelay。 |
| M05 图推进成本 | 同上；`retention.ts` | 不在每次图推进前后同步做全历史清理；已派发节点不重复 start。清理定时器、交付通知及恢复仍保留。 |
| M06 授权合并请求 | `cpu-jobs.ts`；`NativeAgent.ets` | 授权响应返回已经检查的 qualification，原生宿主优先使用，旧中心缺少字段时回退查询；ADMIT 计时包含授权。必须两端兼容，不能强制旧版本字段存在。 |
| M07 Windows 推理 | `scripts/prepare-photo-runtime.cjs` | 默认使用运行时检测的 AVX/AVX2/FMA CPU 构建；保留 scalar 对照与模型校验。分发包必须实际携带新 runner，不能源码改了而 ZIP 仍带旧标量库。 |
| M08 展示查询 | `photo-runs.ts`、`dashboard-history.ts` | 只取当前批次尝试的追踪数据，并按 attempt 索引；不能恢复整个空间历史的 JS 全量解析与每节点扫描。 |
| M09 缓存所有权查询 | `retention.ts` | 只为实际缓存对象查询相关任务/尝试；仍保留未结算、剩余分支、有效传输和未确认最终结果，不以性能优化为由提前删除。 |
| M10 App 额度 N+1 | `services/coordinator/src/apps.ts` / `reserveJob` | 同一个准入事务内关联查询当前占用，避免每次遍历所有历史任务再逐个查两张表；已过期但未结算的尝试仍占额度。历史不清空，跨安装共享 App 配额语义不改变。 |
| M11 真实配置显示 | `apps/runtime-desktop/desktop.js` | Windows 页面刷新执行器当前配置，不再永久显示初次邀请的 2 CPU / 1 GiB。展示上限与当前实际使用量应区分。 |

上述改动横跨手机宿主、业务 App、中心、执行器及打包脚本。不要用整文件“采用 ours/theirs”解决冲突；逐个功能块整合，保留协作者新版中心的其他功能。改名或迁移文件时，把本文路径同步更新。

## 4. 合并方式与最小验证

在协作者自己的集成分支执行；先保留其尚未提交的工作：

```bash
git fetch origin
git merge origin/imageprocessing
git merge-base --is-ancestor 52f58656eb630c8cb76d32ef7b00f92deb4f207d HEAD
```

最后一行成功表示基线历史已包含，不代表冲突解决正确。若选择 squash 或逐项移植，需另记录来源范围并逐项验证 P01～P12 / M01～M11，不能只看命令是否成功。

合并后构建中心、PC 执行器、共享 SDK / HAR 和图片 HAP，确保安装的是本轮构建产物。仓库使用 Node ≥22；环境和依赖准备见 README。本轮相关的定向回归命令如下，**工作目录必须正确**：

```powershell
# 仓库根目录，先完成依赖和构建
npm run conformance:build
npm run sdk:test
npm run architecture:deps
node --test tests/sdk/native-photo-session.test.cjs tests/sdk/native-photo-batch.test.cjs tests/sdk/native-photo-local.test.cjs tests/sdk/native-photo-files.test.cjs tests/sdk/native-photo-display.test.cjs tests/sdk/photo-display-unified.test.cjs

# coordinator 的测试辅助脚本依赖此工作目录
Push-Location services/coordinator
try {
  node --test test/apps.test.cjs test/spaces.test.cjs test/photo-batch.test.cjs test/photo-workflow.test.cjs test/retention.test.cjs test/workflow-reassign-process.test.cjs
} finally { Pop-Location }
```

真实神经网络回归需要先按 `PHOTO-WORKFLOW-LOCAL-20261110.md` 安装运行库/模型；没有模型而 skip 不算真实推理通过。API 22 为统一开发基线，本机此轮使用显式 API 24 SDK/签名；分别记录构建与设备验收，不能互相替代。

手动合并验收顺序：

1. 手机未入空间、中心关闭：图片 App 可选图、增强，结果不自动进相册，保存按钮可用。
2. 仅连接电脑展示屏：显示手机选图、真实进度、逐张成品；电脑不执行任务。重启 App 后连接恢复；电脑清空后旧码失效，手机重新连接正常。
3. 新版 Windows App 创建空间，手机扫码、电脑短码接入；尝试给同设备加入另一空间，单空间约束仍生效。
4. 图片 App 首次授权，返回后界面保持原有布局和照片，连接反馈明确；旧地址失效时可以重新授权当前中心。
5. 同六张图再跑协作：使用同一电脑展示页，规划/目标/回执实时更新，结束后出现耗时对照；核对两端实际执行和全部结果。
6. 切换空间、取消或重连后检查旧任务的结算与结果，不出现重复计算、错误复用旧权限或丢失已完成成品。若没有对应设备，明确标记待验，不能用本地单进程代替真机结论。

## 5. 性能事实、已撤回实验和分发边界

同六张 192×128、Real-ESRGAN x4plus、180 秒预算：优化前 147.232 秒（当时实际全由手机执行）；本次手机本机 70.789 秒；最终双机两轮 87.089 / 88.990 秒。两轮均六张成功、66 个唯一尝试提交，两端均实际增强计算。相比旧链路约减少 40% 耗时，**仍未证明双机快于手机**。完整轮次、哈希、计时口径见 [性能记录](PHOTO-OPTIMIZATION-20261111.md) 和 [精简证据](PHOTO-OPTIMIZATION-20261111.json)。

“独立工作流并行推进”和“资源不足时零等待重试”实验未证明收益，已撤回；不要从临时测试代码恢复它们。当前仍保留原来的控制推进一致性。后续重点是轻量阶段控制与账本成本、执行端多输入合并、实际成本估计；不是清空历史、降低手机配额或预热任务结果。

本轮已通过 App 额度回归 6/6、最终照片工作流/空间回归 9/9，以及之前记录的 SDK、原生适配、缓存/追踪/恢复回归。API 24 手机 HAP 已安装真机验证；模拟器曾返回 `EMULATOR_COMMAND_FAILED`，未通过。鸿蒙电脑、NVIDIA GPU 和 API 22 本轮没有新增真机验收。

**GitHub 源码更新不等于旧安装包更新**：本机已安装目录和图片 HAP已更新，但旧 `dist/调度系统分发-20261110-r2` 的 Windows ZIP 仍是旧包，不能用于复现本轮优化。重新运行正式 `scripts/prepare-harmony-distribution.cjs`，通过 `HARMONY_PHOTO_RUNTIME` 指向新构建的运行库，并按协作者的 SDK/设备签名重新构建 HAP。不能复制本机证书、凭据、空间数据库、调试账本到发行包。

`.test`、本地运行库和签名、旧分发目录没有随本次源码提交上传；`output/` 中已有的样例图片/海报也不属于本轮代码修改，保持原样。需要二进制交付时另行构建并发布，记录源码提交和包校验值。

## 6. 后续维护记录

| 日期 | 提交 / 范围 | 修改与保留要求 | 验证 |
| --- | --- | --- | --- |
| 2026-11-11 | `52f5865` 及本文后续文档提交 | 新增 M01～M11；汇总既有 P01～P12，明确新版中心与独立业务 App 的边界 | 两轮真实 Wi-Fi 双机完成；仍未达到单机提速目标 |

后续每次双方整合时追加一行。若要改变任一 P 编号对应的用户行为，先说明替代方案和验证结果；若只是重构，保留行为并更新路径、接口和回归清单。

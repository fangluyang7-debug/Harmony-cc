# 图片演示与调度中心：修改记录和合并保护清单

最后更新：2026-11-11。本文是双方合并时持续维护的入口，不是一次性的性能报告。后续修改请更新对应功能编号、文件位置、验证结果和提交基线；可以重构实现，但必须保留下面的用户行为与接口语义。

**完整包与真机更新已落实**：[20261111 交付记录](WINDOWS-GPU-DELIVERY-20261111.md)。`imageprocessing` 已整合 `main` 的接入恢复、共享 App Session、SoleAI 和 GPU 修复；完整 02 包已带模型/CPU/Vulkan/DLL，三个真实推理 HAP 已覆盖安装。本机/手机更新不等于独显真机通过，后者仍待验；不可用缺模型的桩实现 HAP 覆盖这里的真实照片能力。

**独显照片节点问题（代码已在 `main` 修复，真机待验）**：[Windows 独显照片节点分发包排查](WINDOWS-GPU-PHOTO-PACKAGE-DIAGNOSIS-20261111.md) 的 P1～P4 与风险 1 已按 M12～M14 落地（显存额度随画像自动分配、双显卡自动选 NVIDIA、打包缺件即失败并携带 OpenMP DLL），记录见 [main 分支修改记录](../main分支修改记录.md) 第 5 次提交。仍成立：后续合并不能把“有 GPU 代码”当作“交付包已具备 GPU 能力”，02 包必须用 `HARMONY_PHOTO_RUNTIME` 重打并完成独显真机验证。

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
| M01 资源策略 | `services/coordinator/src/spaces.ts` / `autoContribution` | 自动系统内存余量为 RAM 的 1/16、限定 256 MiB～1 GiB；本次 r2 将专用 CPU 上限改为全部测得逻辑线程（最多 64），其他模式一半。继续遵守实际可用内存和用户固定配置。不要恢复按 RAM 1/4 预留，导致已连接电脑无法通过能力验证。 |
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
| M12 显存自动额度（main） | `services/coordinator/src/spaces.ts` `measuredCapacity` / `autoContribution` / `deviceSettings`；`services/pc-agent/src/host.ts` `sample()`；`host-main.ts` | 设备先探测 GPU，再在 measured 中上报 `vramBytes`（无 GPU 后端为 0）；中心按显存减 256 MiB 分配 `maxVramBytes`，上报 0 即撤销。GPU 探测不以显存额度为前提（自动额度或固定额度 > 0 即探测）；旧中心拒绝 `vramBytes` 时调度件退回 CPU/RAM 字段。不要恢复“先有额度才探测”的顺序，也不要让中心在没有 GPU 执行器时显示 GPU 额度。 |
| M13 双显卡与失败原因（main） | `services/pc-agent/src/photo-accelerator.ts` `parseVulkanDevices` / `selectVulkanDevice` | 从引擎诊断日志中选与 `nvidia-smi` 名称匹配的 Vulkan 索引，不假设 0 是独显；显式 `HARMONY_PHOTO_GPU_ID` 必须是 NVIDIA 设备；探测失败按 RUNTIME_MISSING / DRIVER_MISSING / DEVICE_UNMATCHED / MEMORY_TOO_SMALL / PROBE_FAILED / QUALITY_FAILED 区分。CPU 回退仍明确显示，不冒充 GPU。 |
| M15 Windows 配对/退出（main） | `scripts/runtime-desktop.cjs` `pairingRequest` / `resolvePairingInput` / `leave`；`apps/runtime-desktop/desktop.js`、`agent.html`；`services/pc-agent/src/host.ts` `CONTROL_ONLINE` | 配对请求独立连接 + 10 秒截止 + 复用已核对证书，配对码不重复兑换；`/agent/leave` 经协调中心 `/v2/devices/leave` 注销后才移走配对目录（账本保留），不可达须用户确认 `force`。设备配对码与"仅展示连接码"仍不互换（P08）。 |
| M14 照片包完整性（main） | `scripts/lib/photo-runtime-package.cjs`；`scripts/prepare-harmony-distribution.cjs` | 02 包默认必须带完整照片运行库（模型三件 + CPU runner + Vulkan EXE 及同目录 DLL，含 `vcomp140.dll`，不带 `vulkan-1.dll`），缺件 `PHOTO_RUNTIME_INCOMPLETE`；只有 `HARMONY_PHOTO_RUNTIME_OPTIONAL=1` 才能生成无照片包，且包根与使用说明标明。不要退回旧 `build-windows-agent.cjs`。 |

| M15 有界并发推进（r2） | `workflow-jobs.ts`、`profile-projection.ts` | 同组最多并发推进 2 张图，每张图最多 4 个就绪节点；保留全局推进队列、节点唯一 ID、已派发不重复 start、每图元数据串行保存。画像只合并同一时间的在途刷新，不缓存过期画像。回归必须覆盖一个慢兄弟节点不阻塞另一个，以及重复 advance 不重复提交。 |
| M16 真实 CPU 与多线程（r2） | `photo.cpp`、`NativeAgent.ets`、`Photo.ets`、`PhotoLocal.ets`、PC `host.ts`、reference photo pack、`qualification.ts` | 原生测得在线 CPU 数，实际传递 1/2/4/8 线程给 ncnn；按半数可用 CPU 选每分片线程，保留多个分片并发能力。广告、资源预留、参考校验和实际执行线程一致。手机本机基线使用同样优化，不能只优化协作端来制造提速。 |
| M17 图片 App 在线额度（r2） | `apps.ts`、`app.ts`、`PhotoSession.ets`、`NativeAgent.ets` | 已授权 App 可显式启用性能额度，在线贡献跟随同设备共享容量；保留设备总账准入、离线额度及合同范围。旧声明重新授权兼容已扩大额度，不能退回图片 App 固定 2 CPU / 1 GiB。 |
| M18 源端轻量阶段（r2） | 原生图片 `PhotoWorkflow.ets` | 分析、切块、合成和生成成品限定源设备；耗时增强仍由统一规划器选设备。保留阶段和回执，不增加旁路派发；合成的多输入包暂仍经过中心，不得宣称零中转。 |
| M19 重新配对反馈（r2） | `runtime-desktop.cjs` | 配对成功即清除旧 coordinatorGone 标记，避免成功后界面再次错误显示已断开。旧账本保留。 |
| M20 快照批量读写（r2） | `planning.ts`、`directory.ts` | 目标与设备投影在同一事务内参数化批量 UPSERT，每批最多 100 行；保留版本检查、旧投影、原子回滚。设备预算、安装与排队任务批量读取，容量扣除语义不变。不可退回逐目标数据库往返，也不可通过删除历史或延长画像有效期提速。 |
| M21 派发前取消后的重配 / 退出 | `device-membership.ts`、`auth.ts` | App 额度记录没有 Attempt 且对应同空间同用户 CpuJob 明确 CANCELLED 时，不再作为占用阻止重配/退出。实际 Attempt 优先，未结算仍阻止；无任务的未知记录或仅过期不释放。历史不得删除。见 `PHONE-RECONNECT-FIX-20261111.md`。 |
| M22 图片 App 源端能力就绪等待 | `NativeAgent.ets`、`PhotoSession.ets`、`PhotoBatch.ets` | 控制连接不等于资格就绪；提交前检查当前 App 自身必要能力，等待计入原 180 秒预算、可取消，不重置计时或预算本次照片。保留源端轻量阶段与单一 SDK 派发入口。见 `PHOTO-READINESS-FIX-20261111.md`。 |
| M23 Windows 真实多线程与去冗余 | `prepare-photo-runtime.cjs`、`photo-runner.cpp`、`executors/photo.ts`、`workflow-jobs.ts` | Windows ncnn 与 runner 必须启用 OpenMP 并验证实际线程组，不能仅依据配置宣称多线程；CPU 在 RGB 上裁切后只编码最终 PNG。运行中节点不查询提交输出，已有 Attempt 的输入不在 SDK 每次轮询时重复准备；未准入输入/成功后输出可见性/取消及改派仍按原链路处理。见 `PHOTO-PERFORMANCE-R3-20261111.md`。 |
| M24 阶段批量读取与成本学习、四图流水 | `cpu-jobs.ts`、`workflow-jobs.ts`、`performance-feedback.ts`、`planning-api.ts`、`PhotoSession.ets`、`PhotoBatch.ets` | 已提交节点用一次 SQL 快照检查赢家/回执/输出；未拆分初始化的成功 EXECUTE 按完整耗时学习且不重复加冷启动，不能丢弃鸿蒙实际样本。按活跃物理设备数配置 2～4 图窗口，中心最多并行推进 4 图，仍保留总账准入、批次总预算、唯一尝试和串行元数据写入。见 `PHOTO-PERFORMANCE-R4-20261111.md`；不将本地回归当作真机提速成绩。 |

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

上一轮“独立工作流并行推进”和“资源不足时零等待重试”实验未证明收益，已撤回；不要从临时测试代码恢复它们。20261111 r2 重新实现了 M15 的有界并发与串行元数据保存，不包含零等待重试；其真机结果独立记录在 `PHOTO-PERFORMANCE-R2-20261111.md`。后续重点仍包括执行端多输入合并和实际成本估计，不能清空历史、降低手机基线配额或预热任务结果。

本轮已通过 App 额度回归 6/6、最终照片工作流/空间回归 9/9，以及之前记录的 SDK、原生适配、缓存/追踪/恢复回归。API 24 手机 HAP 已安装真机验证；模拟器曾返回 `EMULATOR_COMMAND_FAILED`，未通过。鸿蒙电脑、NVIDIA GPU 和 API 22 本轮没有新增真机验收。

**GitHub 源码更新不等于旧安装包更新**：本机已安装目录和图片 HAP已更新，但旧 `dist/调度系统分发-20261110-r2` 的 Windows ZIP 仍是旧包，不能用于复现本轮优化。重新运行正式 `scripts/prepare-harmony-distribution.cjs`，通过 `HARMONY_PHOTO_RUNTIME` 指向新构建的运行库，并按协作者的 SDK/设备签名重新构建 HAP。不能复制本机证书、凭据、空间数据库、调试账本到发行包。

`.test`、本地运行库和签名、旧分发目录没有随本次源码提交上传；`output/` 中已有的样例图片/海报也不属于本轮代码修改，保持原样。需要二进制交付时另行构建并发布，记录源码提交和包校验值。

## 6. 后续维护记录

| 日期 | 提交 / 范围 | 修改与保留要求 | 验证 |
| --- | --- | --- | --- |
| 2026-11-11 | `52f5865` 及本文后续文档提交 | 新增 M01～M11；汇总既有 P01～P12，明确新版中心与独立业务 App 的边界 | 两轮真实 Wi-Fi 双机完成；仍未达到单机提速目标 |
| 2026-11-11 | `main`：`715c3d5` 合并 `imageprocessing`（`495bfd1`）后的第 5 次提交 | 新增 M12～M14（显存自动额度、双显卡选择、照片包完整性）；修复 SoleAI 网关工作流 id 与声明不匹配导致协同链不触发；M01～M11、P01～P12 未改动 | 单元/脚本回归通过（见 main 分支修改记录 §7）；本机无 NVIDIA 与照片运行库，独显真机与完整 02 包验收待队友机器完成 |

后续每次双方整合时追加一行。若要改变任一 P 编号对应的用户行为，先说明替代方案和验证结果；若只是重构，保留行为并更新路径、接口和回归清单。

2026-11-11 r2（基线 `df79a6b` 后工作区修改）：M01、M15～M20 见 [本轮实现与真机记录](PHOTO-PERFORMANCE-R2-20261111.md)。本文第 5 节保留的是此前六图测试及当时分发状态；本轮两图结果、三设备安装及新分发包以 r2 文档为准，不能混用验收结论。

## M25：r5 独立工作流、像素预测、融合执行和常驻模型

详见 `PHOTO-PERFORMANCE-R5-20261111.md`。不得恢复整组 this.work 等待屏障；每图独立通知、最新游标、单写者和完成提交门槛必须一起保留。新融合 DAG 必须同时合并 Web/手机、CPU/鸿蒙/GPU输入适配、契约 v2 与参考包、实际输入 schema 传递；不能仅更新页面。

workModel 的 inputBytes/scale 同步 TS/ArkTS/JSON Schema；像素参数由真实含 halo 几何生成。稀疏实测仍 LOW，不得伪造为高置信度；剩余 PRIOR 不得释放设备真实账本。模型进程/线程复用必须保留新输入计算、取消结算、边界/哈希与全图完整性检查，不允许缓存业务成品代替计算。照片 receipt 保留完整 EXECUTE，不能把未知启动状态写成已测 COLD/WARM 或再次叠加初始化。

r5 是按新的瓶颈证据重做每图独立推进，不是恢复第 5 节已撤回的“零等待重试”实验；旧实验仍不可恢复。本轮没有新六图真机性能结论，后续由用户复测。手机本机基线同享模型复用。

## M26：照片计算成功后的结果恢复

保留 PhotoRecovery.ets、PhotoBatch 同一 SdkTask 的结果重取、PhotoSession 错误阶段上下文；只重试短暂传输错误，沿用原预算，不重新提交/重复计算。展示 POST 丢响应后先读 revision/jobs 再写，终止清理与计算预算分离。不得把未交付的失败历史改为成功，不得用忽略校验或忽略留存错误替代恢复。详情 PHOTO-RESULT-TIMEOUT-20261111.md。


## M27：可独立交付的 GPU 照片节点

正式包保留完整相对路径模型/CPU/Vulkan/DLL、`Check-Photo-GPU.cmd` 与 BUILD-INFO 文件指纹。照片增强使用 Vulkan，不得误导用户填写 CUDA 图像编码套件。新节点必须与实际中心共享协议/照片 v2 定义一致；参考诊断、节点就绪、业务回执与实际提速分开记录。诊断不修改配对、不预置业务图片。见 DEVICE-B-PHOTO-GPU-20261112.md。


## M28：GPU 与 CPU/鸿蒙照片处理一致性

保留共享 photo-core.h 的原生 Vulkan RGB/float32/分块裁切逻辑、harmony-raw-v1 ABI 与引擎配置。保持原权重、参考样例和 0.99 标准；不能改低分数或绕过评测使 GPU 上线。GPU/CPU 均调用 enhancementInput 验证 pixels 与融合输入。原生 GPU Net 必须在全局 Vulkan 退出前释放（包括异常），不能用接收非零退出码掩盖崩溃。CPU 模型复用不变。打包必须携带新引擎、ABI、静态依赖检查及许可证，不能只替换 EXE。使用 runtime-vulkan.json；旧 GPU CLI 仅留兼容/复现路径，不作为当前推荐包。见 DEVICE-B-GPU-QUALITY-20261112.md。

## 2026-11-12 main 集成

按用户确认合并 `9f31cd6`（`codex/imageprocessing-gpu-20261112`），Windows HTML 直接采用来源分支；保留 main 新中心会话与队友重配清理标记。原因、冲突处理和 165 项通过 / 2 项跳过见 [合并验证](MAIN-GPU-MERGE-20261112.md)。本轮没有重打分发包或推送。

## M29：GPU 常驻模型与最新快照语义复核

本地已在 main `e442b06` 上补入该优化，移植为 `97c2595`；见 [本地整合与全端更新](LOCAL-MAIN-INTEGRATION-20261112.md)。保持 main 每次启动新会话的行为；同时保留退出空间后不得自动恢复历史默认目录的绑定修复及其回归测试。

保留 PHOTO-GPU-PERFORMANCE-R3-20261112.md 中的修改：快照变化时仍通过 PlanningService 重算并校验相同目标/路径，不能恢复版本递增即拒绝的并发活锁，也不能删除政策/执行器 identity/原子额度校验。最新快照与成本证据在 offer 事务内持久化，节点等待原因持久保存。GPU 通过 photo-workers 常驻并按 GPU 编号/模型身份隔离，只缓存模型，不缓存业务图片或结果；必须在 Vulkan 实例销毁前清理模型，取消必须等 worker 退出。executorVersion=2 触发新校准，不能复用逐片冷启动成本。旧手机/鸿蒙契约兼容，模型、质量和预算不变。B 应用 20261112-r3 包；尚无新六图真机提速结论。

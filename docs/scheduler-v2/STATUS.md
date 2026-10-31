# 调度 v2 进度状态

| 项 | 内容 |
| --- | --- |
| 现行规格 | [specification-r6.md](specification-r6.md)（文档 36 修订 6） |
| 开发分支 | `codex/scheduler-v2-foundation` |
| 最近核对 | 2026-11-01，已快进拉取 `c276134` 后执行 S1 |
| 主部署 | 局域网 PC 协调者（`npm run coordinator:lan`），云端协调者为非主线 |
| 当前切片 | **S1 完成-替身；下一切片 S2 第二种终端实现** |
| 下一步 | 进入 S2 前复核 A3/B3/B4 的替身验收证据，再推进 WP-S2a 黑盒一致性入口、WP-C1 protocol/core、X7/X8；X6 继续冻结模型评测方案 |

## 0. 更新规则

1. 本文件是项目进度的唯一记录（规格 R24）。每次提交后更新，不再新增 `HANDOFF-*` 文档。
2. 只记录事实与证据，“来源”写明：`核对`（阅读代码确认）、`测试`（附命令与结果）、`记录`（来自历史交接文档，尚未复跑）。
3. 状态取值：`未开始`、`部分`、`已有实现（待复核）`、`完成-替身`、`待真机`、`完成-真实`、`冻结`。
4. 切片完成条件见规格 §10.0；工作包完成级别见规格 §0.2 第 6 条。

## 1. 切片状态

| 切片 | 状态 | 已有证据（来源） | 下一步 |
| --- | --- | --- | --- |
| S1 单一派发路径收口 | 完成-替身 | 网页/CLI 已改走 plan → 持久化 → preflight → outbox；已删除自行排序与写死 App 身份；真实版本与六类跨度通过联调；R21/R25 违规 fixture 被拒绝；最终协调者 58/58、PC 41/41（核对、测试，见 §8） | 按 S2 推进，不代表鸿蒙或多物理设备验收完成 |
| S2 第二种终端实现 | 未开始 | HAR `v2/` 下只有 `protocol/` 两个文件；`apps/harmony-agent` 不存在；`tests/agent-conformance` 不存在（核对） | 先复核 S2a 依赖 A3/B3/B4 的替身验收，再做 X7/X8、WP-S2a、WP-C1 protocol/core 与 WP-B9 |
| S3 SDK 与 App 身份 | 未开始 | 没有通用 SDK；现有 CPU 薄入口已统一经过 PlanningService，控制台临时 App 身份已持久化（核对） | 依赖 S1 与 C1；正式 C2 不能用临时控制台身份代替 |
| S4 两个 App 同机 | 未开始 | `apps/harmony-indexer` 不存在（核对） | 依赖 S3 |
| S5 多阶段任务与数据路径 | 未开始 | 任务入口只支持单节点；数据经协调者中转（核对、记录） | 依赖 S3 |
| S6 资源约束与公平 | 部分 | PC 代理有按类别的份额、老化、有界连续服务（记录）；`YieldNotice` 未触发重规划；电量与温度为 `UNKNOWN`（记录） | 依赖 S2 |
| S7 GPU 与图像业务 | 未开始 | 没有 GPU 执行目标；X6 已做本机环境核对，模型尚未测试（核对） | 冻结 X6 评测门槛，再做 PC 参考与转换探针 |
| S8 会话展示与验收 | 未开始 | 没有会话与展示链路；没有 `acceptance:report`（核对） | — |
| F1 云端协调者（可选） | 冻结 | Railway `harmony-space` 服务已部署（记录） | S1—S8 完成后再评估 |

## 2. 工作包状态

| WP | 状态 | 说明（来源） |
| --- | --- | --- |
| A1 | 已有实现（待复核） | `packages/scheduler-core`（记录） |
| A2 | 完成-替身 | 本轮扩展 R21/R25，原依赖检查与违规 fixture 共 21 项通过；v1 回归 41 套件 / 326 项通过（测试） |
| A3 | 已有实现（待复核） | TS 与 ArkTS fixture 一致性检查存在；HAR 构建未验证（记录） |
| A4 | 已有实现（待复核） | 独立协调者与数据库（记录） |
| A5 | 已有实现（待复核） | outbox 与恢复（记录） |
| A6 | 完成-替身 | 正式 CPU 入口接入 plan/preflight，持久化真实快照与策略版本；纯规划零 I/O、过期/撤销、指定目标、旧快照拒绝均有测试 |
| B1 | 已有实现（待复核） | TLS/WSS、去重、重连（记录） |
| B2 | 部分 | 配对码与邀请文件可用；鸿蒙侧扫码未实现（记录） |
| B3 | 部分 | PC 画像只有 CPU 与内存；T2 未最终冻结（记录） |
| B4 | 部分 | PC 侧账本、额度、attempt 持久化与恢复已有（记录）；同机多进程场景未覆盖 |
| B5 | 部分 | 经协调者中继；PC 对认证中继上传/下载做实际 HTTP 区间采样，接入 DirectionalLinks、画像和正式规划。直连/副本路径选择仍未实现（核对、测试） |
| B6 | 部分 | CPU 子集可运行（记录）；GPU 执行目标未实现 |
| B7 | 部分 | 队列与公平规则已有；`YieldNotice` 重规划未实现（记录） |
| B8 | 部分 | 确定性层与多进程层基础已有；SDK 与 agent 同机、CPU/GPU 共享 RAM 场景缺失（记录） |
| B9 | 未开始 | 鸿蒙代理工程不存在（核对） |
| B10 | 部分 | 正式任务 PLAN/OFFER/QUEUE/ADMIT/EXECUTE/PUBLISH 可查询且使用真实快照版本；SDK 根跨度、完整传输因果与关键路径仍未贯通，不输出完整端到端收益（测试） |
| B11 | 部分 | PC 侧自动校准可运行（记录） |
| B12 | 未开始 | 依赖 B9；需真机 |
| C1 | 部分 | 只有 `v2/protocol/`（核对） |
| C2 | 部分 | 按已认证 group/principal/holder 签发并持久化 ConsoleApp 身份；完整 App 注册、独立 App 凭据和配额待 S3（核对） |
| C3 | 未开始 | S1 已将 CPU 入口接入正式规划器；通用 SDK、DAG 与生命周期待 S3（核对） |
| C4a | 部分 | 文本、向量、裁剪参考包存在（记录）；【真实·裁剪】待真机 |
| C4b | 未开始 | 依赖 X6 |
| C5、C6、C7a、C7b、C9 | 未开始 | — |
| C8 | 部分 | `text.count.v1` 经 CPU 入口跑通，未经 SDK（记录） |
| D1、D4、D5、D6、D9 | 未开始 | — |
| D2、D3、D8 | 部分 | 有相关模块和局部测试，未接入正式链路（记录） |
| D7 | 未开始 | — |
| D10 | 未开始 | 需真机 |
| E1、E2 | 未开始 | — |
| S1 | 完成-替身 | 端到端、目标/预算拒绝、旧快照、追踪查询及最终组件回归通过，见 §8 |
| S2a | 未开始 | — |
| F1 | 冻结 | 非主线 |

## 3. 待真机清单

工作包代码完成后，按规格 §0.2 第 6 条编写 `docs/experiments/real-device/<WP 编号>.md`，并在此登记。

| 条目 | 需要的设备 | 真机执行文档 | 状态 |
| --- | --- | --- | --- |
| B6【真实·GPU】 | 带 CUDA 显卡的 PC | 待编写 | 未开始 |
| B9【真实】 | 鸿蒙手机 + 局域网 PC | 待编写 | 未开始 |
| S2a（`--agent harmony-device`） | 鸿蒙手机 | 待编写 | 未开始 |
| B12 | 鸿蒙手机 + 局域网 PC | 待编写 | 未开始 |
| C3【真实】 | 鸿蒙手机 | 待编写 | 未开始 |
| C4a【真实·裁剪】 | 鸿蒙手机 + PC | 待编写 | 未开始 |
| C4b、C5、C6【真实】 | 鸿蒙手机 + PC（+ GPU） | 待编写 | 未开始 |
| C7a、C7b【真实】 | 鸿蒙手机 | 待编写 | 未开始 |
| C9 | 鸿蒙手机 | 待编写 | 未开始 |
| S5 局域网双设备实测 | 两台终端 + 局域网 PC | 待编写 | 未开始 |
| D6【真实】 | 鸿蒙手机或平板 | 待编写 | 未开始 |
| D10 | 鸿蒙手机 + 展示端 + 局域网 PC | 待编写 | 未开始 |
| X1、X2、X3、X4、X5、X6 | 见规格 §9.1 | 待编写 | 未开始 |

## 4. 平台与模型实验

记录位置：`docs/experiments/X<n>-<名称>.md`（目录尚未建立）。

| 实验 | 状态 | 说明 |
| --- | --- | --- |
| X1 后台接任务 | 未开始 | 需真机；完成前鸿蒙代理按“切到后台即停止准入”处理 |
| X2 局域网与 TLS | 未开始 | 证书固定可先在模拟器验证 |
| X3 ODID | 未开始 | 需真机 |
| X4 扫码 | 未开始 | 完成前使用配对码 |
| X5 App 身份 | 未开始 | — |
| X6 跨端图像模型 | 部分 | [环境核对与记录表](../experiments/X6-跨端图像模型.md)；当前 Python 3.13 环境未发现模型运行依赖，模型/质量/转换未执行 |
| X7 跨工程引用 HAR | 部分 | [构建环境核对](../experiments/X7-跨工程引用HAR.md)；已找到 DevEco/Hvigor/JBR/API 24 SDK；独立工程不存在，未构建 |
| X8 DevEco 模拟器能力 | 部分 | [镜像与目标清单核对](../experiments/X8-DevEco模拟器能力.md)；hdc 返回 Empty，未启动模拟器、未安装 HAP、未验证网络与持久化 |

## 5. 已知问题（来自记录，待在局域网部署下复现）

| 问题 | 状态 |
| --- | --- |
| 云端实验中 2 次 `TASK_REJECTED`，根因未定位 | 待复现 |
| `services/coordinator/test/spaces.test.cjs` 间歇 `SPACE_TIMEOUT` | 待定位 |
| 校准阶段出现过一次 `LEDGER_UNAVAILABLE`，未复现 | 待观察 |
| Windows 账本快照替换 `EPERM` 已加有限重试，需长时间运行观察 | 待观察 |
| 连续提交时可用画像存在时间窗口，出现 `NO_AVAILABLE_TARGET`；已加有界等待 | 已缓解 |
| 协调者 TLS 测试要求 OpenSSL 在 `PATH` 中 | 环境说明 |

## 6. 非主线（冻结：只修缺陷）

| 项 | 说明 |
| --- | --- |
| Railway `harmony-space` 服务 | 保留现有部署，不做功能开发；F1 之前不更新部署 |
| `apps/team-space-web` 与 `spaces.ts` 的功能扩展 | 页面保留为局域网控制台；任务提交按 S1、S3 改走正式路径 |
| 分支 `codex/latency-cloud-vs-local` | 只读实验记录，不合并 |
| v1 `services/api-server` 调度路径、`services/device-worker` | 规格 R2 |

## 7. 更新记录

| 日期 | 提交 | 切片 / WP | 摘要 | 已执行检查 |
| --- | --- | --- | --- | --- |
| 2026-10-31 | `c276134` | — | 规格升级为修订 6；建立本状态文件；历史交接文档标注为历史记录 | 仅文档，未运行代码测试 |
| 2026-11-01 | `c276134`（拉取基线） | S1 开工 | 按 README 顺序阅读修订 6、状态与 WP-S1，执行基线复核 | `npm run scheduler:v2:test` 通过：core 24、transport 1、PC agent 38、coordinator 56、architecture 18；T1/T2 fixture 脚本通过 |
| 2026-11-01 | 本轮 S1 提交（基于 `c276134`，提交号见 Git 日志） | S1 / WP-S1、A6、B10 正式链路 | 单一规划派发、临时 App 身份、真实版本追踪、实测中继链路；修复评测触发业务恢复与策略初始化覆盖；启动 X6/X7/X8 环境记录 | 最终组件结果：core 24、T1 495、T2 352、transport 1、PC 41、coordinator 58、architecture 21；v1 41 套件 / 326 项；真机、GPU、HAP 未验收 |

## 8. S1 本轮实现与验证（2026-11-01）

完成级别：**完成-替身**。网页与 CLI 经过同一正式链路，最终组件回归全部通过。没有推进云端部署或新增协作空间产品功能，没有新增运行时依赖。S1 无单独的真实验收条目；鸿蒙与多物理设备工作仍按后续切片登记。

### 实现范围

- `cpu-jobs.ts` 只构造请求、调用注入的 PlanningService 并装配所选执行器，不再访问快照 candidates 或自行排序。用户目标约束传入核心，plan 结果与版本写入 CpuJob；start 在派发前重新规划、复核，快照失效最多额外重试两次，失败不创建 attempt。
- 新增 ConsoleApp 与迁移 `202611010001_console_app`。临时控制台 App 身份按认证 group/principal/holder 绑定，随机签发并存于数据；未开放客户端自报身份。它不等同于 C2 的独立 App 认证。
- 使用既有 B5 DirectionalLinks，对中继上传和下载各测三种大小，拟合值作为现有 LinkV2 字段进入画像和规划；无观测保留空 links/UNKNOWN，网络变化丢弃旧批次。测量包含完整 HTTP 控制开销，不能称为裸单向带宽。当前无法识别 OS 计费状态，保守视为 metered。
- 派发授权响应返回与该 offer 绑定的真实 snapshotVersion；PC 宿主据此接入 B10，不用 planRevision 冒充快照版本，没有扩展冻结的 DispatchOffer/T2 字段。
- 协调者产生 PLAN/OFFER，代理产生 QUEUE/ADMIT/LOAD/EXECUTE/PUBLISH；CLI 凭据查询 `/v2/traces/:traceId`，网页会话通过自己的 job trace 路径查询同一数据。仍缺 SDK 根计时和完整跨端依赖，计量不完整不变为性能结论。
- R21/R25 加入 AST 与实际 CLI 架构检查，`spaces.ts` 仅以规则文件登记的只读展示例外访问候选。示例和说明以局域网入口为默认。

### 已有针对性证据

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 正式 CPU 路径 | 文本、向量、连续提交、指定无资格目标、预算耗尽、强制旧快照拒绝、凭证绑定 App 身份和完整六类追踪通过 | `services/coordinator/test/cpu-host.test.cjs`；本地 `.test/s1-cpu-recheck-20261101.log` |
| 网页链路 | 创建/加入、角色/范围隔离、CPU 结果、本人追踪查询、快 2.5 秒设备时钟与持久化通过 | `services/coordinator/test/spaces.test.cjs`；本地 `.test/s1-integration-20261101.log` 中网页用例通过 |
| 代理追踪与恢复 | 新跨度保留、回执丢 ACK 与重启不重复执行通过 | `.test/s1-trace-recheck-20261101.log`，1/1 |
| 链路与重试单测 | 画像协议、网络变化丢弃、未知状态、预算不可重试通过 | `.test/s1-agent-targeted-20261101.log`，4/4 |
| 架构规则 | 21/21；生产树检查通过 | `.test/s1-architecture-20261101.log` |
| v1 回归 | 41 套件、326/326 | `npm run api:test:unit -- --runInBand`；`.test/s1-v1-regression-20261101.log` |

### 最终组件检查

| 命令 / 范围 | 最后结果 | 本地日志 |
| --- | --- | --- |
| `npm run core:test`（总入口内执行） | 24/24 | `.test/s1-final-20261101.log` 的 core 部分 |
| `npm run protocol:v2:test`（总入口内执行） | T1 495 / T2 352，均通过；不等于原生 HAR 编译 | 同上协议部分 |
| `npm run transport:test`（总入口内执行） | 1/1 | 同上传输部分 |
| `cd services/pc-agent; node --test test/*.test.cjs` | 41/41 | `.test/s1-agent-final-20261101.log` |
| `cd services/coordinator; node --test --test-concurrency=1 test/*.test.cjs` | 58/58 | `.test/s1-coordinator-final-20261101.log` |
| `node scripts/check-architecture.mjs` + `node --test scripts/check-architecture.test.mjs` | 生产树通过，21/21 | `.test/s1-architecture-20261101.log` |
| `npm run api:test:unit -- --runInBand` | 41 套件 / 326 项通过 | `.test/s1-v1-regression-20261101.log` |
| coordinator/pc-agent TypeScript 构建、前端 `node --check`、`git diff --check` | 通过 | 构建日志 `.test/s1-build-20261101.log`；最终修复另以对应 tsconfig 编译 |

初次总入口回归曾因旧追踪断言及随后暴露的运行缺陷失败；没有将该命令的失败记为通过。修复后按组件单独复测，最终以本表列出的成功结果为准。失效策略、预算耗尽、评测/业务结算分流均有正反例；未新增孤立测试入口代替正式业务派发。日志留在本机忽略目录，代码与测试随提交同步。

### 自行决定与限制

1. S1 沿用固定中继数据路径，模型范围是“中继输入 → 执行器 → 中继结果”；来源后续拉取明确记为 `SOURCE_PULL_NOT_ESTIMATED`。输出按参考能力的结构化保守上界估算，不把所有微小向量结果都当成 8 MiB，不把上界称为实测大小或端到端预测。完整副本/直连/数据路径属于 S5。
2. 单节点任务没有上游节点，dependencies 为空属实；transferPlan 则记录实际输入中继与所选执行设备。
3. 首轮联调发现带宽单位不符合既有协议，已改为 `bytes_per_second` 并加入 validLinkV2 测试。追踪增加 ADMIT/QUEUE 后已同步旧断言，未删除失败用例或降低校验。
4. 本机实际 DevEco 为 6.1.1.290、API 24 SDK，与规格 §9.3 所记另一环境的 API 22 不同。这里只登记事实，不修改规格方向，也不声称 API 22 兼容构建通过。
5. 本轮未执行手机、GPU、双物理终端、模拟器 HAP 或性能收益验收。PC 的链路观测、真实版本获取和新追踪行为，Harmony 代理须在 S2/C1/B9 中实现并通过同一黑盒一致性测试；未实现，不宣称终端等价已验收。
6. 回归发现并修复两项实际问题：默认 CPU 策略初始化在事务内检查旧版本，避免覆盖刚安装的显式策略；受限参考评测仍在同一账本结算，但结果只走持久化许可回报，不再误发业务全局 RecoveryRequest、撤销未投递的业务 offer。业务结算和未知业务恢复语义保持原有路径；新增正/反例，Harmony 代理后续须采用同样的渠道区分。
7. 任务截止时间从首次登记保留；上传与有界重规划不会重置预算，最终 leaseMs 不超过剩余预算。上传后耗尽预算的场景不创建 attempt。没有对资源准入、TLS 或协议校验做放宽。

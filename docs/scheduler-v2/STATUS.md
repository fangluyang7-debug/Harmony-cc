# 调度 v2 进度状态

| 项 | 内容 |
| --- | --- |
| 现行规格 | [specification-r6.md](specification-r6.md)（文档 36 修订 6） |
| 开发分支 | `codex/scheduler-v2-foundation` |
| 最近核对 | 2026-11-01，基于 `dba1859` 推进 S3 的 App 注册与 SDK 提交；提交号见 Git 日志 |
| 主部署 | 局域网 PC 协调者（`npm run coordinator:lan`），云端协调者为非主线 |
| 当前切片 | **S3 部分：正式 App 身份与 SDK → PC 链路已实现；来源本地/离线宿主仍待整合** |
| 下一步 | 继续 S3/C3：SDK 宿主接入同一账本、来源本地候选及无外传、离线基础额度回退、执行中取消与结果目的地；不进入 S4。真机本轮未做 |

## 0. 更新规则

1. 本文件是项目进度的唯一记录（规格 R24）。每次提交后更新，不再新增 `HANDOFF-*` 文档。
2. 只记录事实与证据，“来源”写明：`核对`（阅读代码确认）、`测试`（附命令与结果）、`记录`（来自历史交接文档，尚未复跑）。
3. 状态取值：`未开始`、`部分`、`已有实现（待复核）`、`完成-替身`、`待真机`、`完成-真实`、`冻结`。
4. 切片完成条件见规格 §10.0；工作包完成级别见规格 §0.2 第 6 条。

## 1. 切片状态

| 切片 | 状态 | 已有证据（来源） | 下一步 |
| --- | --- | --- | --- |
| S1 单一派发路径收口 | 完成-替身 | 网页/CLI 已改走 plan → 持久化 → preflight → outbox；已删除自行排序与写死 App 身份；真实版本与六类跨度通过联调；R21/R25 违规 fixture 被拒绝；最终协调者 58/58、PC 41/41（核对、测试，见 §8） | 按 S2 推进，不代表鸿蒙或多物理设备验收完成 |
| S2 第二种终端实现 | 完成-替身 | 独立 HAR 与两个 HAP 原生构建；PC 8/8、Harmony 模拟器共同 8 项及裁剪/生命周期共 10/10；原生 27 fixture、RDB 重启及 TLS 正反例（测试，见 §9） | 真机 B9/S2a 待验；进入 S3 前阅读本节限制 |
| S3 SDK 与 App 身份 | 部分 | 独立 App 注册/凭据、基础额度预留、在线任务配额；TS/ArkTS SDK 同源语义、网页/CLI 整合；模拟器 App → PC 文本/向量实际回执通过（测试，见 §10） | 来源本地/离线宿主、执行中取消、固定服务与完整 resultDestination 尚未接入；不满足 S3 整体完成条件 |
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
| A2 | 完成-替身 | TS/ETS 依赖扫描、核心纯净和 client/agent 直接及桥接依赖反例，24/24；v1 326/326（测试） |
| A3 | 完成-替身 | T1 495、T2 352 fixture；HAR 原生编译通过，协议源未改变（测试） |
| A4 | 已有实现（待复核） | 独立协调者与数据库（记录） |
| A5 | 已有实现（待复核） | outbox 与恢复（记录） |
| A6 | 完成-替身 | 正式 CPU 入口接入 plan/preflight，持久化真实快照与策略版本；纯规划零 I/O、过期/撤销、指定目标、旧快照拒绝均有测试 |
| B1 | 完成-替身 | PC/Harmony 同一 WSS/HTTPS 黑盒检查通过，含重连、重复、冲突和撤销；模拟器 TLS 正反例 3/3（测试） |
| B2 | 部分 | PC 文件配对、Harmony 粘贴完整邀请 JSON 可用；独立短码向导/扫码仍未实现，X4 待后续（测试、核对） |
| B3 | 部分 | PC/Harmony CPU、RAM 画像接入；Harmony 读取实际内存/电源模式，CPU 槽位为声明并发；未知电量/温度不伪造；其他硬件与完整采集待后续（测试） |
| B4 | 部分 | TS/ArkTS 账本同 27 fixture；PC 持久化和 Harmony RDB 状态/outbox 重启通过；同机 SDK/多进程、离线基础额度场景待 S3/S4（测试） |
| B5 | 部分 | PC/Harmony 测量认证中继的上传/下载 HTTP 区间并进入正式规划；模拟器使用 hdc rport；直连/副本选择与真实 Wi-Fi 待后续（测试） |
| B6 | 部分 | CPU 子集可运行（记录）；GPU 执行目标未实现 |
| B7 | 部分 | PC/Harmony 份额、老化、有界连续服务微观队列接入，判定一致；YieldNotice 持久化及停止准入已测，重规划仍属 S6（测试） |
| B8 | 部分 | 确定性层与多进程层基础已有；SDK 与 agent 同机、CPU/GPU 共享 RAM 场景缺失（记录） |
| B9 | 完成-替身 | 独立原生代理、前台贡献设置、RDB、文本/向量/ImageKit、自动参考评测与统一派发通过；手动邀请 JSON 入网，扫码后续；真机待验（测试） |
| B10 | 部分 | PC/Harmony 业务七类跨度及真实 snapshotVersion 通过同一查询；无 SDK 根跨度和完整传输因果，仍不输出完整端到端收益（测试） |
| B11 | 部分 | PC 与 Harmony 均接远端受限参考评测，业务/评测共用账本；Harmony 裁剪左右区域由独立质量检查晋级；全硬件/真机仍待后续（测试） |
| B12 | 未开始 | 依赖 B9；需真机 |
| C1 | 完成-替身 | HAR v2 分界保留；新增实际 client SDK 与原生适配器，公共 TLS 代码移至中立 platform；client 不依赖 agent，核心保持纯净（测试） |
| C2 | 部分 | 用户确认的一次性邀请、独立安装凭据、撤销/轮换、已确认物理预算内的离线基础额度预留和在线任务配额已实现；控制台采用正式注册实例。离线运行与配额对账、X5 尚未完成（测试，见 §10） |
| C3 | 部分 | 单节点 workflow/等价方案 SDK、先元数据后字节、派发前取消、结果回调、网页/CLI 共用 TS SDK、模拟器 ArkTS SDK 提交通过；本地/离线宿主及执行中取消待续（测试，见 §10） |
| C4a | 部分 | 文本、向量、裁剪参考包存在（记录）；【真实·裁剪】待真机 |
| C4b | 未开始 | 依赖 X6 |
| C5、C6、C7a、C7b、C9 | 未开始 | — |
| C8 | 部分 | `text.count.v1` 已经 TS/ArkTS SDK → PC 跑通；完整业务 App 与本地宿主未完成（测试） |
| D1、D4、D5、D6、D9 | 未开始 | — |
| D2、D3、D8 | 部分 | 有相关模块和局部测试，未接入正式链路（记录） |
| D7 | 未开始 | — |
| D10 | 未开始 | 需真机 |
| E1、E2 | 未开始 | — |
| S1 | 完成-替身 | 端到端、目标/预算拒绝、旧快照、追踪查询及最终组件回归通过，见 §8 |
| S2a | 完成-替身 | 同一套 8 项 PC/Harmony 黑盒检查均通过；模拟器额外裁剪/生命周期通过；真机手工接入入口准备，未执行（测试） |
| F1 | 冻结 | 非主线 |

## 3. 待真机清单

工作包代码完成后，按规格 §0.2 第 6 条编写 `docs/experiments/real-device/<WP 编号>.md`，并在此登记。

| 条目 | 需要的设备 | 真机执行文档 | 状态 |
| --- | --- | --- | --- |
| B6【真实·GPU】 | 带 CUDA 显卡的 PC | 待编写 | 未开始 |
| B9【真实】 | 鸿蒙手机 + 局域网 PC | [B9.md](../experiments/real-device/B9.md) | 待真机，未执行 |
| S2a（`--agent harmony-device`） | 鸿蒙手机 | [S2a.md](../experiments/real-device/S2a.md) | 待真机，未执行 |
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

记录位置：`docs/experiments/X<n>-<名称>.md`。

| 实验 | 状态 | 说明 |
| --- | --- | --- |
| X1 后台接任务 | 未开始 | 需真机；完成前鸿蒙代理按“切到后台即停止准入”处理 |
| X2 局域网与 TLS | 部分 | 模拟器 rport + 原生 HTTPS/WSS 与正确/错误指纹、错误服务端证书已验证；真机局域网待验 |
| X3 ODID | 未开始 | 需真机 |
| X4 扫码 | 未开始 | 完成前使用配对码 |
| X5 App 身份 | 未开始 | — |
| X6 跨端图像模型 | 部分 | [环境核对与记录表](../experiments/X6-跨端图像模型.md)；当前 Python 3.13 环境未发现模型运行依赖，模型/质量/转换未执行 |
| X7 跨工程引用 HAR | 完成-替身 | [双 HAP / HAR 原生构建与源码路径失败退路](../experiments/X7-跨工程引用HAR.md) |
| X8 DevEco 模拟器能力 | 完成-替身 | [网络、TLS、RDB 跨进程、实际前后台、文本/裁剪与日志](../experiments/X8-DevEco模拟器能力.md) |

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
| 2026-11-01 | 本轮 S2 提交（基于 `f8f359d`，提交号见 Git 日志） | S2 / S2a、C1、B9、X7、X8 | 双代理协议一致性；HAR ArkTS 账本/队列；独立原生代理与探针；规划器文本/裁剪、原生 TLS、RDB 与生命周期验证；真机留接口 | PC 8/8、Harmony 10/10、原生账本 27 fixture、TLS 3/3；详细回归与限制见 §9 |
| 2026-11-01 | 本轮 S3 提交（基于 `dba1859`，提交号见 Git 日志） | S3 / C2、C3 部分 | 独立 App 注册、基础额度预留、在线任务配额；TS/ArkTS SDK 提交、网页/CLI 整合、模拟器实际取回结果；不标记 S3 整体完成 | 最终证据与下一步见 §10；真机未做 |

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

## 9. S2 本轮实现与验证（2026-11-01）

完成级别：**完成-替身**。协作者可从本次 S2 提交继续 S3；不要回到历史团队空间产品方案，也不要部署 Railway。本轮没有运行 `--agent harmony-device`、手机签名/安装、GPU 或多物理终端验收，没有新建 HANDOFF 文档。

### 已落地链路

- `tests/agent-conformance` 为语言无关的 WSS/HTTPS 黑盒套件，PC 与 Harmony 共用 8 项行为断言。正向任务走生产 PlanningService；仅测试协调者构造负例、重复投递和篡改签名，不读取代理账本断言通过。重复投递检查已有回执与单次输出上传，伪造签名不得获持久化 ACK。
- HAR `v2/{protocol,core,client,agent}` 分界建立，v1 导出保留。纯核心移植账本、额度、微观队列；状态与 outbox 由平台原子保存。client 目前是接口边界，**通用 SDK、独立 App 认证尚未完成**。
- `apps/harmony-agent` 是独立原生 HAP，使用 relationalStore、固定证书的 HTTPS/WSS、RSA-3072 额度验签和 HMAC ACK。前台贡献开关、CPU 槽位/内存上限保存在本机，不能超过配对时确认的上限；后台停止准入并让出。当前手动粘贴完整邀请 JSON，不声称扫码或独立短码向导已完成。
- 文本、向量和 ImageKit 裁剪复用同一画像、参考资格与任务派发链路。裁剪参考包移到 `packages/reference-capabilities` 供协调者共享，几何与颜色评测独立于执行器。新增该包对已存在的 `sharp ^0.34.5` 的显式依赖，用于参考图片和制品校验；没有引入另一种推理服务或新的依赖版本。
- Harmony 中继上传/下载 HTTP 区间观测进入画像与规划；QUEUE/ADMIT/LOAD/EXECUTE/PUBLISH 使用实际快照版本，与协调者 PLAN/OFFER 经同一接口查询。仍缺 SDK 根跨度及完整传输因果，不能报告完整端到端收益。
- `apps/harmony-har-probe` 独立引用构建后的 HAR，执行同 27 fixture 并验证跨进程账本/outbox；没有复制协议/核心来伪造跨工程引用。

### 最终证据

| 范围 | 实际结果 | 本地证据 |
| --- | --- | --- |
| PC 黑盒共同协议 | 8/8 | `.test/s2-conformance-pc-final.log` |
| Harmony 模拟器 | 共同 8 项 + 裁剪正反例 + 实际前后台，共 10/10 | `.test/s2-conformance-harmony-final.log` |
| 原生 TLS 正反例 | 3/3：错误指纹、错误服务端证书、正确信任进入配对接口 | `.test/s2-native-trust.log` |
| HAR、两个 HAP | 三个原生构建均 BUILD SUCCESSFUL，API 24 | `.test/s2-har-build.log`、`.test/s2-agent-hap-build.log`、`.test/s2-probe-har-build.log` |
| 账本与队列 | TS/ArkTS 同 27 组账本 fixture；队列选择/债务/让出/credit/过期/越权判定一致 | `.test/s2-ledger-parity.log` |
| 原生执行与 RDB | 27 fixture；强制停止后计数增加，ACCEPTED 恢复为已结算取消，outbox 保留 | `.test/s2-probe-runtime.log`；X8 运行记录 |
| core / T1 / T2 / transport / PC 单测 | 24 / 495 / 352 / 1 / 41，均通过 | `.test/s2-final-regression.log` 的对应组件 |
| 协调者最终完整回归 | 61/61，通过 | `.test/s2-coordinator-final.log` |
| CANARY 竞态与 CPU 正式链路针对性回归 | 7/7 | `.test/s2-qualification-cpu-final.log` |
| 依赖方向与架构反例 | 24/24；生产树 79 个文件通过 | `.test/s2-architecture-final.log` |
| v1 | 41 套件 / 326 项；HAR 原算法 8 项与并发检查通过 | `.test/s2-v1-regression.log`、`.test/s2-har-v1-algorithm.log`、`.test/s2-har-v1-concurrency.log` |

原始私有邀请、凭据、证书密钥、构建包和详细日志留在本机忽略目录；仓库只保留去除私有配置的 [实验结果摘要](../experiments/results/S2-20261101.json) 与复现入口。测试域为 SIMULATED，模拟器网络是 hdc 回环转发，不能当成真机局域网时延结果。`REAL` 手工运行入口已经准备，但未执行。

### 本轮修复的实际缺陷

1. 同一 attempt 换 messageId 重投时，按不可变 offer 比较并返回已有准入/回执；变更输入返回 ATTEMPT_CONFLICT，不重复启动引擎。YieldNotice 和 ProtocolError 持久化进 outbox，协调者记录让出信息；S6 重规划尚未实现。
2. 续期可能改变已选 offer 的额度版本。现在派发前的 grant/ACK 版本复核与 offer 持久化位于同一事务，等待准入的 OFFERED 期间不换新额度版本；暂不可用返回有界可重试原因，预算不延长。
3. 暂停贡献时原 PC 画像的 draining 与非零准入额度矛盾，导致校验拒绝。现在准入额度归零，已占用量保留到实际结算，不放宽 schema。
4. 已结算的失败回执此前只被保存为待对账证据，任务状态要等重连才变化。现在同一有效 fence 下的失败立即更新镜像，业务结果仍不提交；冲突终态被拒绝。取消/超时本身仍不释放资源。
5. 总入口首次在 CPU 宿主用例失败：任务 PUBLISH 阶段撞上 CANARY 继续参考评测时退回 CALIBRATING。已改为新鲜 CANARY 证据在追加评测期间保持有效；真实质量失败仍撤销资格，并补充正反例。首次失败的总入口日志不计为通过，以修复后最终组件结果为准。

### 后续边界

- 下一切片是 **S3/C2、C3**：正式 App 注册/凭据/离线基础额度、SDK 提交/取消/结果回调，控制台临时身份仍需替换；不新增第二条派发路径。
- 双物理设备、API 22、GPU、扫码、持续后台能力、SDK/agent 同机共享预算均没有在本轮验收。B9/S2a 的真机步骤已登记到 §3。
- 框架目前有界队列、额度和单安装账本；完整能耗/温度策略、公平重规划、直接数据路径与完整追踪收益属于后续切片。
- 部分压力/撤销运行曾出现 CONTROL_INTERNAL_ERROR 日志，最终协议重连断言通过；后续仍需更细的异常分类，不能把重试成功当成没有发生过异常。

运行入口及测试 App 的数据重置范围见 `tests/agent-conformance/README.md`；平台具体结果见 X7/X8。服务端迁移新增 Attempt.yieldJson；启动前执行现有 `db:init`，不要手工跳过迁移。

## 10. S3 本轮：App 身份与 SDK 提交（2026-11-01）

完成级别：**部分**。本批实现用户要求优先落地的注册与提交接口，并与当前协调者/代理、控制台、CLI 整合；来源本地/离线执行宿主尚未接入，不能将 S3 标为完成。基线 `dba18590ad3d31b5af4d23c2b145c0750ffd954a`，分支保持 `codex/scheduler-v2-foundation`。没有更新 Railway、改动 v1 业务路径或新建 HANDOFF 文档；没有执行真机、GPU、多物理终端验收。

### 已实现

- 新增 `RegisteredApp`、`RegisteredInstallation`、`AppJobReservation` 与迁移 `202611010003_sdk_apps`。设备所有者明确确认策略后签发一次性邀请；App 兑换独立凭据，身份与可用契约由服务端持久化记录构造，不接受任务自报身份。轮换保留身份，撤销使凭据失效；标签不代表发行者签名，X5 仍待完成。
- 注册时预留离线基础额度，累计占用已确认物理预算；与已有 agent grant、尚未兑换/已过期/已撤销的未对账 App 保留量一起核算。逻辑 App 的离线基础额度总和也不能超过资源策略。不能通过撤销/过期自动回收未知离线资源。在线任务按 `(groupId,principalId,appId)` 共用并发和资源上限，等待输入也占配额；派发事务重新验证身份与配额。结果成功但未结算、记录缺失等未知状态继续占用。
- `packages/scheduler-client` 提供 `registerInput`、`plan`、`submit(workflow|alternatives,options)`、状态/恢复查询、结果 Promise/回调和派发前取消。TS 与 HAR `v2/client` 的提交源码保持一致，两端各自编译。Native HTTPS 适配器与原生代理共用中立 `v2/platform/NativeTransport`，client 没有导入 agent；核心仍无平台 I/O。
- 元数据与字节传输分开；等价路径先检查输出契约和质量目标，再在唯一 PlanningService 中比较，派发仍通过 preflight、已有 outbox 与代理 WSS。本批只支持同一输入/能力的单节点路径及目标约束；多节点和跨能力路径明确返回 S5 范围错误。当前结果目的地支持 ORIGIN，实际数据经协调者中继，仍标记 `SOURCE_PULL_NOT_ESTIMATED`，没有宣称完整端到端时延预测。
- `cpu-jobs.ts` 改为 SDK 单节点服务端实现，停止临时签发 App 身份。旧 `/v2/jobs` 兼容入口也要求正式注册。网页通过会话网关绑定正式控制台 App，使用同一 TS SDK 的元数据、二进制输入和结果接口；CLI 使用相同 SDK，新增所有者侧 `app:register` 命令。旧 ConsoleApp 映射保留已有身份/历史任务的衔接作用。
- 超时不重提、不释放；仅对明确的规划容量拒绝做有界等待。浏览器关闭提交窗口停止等待。兼容服务端网关关闭内部等待，由调用方负责等待，避免嵌套等待撞上 HTTP 超时。已派发的任务目前取消返回 `CANCEL_REQUIRES_HOST`，不伪造停止证明。
- 独立 HAR probe 新增可选 SDK 模式：使用一次性 App 邀请，在原生 App 内经 ArkTS SDK 提交文本/向量，由 PC 实际执行，并在原生端检查取回结果。未传 SDK 邀请时保留 S2 原生账本探针行为。

API、示例、命令与支持范围见 [SDK README](../../packages/scheduler-client/README.md)。更新代码后先 `npm ci`、构建并执行协调者 `db:init`；浏览器 SDK bundle 随 `sdk:build`/协调者构建生成，不提交生成文件。App 私有配置、原始邀请、证书密钥与详细日志留在忽略目录。

### 验证记录

| 范围 | 最终结果 | 本地证据 |
| --- | --- | --- |
| SDK 生命周期与源码一致性 | 5/5；元数据先行、输入复制、结果校验/回调、投递不明不重放、关闭窗口、网关无嵌套等待 | `.test/s3-sdk-unit.log` |
| 注册与实际 SDK 集成针对性测试 | 3/3；一次性/过期/伪造/撤销/轮换、基础预算、跨安装配额、CLI 注册、等价路径和实际回执 | `.test/s3-registration-final.log` |
| 原生 ArkTS SDK | 文本/向量 2 条实际提交及结果检查通过；两个 committed 回执绑定独立 App | `.test/s3-native-sdk-final.log`；`.test/phase-b-gkMvoo/sdk-report.json` |
| HAR / probe HAP / agent HAP | API 24 三个原生构建 BUILD SUCCESSFUL | `.test/s3-har-build.log`、`.test/s3-probe-hap-build.log`、`.test/s3-agent-hap-build.log` |
| 原生代理共同协议与裁剪/生命周期 | 10/10 | `.test/s3-conformance-harmony.log` |
| 原生 TLS / PC 黑盒共同协议 | 3/3 / 8/8 | `.test/s3-native-trust.log`、`.test/s3-conformance-pc.log` |
| 协调者最终全量回归 | 64/64；包含网页 SDK 元数据/二进制上传/结果、范围与 Origin 检查 | `.test/s3-coordinator-final.log` |
| 架构与依赖方向 | 24/24；生产树扫描通过 | `.test/s3-architecture-final.log` |
| core / T1 / T2 / transport / PC 单测 | 24 / 495 / 352 / 1 / 41，均通过 | `.test/s3-final-regression.log` 的对应组件 |

最小实验摘要已提交到 [S3-20261101.json](../experiments/results/S3-20261101.json)。首次总入口有一个新增测试变量重名导致语法失败；首次原生共同套件暴露兼容网关嵌套等待超时。已修复，首次失败日志不计为通过，以本表最终组件检查为准。注册输入复制测试还发现 Node Buffer.slice 共享内存，已改成实际复制后哈希；新增正反例。运行中仍观察到 `CONTROL_INTERNAL_ERROR` 日志，未声称其分类问题已经消除。本轮未重跑 v1 API 326 项；没有改动其生产源代码，HAR 保留原有导出并原生编译成功。

### 后续继续 S3，暂不进入 S4

1. SDK 宿主接入同一个持久化账本、微观队列、资格评测与物理预算；App 沙箱输入/输出、来源 holder 候选和数据路径计价进入同一规划器。验收“本地更快选本地且无外传 / PC 更快选 PC”，不能用直接调用计算函数绕过 plan。
2. 实现断网后的基础额度本地路径，以及在线/离线占用与逻辑 App 配额的联合对账。当前注册保留了离线容量，不表示运行时离线执行已完成；未提供自动收回未知保留量的按钮。
3. 执行中取消接入两个代理的持久化请求与真实引擎停止/结算，保持未知状态保留资源；扩展固定服务节点、结果目的地和 SDK 根追踪。等待超时不得当成取消成功。
4. 再做规格 S3 的本地/远端选择和离线验收；X5 与真机 C3 留待设备就绪。完整 DAG、跨能力等价路径与通用副本/直连数据路径仍是 S5，不能从当前单节点接口推断已支持。

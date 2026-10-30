# Harmony 跨设备资源协同运行时：B 阶段软件整合交接

日期：2026-10-30（北京时间）。接收对象：后续协作者。

## 1. 接手结论与本轮范围

本次定位修订恢复原定总目标：在各设备操作系统允许的范围内，为多个 App 提供计算、通信、数据、外设和协同会话的统一协调能力。团队共享算力是该运行时支持的一个应用场景；项目的架构与完成标准仍覆盖 R5 的完整资源协同范围。

此前 B 阶段交付完成已实现模块的业务链路整合，按当时用户要求暂缓真机验收。下文保留该代码基线的实现与验证记录；本次文档修订不改变其完成级别。B1–B12 尚未全部完成。

目前可以在本机测试中完整运行：

> 建立协调者 → 配对/安装签名额度 → 未校准业务被拒绝 → 可信评测使用同一账本执行真实 CPU → 能力进入 CANARY/ACTIVE → HTTPS 获取输入 → WS 下发新任务 → 设备队列/原子准入 → CPU 子进程执行 → HTTPS 发布结果 → 持久化回执/WS 提交 → 查询执行 span。

整合测试主动丢弃回执 ACK 并断线，重连后只重发记录，不重复执行；重开账本后已完成任务仍不能再启动。

**交接基线：**

- 原交付机器仓库：`C:/Users/17321/Desktop/Harmony-final`；接手者以自己的实际克隆目录为准。
- GitHub：[fangluyang7-debug/Harmony-cc](https://github.com/fangluyang7-debug/Harmony-cc)。
- **接手分支：`origin/codex/scheduler-v2-foundation`**，见 [GitHub 分支](https://github.com/fangluyang7-debug/Harmony-cc/tree/codex/scheduler-v2-foundation)。
- **固定代码基线：`4a39bba47733e57de4b311bd675e9c8c1a7d0ae8`**，提交标题 `Integrate scheduler v2 CPU execution and durable handoff baseline`，见 [代码基线提交](https://github.com/fangluyang7-debug/Harmony-cc/commit/4a39bba47733e57de4b311bd675e9c8c1a7d0ae8)。该提交包含累计 A/B 代码、测试及两份产品设计/开发计划文档，共 253 个变更文件。
- 本文件随后由一个单独的文档提交更新基线；**协作者应从上述远端分支最新提交开始**，这样同时获得完整代码和本交接说明。后续文档提交不改变上述代码基线。
- 历史补丁起点为 `5c63ee3a713f50076d6029059476c15e69afb333`，它是旧基线，不能误当作本次接手版本。
- 项目总目标及技术验收以本节和 [specification-r5.md](specification-r5.md) 为准。[团队共享算力空间功能设计](../Harmony团队共享算力空间功能设计方案.md) 作为上层应用场景参考，其成员管理、预约、贡献统计不能替代 R5 的 App 解耦、通信、数据、会话与外设验收。SoleAI v1 保留回归；SoleAI v2 与第二鸿蒙 App 仍用于验证通用 SDK 和跨 App 解耦。
- 早期 `HANDOFF-STAGE-B`、`HANDOFF-B3-PROFILES`、`HANDOFF-B4-RECOVERY` 是历史记录；与本文件冲突的当前状态以本文件及代码为准。

### 1.1 接续时必须保持的架构目标

项目定位为面向多终端的跨设备资源协同运行时。操作系统方向的研究与验证落在资源抽象、宏观规划与端侧准入、生命周期、隔离和故障恢复机制上；当前实现位于应用与运行时层，不据此宣称已实现操作系统内核级资源隔离。

全局视图包括设备画像、链路图、数据目录、协同会话与策略。链路属于设备之间，数据位置属于制品与副本，会话描述参与端与角色；这些信息分别建模，不能全部塞入设备画像。每个字段必须有实际消费者及有效期、缺失处理，只有 schema 或上报字段不算功能完成。

| 协同维度 | 接续目标与验收依据 | 当前基线的边界 |
| --- | --- | --- |
| 计算与共享内存 | 设备/加速器/执行器选择、允许配置、同机原子准入；R5 AC3、AC8 | 已有 CPU 整合与额度账本，GPU 与完整同机矩阵待验 |
| 通信 | 直连/中继路径、方向成本、传输竞争真正参与决策；WP-D1、AC4 | 已有 HTTPS 传输与中继基础，自动选路与观测反馈待接 |
| 数据 | 数据位置、副本、缓存和授权改变候选及传输方案；AC4、AC7 | 已有制品引用、哈希和票据，完整位置/副本决策待验 |
| 能耗与使用状态 | 电量、温度、供电与主人使用实际约束准入和分配；WP-D5、AC8 | 已有策略与模拟输入，OS 采集和真实行为待接 |
| 外设与会话 | 来源端、执行端、展示端分别建模；屏幕展示有授权、租约、确认和撤销；WP-D6、D10 | 协同会话与真实屏幕展示尚未交付 |
| 多 App | 同一 HAR 支持两个独立鸿蒙 App，核心零修改；C7a 先用真实缩略图、无 X6 依赖；AC1、AC7 | 原生 SDK 接入、第二 App 和同机竞争尚待实施与验收 |

资源使用统一的申请、续期、释放与撤销生命周期，但执行规则遵循 R5 D3：计算/RAM 按资源向量准入，带宽做软预留，缓存用容量配额与引用计数，屏幕展示绑定会话和视图版本。设备属于同一调度组，不自动授予数据或外设访问权。

当前 CPU 整合链路验证上述架构的一部分。最终架构验收仍要求 AC1–AC8，尤其 AC4：改变链路、数据位置、温度或会话成员，必须能观察到预期的选择、拒绝或路由变化。

## 2. 已整合的软件与实际边界

| 范围 | 已有能力与证据 | 仍需完成 |
| --- | --- | --- |
| B1/B2 通信、认证 | 固定证书 TLS/WS、配对/撤销、持久化序号/去重/outbox、ACK 重传；业务连接先经过恢复请求 ACK 屏障 | 管理 UI/CLI、凭证轮换后的业务宿主更新流程 |
| B3 资源协议/画像 | TS/ETS schema 与 fixture 对齐，目录/画像投影、证据 TTL、同机多持有者资源合并 | OS 采集与常驻上报装配、逐字段剩余消费者；**T2 未冻结** |
| B4 持久化账本 | 原子资源准入、签名额度、fence、取消不释放、UNKNOWN 保留占用、跨重启状态查询 | 常驻额度续期/缩额 ACK、真实外部引擎 UNKNOWN 对账与运维入口 |
| B5 制品 | 协调者与 PC HTTPS 端点、作用域短期票据、内容哈希/schema/大小、缓存限额、中继；执行输入输出已接入 | 受信路由/签票管理接口、transferPlan 自动选择、方向链路观测与画像自动连接 |
| B6 执行 | `PcAgent` 宿主类整合队列/连接/账本/追踪；真实 CPU 裁剪、归一化；进程终止后才结算 | 完整业务安装/启动 CLI、生产宿主装配；GPU 执行器未实现，只有健康判断辅助函数 |
| B7 微观调度 | 多资源匹配、按池资源时间计份额、老化、有界连续服务、允许配置、credit、所有者变化时让出 | OS 所有者活动采集、YieldNotice 网络反馈、checkpoint、完整排空估计与长期公平性覆盖 |
| B8 实验室 | `lab:test`：固定种子/虚拟时钟；资源、fence、依赖、取消、重放不变量；真实 TLS 与独立恢复进程用例；整合业务用例 | R5 要求的完整多设备矩阵及故障组合，尤其 SDK+agent 同机、模拟 CPU/GPU 共享 RAM、低电量/高温/慢链路/掉线组合 |
| B9 鸿蒙 agent | 已有共享 v2 ETS 协议基础 | 独立 App、HAR/HAP 原生构建、贡献前台模式、系统接口适配；本轮不做真机验收 |
| B10 追踪 | 本地 LOAD/EXECUTE/PUBLISH 实测 span、批量上报、认证查询、关键路径与残差分析、异常计量标记 | SDK 端到端根 span、权威传输 span、完整快照版本传播及成本反馈 |
| B11 可信校准 | 受信包/参考输出、质量阈值、预算、暂停/继续、重启对账、过期、失败冷却、CANARY/ACTIVE；与真实 CPU/同一额度账本连接 | 从首次配对到常驻自动推进的产品入口、证据网络发布/读取、模型/真实平台条件适配 |
| B12 真机检查点 | 未执行 | 按用户要求暂缓；不能据主机测试标为通过 |

这里的“真实 CPU”指本机真实 Node/sharp 子进程运算。测试画像、预算和身份在隔离 SIMULATED 域内；不代表已经测过真实跨设备贡献能力、CUDA 或鸿蒙原生构建。

## 3. 首先阅读的代码

| 路径 | 接续用途 |
| --- | --- |
| `services/pc-agent/src/agent.ts` | `PcAgent` 整合入口，强制能力证据检查、连接状态、队列、回执和 trace 生命周期 |
| `services/pc-agent/src/business-gate.ts` | 业务执行前校验 group/holder/target、完整执行器身份、域、有效期、CANARY/ACTIVE、资源与配置；当前拒绝有模型的执行器 |
| `services/pc-agent/src/artifact-client.ts` | 把受信短期票据接到执行 `read/publish`；校验票据与目标制品一致 |
| `services/pc-agent/src/recovery-client.ts` | 默认恢复模式；可选 LiveControl 在恢复 ACK 后接新业务；重连仍复用持久化 outbox |
| `services/pc-agent/src/durable-ledger.ts`、`channel-journal.ts` | 准入回复和资源同快照提交；当前 epoch 业务结算原子排入 ExecutionReceipt；旧 epoch 走恢复查询 |
| `services/pc-agent/src/device-scheduler.ts`、核心 `micro-queue.ts` | 队列选择、原子准入前后边界、所有者变更、取消和资源时间份额 |
| `services/pc-agent/src/cpu-engine.ts`、`cpu-child.ts` | 独立 CPU 进程，配置应用，输出哈希和退出确认 |
| `services/pc-agent/src/calibration-executor.ts` | 仅安装的可信 case 可执行；评测同样使用 DurableLedger，不能绕过贡献额度 |
| `services/coordinator/src/qualification.ts` | 持久化校准状态机和预算；runner 不明状态保留 inFlight，不能自动重跑 |
| `capabilities/image.crop.v1/manifest.json`、PC `crop-evaluation-pack.ts` | 首个裁剪能力包；左右色块几何/像素参考检查，不以“能返回结果”等同质量通过 |
| `packages/resource-transport/src/index.ts` | 制品服务、固定证书客户端、中继、方向/networkEpoch 链路拟合 |
| `services/coordinator/src/traces.ts`、核心 `trace-analysis.ts` | 写入绑定原 DispatchOffer 的 trace 身份；查询鉴权及计量完整性分析 |
| `services/coordinator/test/agent-integration.test.cjs` | **完整装配示例，先读这个再写业务启动入口** |
| `tests/scheduler-lab/run.cjs`、`deterministic.test.cjs` | 可重复实验与跨进程恢复/整合测试入口 |

`services/pc-agent/README.md` 已同步当前使用顺序；`docs/scheduler-v2/T2-FIELD-CONSUMERS.md` 增加了整合消费者更新，旧表仍保留作逐项审计基线。

## 4. 不应破坏的整合约束

1. **先恢复、后接新业务。** Hello 之前或恢复屏障之前收到的旧 offer 不自动执行；协调者状态查询负责对账。恢复客户端原命令仍默认禁止业务执行。
2. **先落盘、后回应、再执行。** `admit(..., message)` 同一次快照提交资源、fence、ACCEPTED、AdmissionReply 和 offer ACK。RUNNING 必须先于引擎调用落盘。排队但未准入不提前 ACK。
3. **结算与回执一起持久化。** 业务 receipt 写入与 outbox 更新同快照提交。当前 epoch 回执可正常提交；旧 epoch 或恢复路径保留证据，不自动当作新授权。
4. **ACK 丢失只重发。** 已执行 attempt 返回原结果；拒绝过的 dispatch 身份也持久化，不能在收到 ACK 或重启后偷偷转为可执行。参数/身份改变属于冲突。
5. **取消意图不释放。** 所有者 ACTIVE/UNKNOWN 停止新远程准入；本地可取消任务待子进程关闭才结算。没有证据的 RUNNING/UNKNOWN 持续占用，不清账本重来。
6. **业务不能自带批准证据。** PcAgent 的 `qualification` 是受信宿主读取的协调者证据；内部强制 `business-gate`，再执行 `ports.authorize` 的任务/App/数据授权及贡献策略。offer 里没有可自报 ACTIVE 的开关。
7. **评测与业务隔离。** 可信 case、输入哈希、目标、配置、资源上限、预算都绑定评测许可；评测也用同一 DurableLedger。SIMULATED 不得混入 REAL 证据。
8. **输入不是任意 URL。** `artifactPorts` 只使用受信路由服务签发的端点/票据，不直接相信远端任务提供的网络地址。新增公开管理 API 时应保留数据所有者和 App 权限检查。
9. **不伪造追踪完整性。** 当前执行器只有本地 phase span，没有 SDK 根跨度时返回 `ROOT_INCOMPLETE`。快照版本未知时宿主返回 null，不能拿 planRevision 代替。
10. **队列顺序不等于网络顺序。** 不同资源队列可先后准入，dispatch 以不可变 message/attempt 身份去重；共享账本仍做原子多资源检查。不要把乱序准入误改成释放旧 reservation。

Windows 单写者锁已改为规范目录散列命名管道，避免临时 TCP 端口碰撞；其他平台保留原 loopback 锁策略。仍未验断电/网络文件系统。

## 5. 如何复现与验收

环境：Node 22.18.0、npm 10.9.3、TypeScript 5.9.3、Prisma 6.19.3、OpenSSL 3.5.3。保留仓库原 `packageManager` 声明；不要为接手工作擅自批量升级依赖。

在仓库根目录：

```powershell
npm ci
npm run scheduler:v2:test
npm run lab:test
npm run architecture:test
npm run api:build
```

想快速只跑整合链路：

```powershell
npm --workspace @harmony/coordinator run build
npm --workspace @harmony/pc-agent run build
Push-Location services/coordinator
node --test test/agent-integration.test.cjs
Pop-Location
```

测试使用根 `.test/` 下的临时数据库、证书、账本和凭证。不要把这些文件提交或发给协作者。迁移脚本在服务工作目录下运行，所以不能任意改变单文件测试的 cwd。

原交付环境记录的验证结果：

| 检查 | 结果 |
| --- | --- |
| `scheduler:v2:test` | 核心 6 套件/24 项，传输包 1 项，PC 22 项，协调者 40 项，架构规则 18 项通过 |
| T1/T2 协议（包含在上一项） | T1 495 断言、T2 352 检查通过；是 ETS 转译 fixture 一致性，不是原生 HAR 编译 |
| `lab:test` | 确定性 2 项；复用的额度/制品/校准/恢复/业务整合共 9 项；通过 |
| `architecture:test` | 架构和既有 worker/protocol/迁移等检查通过；旧 API 41 套件/326 项通过 |
| `api:build` | 通过 |
| 补丁验证 | 临时 Git index 上从上述 HEAD 应用并核对树；不修改真实 index |

原交付机器日志：`.test/handoff-integrated-v2.log`、`handoff-integrated-lab.log`、`handoff-integrated-regression.log`、`handoff-integrated-api-build.log`。日志不会进入交付补丁。

2026-10-30 接手核对：在 `E:/learning_resource/Harmony_Creation/HarmonyOS/Harmony-cc` 尝试 `npm run lab:test`，构建 resource-transport 时因 TS2307（无法解析 `@harmony/scheduler-core`）中止，尚未进入测试。本机尚未复现上表的通过结果；先核对 workspace 依赖安装及包解析，再按上述命令复验。本次定位修订仅修改文档。

## 6. 协作者建议接续顺序

以下 P0–P2 是接续优先级，沿用 R5 工作包依赖；不能替代其完成标准。先补公共运行基础，再推进多资源协同与 SDK；成员预约、贡献排行榜等场景功能排在架构验收之后。

### P0：把现有装配示例变成可常驻启动的业务 agent

以 `agent-integration.test.cjs` 为可执行参考，替换测试注入的宿主服务，保留 PcAgent 的门控：

- 配对/设备预算授权、受保护的本机配置与凭证存储；生产业务启动/停止命令。
- 额度申请、自动续期、缩额持久化及签名 ACK；断线/过期时不继续消费远程增量额度。
- OS 所有者活动与贡献上限采集，UNKNOWN 按 ACTIVE；接入 `ProfilePublisher` 的持久化序号和有界发送。
- 可信校准状态的网络读取、路由/制品票据服务、任务/App/数据权限校验；不要把测试里的固定用户与虚拟时钟移入生产。
- 校准自动触发、状态变化刷新 `ProfileProjection`、画像/成本反馈、业务队列联动。当前 QualificationService 需要宿主驱动 `advance`，不是已部署的常驻自动服务。

验收：空库/新账本首次接入后不手工改 ACTIVE；可信 CPU 评测完成后才能跑一次业务，断线恢复与租约到期保守退让。

### P1：补完实验矩阵、调度反馈与可解释数据

- 完整 B8 设备矩阵、多个 agent 并发及跨组/同机额度；现有 `lab:test` 不等于 R5 AC8 全覆盖。
- 将 `onYield`、credit、拒绝原因驱动的重规划接到协调者；远端 Cancel 控制消息尚无完整业务处理器，本地队列/所有者取消已经实现。
- transferPlan 自动路由、实际传输方向/networkEpoch 观测、权威 transfer span；当前 LOAD 包含输入获取耗时，不应误称独立纯 CPU 运算耗时。
- SDK 根跨度与跨设备关联；将 actualModel/timings 以及实际测量接入成本学习。当前 CPU 回执如实使用 `actualModel=null`、`timings=[]`。
- 按 T2 消费者表逐项补齐后再冻结协议；不要直接改状态为“B3 已完成”。

### P2：完成多 App、会话与外设的架构验收

按 R5 的依赖推进 C1–C3、C4a、C7a 和 D1–D6，可独立的软件部分并行推进：

- App 通过 SDK 声明能力、输入、等价路径及结果目的地，支持来源设备本地执行；SoleAI 的业务语义保持在 App/能力包中。
- 第二 App 保持独立鸿蒙工程，引用同一 HAR。C7a 用真实缩略图验证接入、同机身份和额度竞争；C7b 再接图像编码与界面。额度继续由协调者签发，不引入本机跨 App 协商。
- 让数据位置、链路和传输成本共同影响执行方案；按 D5 接入电量、温度、供电与使用状态。
- 实现 D6 会话和应用级屏幕展示：校验展示端身份与授权，实际显示后确认，退出/撤销后停止投递，旧视图版本不能覆盖新结果。
- 按 D9/D10 汇总 AC1–AC8：多 App 解耦、通信与数据决策、展示撤销、同机资源竞争均有证据，再进入展示界面与性能对比阶段。

团队共享算力界面可以复用设备邀请、贡献策略、角色权限和任务反馈。架构验收场景仍须覆盖“来源端输入 → 选择执行与传输方案 → 经授权展示端显示 → 会话或设备状态变化后的正确处理”，并包含第二 App；只展示批量任务分摊到 CPU/GPU 不能代替这些验收。摄像头/传感器借用和完整任务迁移继续遵守 R5 的未来工作范围。

### 真机验收与平台依赖

此前交付按用户要求暂缓真机验收，该状态继续保留。涉及 X 实验、HAR/HAP 原生构建、B12、C9 和 D10 的条目，在接手环境具备条件后按依赖验证；暂缓验收不取消独立 Harmony agent、SDK、第二鸿蒙 App 或屏幕展示的架构要求。原交付机器未准备 SDK/调试手机/CUDA，接手者需重新盘点自己的环境。GPU 须有实际 CUDA 与模型执行证据才能登记为可用；模拟测试不能填作真机通过。

### 已知容量与运维边界

当前通道 outbox 最多 64 条，trace 在 32 条时主动背压，inbox/dispatch 历史上限 4096；业务宿主最多 8 个在途工作。超限保守拒绝，尚无完成记录归档/压缩策略。长期运行接手时应补安全归档，不能删除仍有 UNKNOWN/未确认回执的记录。

## 7. 从 GitHub 接手（推荐）

本次代码及产品文档已纳入 Git 提交，并通过 `codex/scheduler-v2-foundation` 分支交付；无需应用之前发送的补丁。`main` 和原协作分支没有被本次推送覆盖。

已有仓库时，先保存自己的未提交工作，再运行：

```powershell
git fetch origin
git switch -c codex/harmony-b-followup origin/codex/scheduler-v2-foundation
git merge-base --is-ancestor 4a39bba47733e57de4b311bd675e9c8c1a7d0ae8 HEAD
npm ci
npm run scheduler:v2:test
```

`merge-base --is-ancestor` 退出码为 0 表示当前分支包含交接代码基线。示例接续分支名已存在时，请使用自己的新分支名，不要强制覆盖现有工作。

尚未克隆时：

```powershell
git clone --branch codex/scheduler-v2-foundation https://github.com/fangluyang7-debug/Harmony-cc.git
Set-Location Harmony-cc
npm ci
npm run scheduler:v2:test
```

场景参考文档 `docs/Harmony团队共享算力空间功能设计方案.md` 和 `docs/Harmony共享算力空间能力盘点与国赛开发计划.md` 已包含在代码基线中。本次仅修订交接文档，两份参考文档中“以共享算力为总目标”和“演示闭环优先”的表述尚未同步；发生冲突时，以本文件 §1、§6 和 R5 的架构范围与验收标准为准。技术实现的当前状态以本交接和代码为准。

## 8. 历史离线补丁（仅供旧基线接续）

此前生成的本机交付目录为 `artifacts/handoff/20261030-b-integration/`，这些离线文件不纳入本次 GitHub 提交：

- `scheduler-v2-b-integration-cumulative.patch`：从历史起点 `5c63ee3a713f50076d6029059476c15e69afb333` 起的累计代码/技术文档补丁，包含前几轮 A/B 修改和整合，但不包含此次 GitHub 基线说明更新及另行纳入 Git 的两份产品文档。
- `CHANGED-FILES.txt`：补丁内文件清单。
- `SHA256SUMS.txt`：补丁和清单校验值。
- `VERIFICATION.json`：基准提交、补丁可应用检查与树一致性记录。

**已从 GitHub 接手的协作者不要再应用任何历史补丁。此补丁也不能叠加历史 A 或 A/B foundation 补丁。** 仅在无法使用 GitHub、确需从干净的旧基线 `5c63ee3` 接手时使用下面的离线方法：

```powershell
git apply --check C:/path/to/scheduler-v2-b-integration-cumulative.patch
git apply C:/path/to/scheduler-v2-b-integration-cumulative.patch
npm ci
npm run scheduler:v2:test
```

历史补丁排除 `.test`、凭证/证书私钥、数据库、生成代码、node_modules、旧交付包以及两份用户原有产品设计 MD。GitHub 交付则已纳入两份产品文档，仍排除上述本机运行数据与凭证。此次发布只推送交接分支，不部署 Railway、不执行真机验收。

## 9. P0 接续增量：额度维护（2026-10-30）

本次新增 PC `AllotmentClient`，并接入 `PcAgent` 的可选自动续期生命周期。它通过固定证书 HTTPS 申请额度、持久化验证结果、发送签名占用确认；并发调用合并，失败保留原账本与租约期限，缩额 ACK 携带仍在占用的资源。资源策略仍由受信宿主提供，整机预算与同机绑定仍由协调者确认。

这补齐了 B4/P0 的网络额度维护模块。完整业务 CLI、配对管理、OS 采集、校准证据网络服务和自动推进仍未完成；多资源协同、第二鸿蒙 App 与真机验收仍按 §6 接续。

本机已按锁文件安装依赖，原 TS2307 已消除。OpenSSL 位于 `E:/Git/usr/bin`，测试时仅加入当前进程 PATH，未修改系统配置。PC agent 24 项测试、架构规则 18 项通过；新增测试覆盖续期串行化、落盘/ACK 顺序、请求与 ACK 失败，以及真实 HTTPS 下续期、缩额确认和凭证撤销。实验室入口复验通过：确定性 2 项、网络/账本/制品/校准/恢复整合 10 项；构建先由 lab:test 完成，补入 OpenSSL PATH 后直接运行 node tests/scheduler-lab/run.cjs。

## 10. P0 接续增量：画像、证据、校准与设备注册（2026-10-30）

本次接续提交在原额度维护基础上实现以下接口与生命周期：

| 新增部分 | 已落地行为 | 仍需接续 |
| --- | --- | --- |
| 设备注册与配对命令 | 协调者停止时可通过 provision CLI 确认新设备预算、生成私有邀请；PC pair CLI 验证固定证书和域、保存凭证、初始化账本；拒绝覆盖旧绑定/安装目录 | 已有注册的运维对账与凭证轮换工作流；完整业务启动入口 |
| 持久化画像发送 | 画像序号与 outbox 同快照落盘；真实 ACK 才完成；超时/断线保留记录，恢复前禁止新发布 | 完整画像构造、周期采集与发布装配；非计算资源的现场采集 |
| 可信能力证据读取 | GET /v2/qualification/:targetId，按设备凭证的组/持有者隔离、校验执行器身份；PC 默认通过该接口读取，之后仍本地准入 | 权限/路由服务与业务宿主的整体装配 |
| 自动校准推进 | runtime.startCalibration 在服务生命周期内限量轮转目标、校验有效凭证、调用可信 runner 并刷新快照；健康 ACTIVE 状态不空转升级版本 | 跨进程远程评测 runner、可信包安装与配对后自动装配；默认 main 仍未装配 runner |
| 系统资源采集 | 实测 CPU 线程数与总/空闲内存；按贡献上限及自己的在途占用计算本地准入；失败/过期/超时转 UNKNOWN；可选 Windows 当前会话输入空闲信号 | 多用户/服务会话活动源、电池/温度/GPU 适配；不能把未知值填为零 |

PC 宿主已集成可选资源监测和自动额度维护；现有独立命令能完成注册、配对及恢复，完整业务 agent 的默认安装/启动流程仍未交付。P0 未整体完成，后续应接远程评测、任务/App/数据授权和签票服务，再把这些模块装配为业务启动入口。原 C/D 阶段的多 App、通信、数据、会话与屏幕展示要求继续有效。

测试入口仍为第 5 节。真实子进程生命周期用例已显式设置适合主机集成测试的预算，避免继承协议样例的一秒预算；协调者重型集成测试串行运行，减少证书生成和多个引擎相互争抢测试资源。取消、租约到期和未知占用的生产逻辑不因此放宽。Claude Code 只读审查调用返回 API 400，未取得独立审查结论。

本轮验证：`scheduler:v2:test` 全部通过——核心 6 套件/24 项、传输 1 项、PC 26 项、协调者 46 项、架构规则 18 项；T1 495 断言和 T2 352 检查通过。最终源码补充后另通过 PC/协调者类型构建、注册/配对 2 项及系统资源 1 项定向复验。Windows 活动探针已在当前用户会话运行，返回有效粗粒度状态；这不构成多用户、服务会话、鸿蒙或 GPU 验收。未修改旧 API 业务实现，本轮未重跑旧 API 全量测试。

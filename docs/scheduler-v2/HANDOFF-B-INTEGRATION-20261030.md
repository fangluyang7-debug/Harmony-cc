# Harmony 团队共享算力空间：B 阶段软件整合交接

日期：2026-10-30（北京时间）。接收对象：后续协作者。

## 1. 接手结论与本轮范围

本轮按用户最新要求，先完成已实现模块的业务链路整合，**暂不做真机验收，并现在提供交接**。这不是 R5 中 B1–B12 全部完成的声明，也不把此前的模拟测试改称真机通过。

目前可以在本机测试中完整运行：

> 建立协调者 → 配对/安装签名额度 → 未校准业务被拒绝 → 可信评测使用同一账本执行真实 CPU → 能力进入 CANARY/ACTIVE → HTTPS 获取输入 → WS 下发新任务 → 设备队列/原子准入 → CPU 子进程执行 → HTTPS 发布结果 → 持久化回执/WS 提交 → 查询执行 span。

整合测试主动丢弃回执 ACK 并断线，重连后只重发记录，不重复执行；重开账本后已完成任务仍不能再启动。

**交接基线：**

- 仓库：`C:/Users/17321/Desktop/Harmony-final`。
- 分支：`codex/scheduler-v2-foundation`。
- Git HEAD：`5c63ee3a713f50076d6029059476c15e69afb333`。
- 当前修改包含前几轮累计工作，仍在工作区，很多 v2 文件尚未跟踪；没有 commit/push。仅查看 `git diff --stat` 会漏掉大部分文件。
- 需求以 [团队共享算力空间功能设计](../Harmony团队共享算力空间功能设计方案.md) 为产品方向，以 [specification-r5.md](specification-r5.md) 为技术约束。旧购物业务只做兼容回归，不再作为新功能主线。
- 早期 `HANDOFF-STAGE-B`、`HANDOFF-B3-PROFILES`、`HANDOFF-B4-RECOVERY` 是历史记录；与本文件冲突的当前状态以本文件及代码为准。

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

当前验证结果：

| 检查 | 结果 |
| --- | --- |
| `scheduler:v2:test` | 核心 6 套件/24 项，传输包 1 项，PC 22 项，协调者 40 项，架构规则 18 项通过 |
| T1/T2 协议（包含在上一项） | T1 495 断言、T2 352 检查通过；是 ETS 转译 fixture 一致性，不是原生 HAR 编译 |
| `lab:test` | 确定性 2 项；复用的额度/制品/校准/恢复/业务整合共 9 项；通过 |
| `architecture:test` | 架构和既有 worker/protocol/迁移等检查通过；旧 API 41 套件/326 项通过 |
| `api:build` | 通过 |
| 补丁验证 | 临时 Git index 上从上述 HEAD 应用并核对树；不修改真实 index |

本机日志：`.test/handoff-integrated-v2.log`、`handoff-integrated-lab.log`、`handoff-integrated-regression.log`、`handoff-integrated-api-build.log`。日志不会进入交付补丁。

## 6. 协作者建议接续顺序

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

### P2：沿团队共享算力空间目标完善产品

继续围绕建空间/邀请设备、贡献策略、角色权限、资源可视化、自动/指定调度和任务反馈。将底层模块接到路演界面，不回到只支持购物应用的方案。

### 暂缓项：鸿蒙与真机

用户明确暂缓真机验收。后续在环境具备时再做 C1/X 实验、独立 Harmony agent、HAR/HAP 原生编译和 B12；GPU 须有实际 CUDA 与加载模型再注册。目前机器没有已准备好的 SDK/调试手机/CUDA 环境，不能填“通过”。

### 已知容量与运维边界

当前通道 outbox 最多 64 条，trace 在 32 条时主动背压，inbox/dispatch 历史上限 4096；业务宿主最多 8 个在途工作。超限保守拒绝，尚无完成记录归档/压缩策略。长期运行接手时应补安全归档，不能删除仍有 UNKNOWN/未确认回执的记录。

## 7. 给协作者的文件与应用方式

除了本文件，交付目录为 `artifacts/handoff/20261030-b-integration/`：

- `scheduler-v2-b-integration-cumulative.patch`：从上述 HEAD 起的累计代码/技术文档补丁，包含前几轮 A/B 修改和本轮整合。
- `CHANGED-FILES.txt`：补丁内文件清单。
- `SHA256SUMS.txt`：补丁和清单校验值。
- `VERIFICATION.json`：基准提交、补丁可应用检查与树一致性记录。

**此补丁不能再叠加历史 A 或 A/B foundation 补丁。** 若已经拥有当前修改，直接同步工作区/后续正常提交；不要再次 apply。若从干净基准接手，先确认没有要保留的本地修改，再在相同 HEAD 下：

```powershell
git apply --check C:/path/to/scheduler-v2-b-integration-cumulative.patch
git apply C:/path/to/scheduler-v2-b-integration-cumulative.patch
npm ci
npm run scheduler:v2:test
```

补丁排除 `.test`、凭证/证书私钥、数据库、生成代码、node_modules、旧交付包以及两份用户原有产品设计 MD。本产品设计文件在当前工作区仍有未跟踪状态；协作者若没有它，请另附 `docs/Harmony团队共享算力空间功能设计方案.md`。本轮未创建 Git 提交、未推送、未部署 Railway，也未变更其他项目。

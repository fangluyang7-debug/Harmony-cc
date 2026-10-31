# T2 字段消费者核对表

日期：2026-10-30。依据：[修订 5](specification-r5.md) R14 与 WP-B3；接续 [阶段 B 交接](HANDOFF-STAGE-B-20261030.md)。

**T2 仍为草案，未冻结。** 协议格式校验、持久化或哈希绑定不能单独证明字段已改变生产行为。下表列出资源 schema 全部 21 类对象的直接字段；嵌套对象按对应类型递归核对。T1 字段另由原有协议测试覆盖。这里将“有行为消费者”“只有校验/保存”“尚未装配”分开记录，不把后两者算为 R14 全部通过。

路径缩写：核心为 `packages/scheduler-core/src`，协调者为 `services/coordinator/src`，PC 为 `services/pc-agent/src`。2026-10-30 整合新增真实 CPU 裁剪/归一化；TLS、WebSocket、数据库与进程操作真实运行，资源额度与设备画像仍为测试输入，未进行真机验收。下表早期“待 B5/B6/B7/B10/B11”的行以本节更新及最新交接为准，不能据旧表断言相应模块完全不存在。

## B 阶段整合更新

| 字段范围 | 新增行为消费者 | 仍缺的消费者/装配 |
| --- | --- | --- |
| ExecutionConfig 全字段 | CPU 子进程应用 threads/batchSize/quality；微观队列及 agent 校验完整 allowedConfigs | GPU 执行与配置；不能从 CPU 推断 GPU 支持 |
| CapabilityPack / CapabilityAdmission | `qualification.ts` 可信包匹配、质量阈值、预算、暂停/恢复/冷却/证据到期；`business-gate.ts` 在实际执行前拒绝不合格证据 | 常驻自动编排、配对后的证据发布和宿主读取、真实 OS 策略 |
| DispatchOffer 主体与资源/配置 | `PcAgent → DeviceScheduler → PcExecutionRuntime` 实际消耗；准入与回复同快照落盘 | 完整 DAG 就绪与重规划服务、安装/启动入口 |
| TransferHop / Link | HTTPS 上传下载/relay、`artifactPorts` 将任务输入输出接入传输；方向/networkEpoch 拟合已有独立实现 | transferPlan 自动路由、链路观测自动发布及多跳成本闭环 |
| YieldNotice / credits | 微观队列按资源时间计份额，产出让出通知与 credit；所有者变化触发真实 CPU 取消并等结算 | onYield 网络转发、OS 采集、预计排空及 checkpoint 适配 |
| ExecutionReport | 实际 CPU 回执持久化并通过 WS 重传提交；actualModel=null、timings=[] 如实保留 | 模型/后端回退、分段测量入成本模型；不能宣称 timings 已消费完整 |
| TraceSpan | 实际 LOAD/EXECUTE/PUBLISH span 批量上报、查询鉴权、关键路径分析 | SDK 根 span、跨设备传输权威 span、快照版本自动传播；未知时不伪造完整时延 |

完整测试入口：`services/coordinator/test/agent-integration.test.cjs`。T2 **仍未冻结**，下方旧字段盘点保留作逐项审计基线。

## 画像与快照

| 类型与字段 | 行为消费者 | 验证或剩余工作 |
| --- | --- | --- |
| NumericSample / StateSample：`value, source, sampledAt, ttlMs, unit` | 核心 `sampleUsableV2`，协调者 `directory` 的域、时间、量纲、未知和过期拒绝；候选 TTL 取所有门控证据的最早到期点 | `directory.test`、`profile-projection.test`；结构覆盖 `test-resources-protocol-v2` |
| DeviceProfile：`deviceId, holderInstanceId` | 与已认证 Peer 绑定；共享物理池按设备归并，实例按持有者分别保存 | 伪造身份拒绝；双持有者快照及占用汇总测试 |
| DeviceProfile：`deviceInstanceId, ledgerEpoch, sequence` | 重放、实例碰撞、代次及未结算恢复保护；同画像幂等 | `directory.test`、`profile-projection.test`；升代会使旧能力证据失效 |
| DeviceProfile：`domain` | REAL / SIMULATED 及测量来源隔离 | `directory.test` |
| DeviceProfile：`ownerActivity, foreground, charging, powerSave, battery, temperature` | 按本地配置的贡献策略过滤目标；过期和未知保守拒绝 | 逐项安全信号测试；已发布快照的温度证据到期后，纯规划也拒绝目标 |
| DeviceProfile：`pools, executors, links, credits` | 分别进入资源、候选、链路和类别过滤；变化事件后同事务发布快照 | `profile-projection.test`、`channel.test` |
| Pool：`resourcePoolId, kind, total, ownerReserved, contributionLimit` | 资源池归并、RAM 需求计算、整机可贡献容量上限 | 多持有者测试覆盖 RAM 汇总；五种资源池的完整行为矩阵仍待 B7/B8 |
| Pool：`admissionLimit, occupied, draining` | 新候选的剩余容量检查；共享占用相加；非零/未知占用的池不得直接消失 | 多持有者及删池拒绝测试；不是额度确认或释放证据 |
| Pool：`exclusive` | 当前仅校验总容量不超过 1 | 真正独占资源的跨执行器行为测试仍待补齐，不算全消费 |
| Pool：`drainMs` | 当前仅校验、保存与域检查 | 排空预测/队列反馈消费者待 B7；不能用预测时长释放资源 |
| Credit：`priority, slots` | 贡献策略选择对应类别，零 credit 不产生候选；传入 availableSlots | `directory.test`；类别发送计数、credit 更新与公平性待 B7，credit 当前没有独立采样元数据 |
| Executor：`target, contract, model, resources, configurations` | 执行身份哈希；目标/能力/资源/模型进入规划；任一身份变化使对应资格失效 | `profile-projection.test`、核心规划测试；配置内容尚未驱动真实引擎 |
| Executor：`compute, queue, cold, publish, uncertainty` | 候选可用性与全成本估计 | 现有规划/画像测试；生产测量反馈待 B6/B10/B11 |
| Link：`from, to, fixedMs, bytesPerSecond` | 方向传输成本与有效期 | 核心规划测试；生产链路测量待 B5 |
| Link：`networkEpoch` | 相同方向出现冲突网络代次时不发布该链路；网络变化上报后更新快照版本 | `profile-projection.test`；按代次独立拟合和主动探测待 B5 |
| Link：`metered` | 贡献策略拒绝计费网络 | 现有目录过滤，需补逐字段专项测试 |
| Link：`via` | 当前只接受直连，带中继声明的链路不进入规划 | 直连/中继拒绝测试；中继资源及完整路径选择待 B5 |

## 能力身份与准入

| 类型与字段 | 行为消费者 | 验证或剩余工作 |
| --- | --- | --- |
| ModelManifest：`modelId, version, weightsHash, preprocessVersion, embeddingKind, dimension, dtype, normalization` | 核心 `sameModelV2` 比较完整身份；目录身份变化使资格失效 | 核心规划测试；模型文件验真、加载与后端健康检查待 B6 |
| ExecutionConfig：`id` | offer 允许集合和实际配置检查 | 核心账本、协调者 store 测试 |
| ExecutionConfig：`threads, batchSize, quality` | 当前结构/范围校验、完整 offer 身份绑定 | 真实线程/批量/质量配置待 B6/B7；不得宣称已生效 |
| CapabilityAdmission：`groupId, holderInstanceId, targetId, identity, domain, revision` | 与目录上下文、执行器和数据库修订号逐项匹配；不匹配无候选 | `profile-projection.test` 拒绝跨组/持有者/目标/域/版本；目标变更仅失效对应资格 |
| CapabilityAdmission：`state, quality` | 仅 CANARY/ACTIVE 且质量证据有效才产生业务候选；未发现、等待和暂停不可派发 | `profile-projection.test`、协议额外非法证据测试；自动晋级/受限试运行策略仍由 B11 实现 |
| CapabilityAdmission：`reasonCode` | 目前存储可诊断原因，校验标识合法性 | 尚无原因驱动的恢复动作/UI；不算完整行为消费 |
| CapabilityPack：`packId, contract, executorIds, model, suiteId, qualityThreshold, resourceLimit` | 当前 schema/TS/ETS 校验 | 能力包注册、可信评测、预算和阈值晋级待 B11；没有生产包注册链路 |

## 额度、派发与回执

| 类型与字段 | 行为消费者 | 验证或剩余工作 |
| --- | --- | --- |
| ResourceAmount：`resourcePoolId, amount` | 多资源向量原子准入、占用汇总与预算检查 | 核心账本、PC 账本、协调者额度测试 |
| AllotmentGrant：`allotmentId, groupId, deviceId, appInstanceId, holderInstanceId, ledgerEpoch, coordinatorEpoch, version` | 身份绑定、防重放、SDK/agent 基础额度区分 | `ledger.test`、`allotments.test` |
| AllotmentGrant：`base, extra, leaseRequestId, leaseMs, signature` | 保留基础预算、在线增量、单调时钟期限、请求幂等及验签 | 同上；生产网络循环待 B6 |
| AllotmentAck：`allotmentId, holderInstanceId, ledgerEpoch, coordinatorEpoch, version, persisted, settlementSeq, occupied` | 当前授权匹配、先缩后放、修订号一致性与占用释放确认 | `allotments.test`；不能用普通画像替代 |
| DispatchOffer：`task, target, resources, allowedConfigs, allotmentId, allotmentVersion, leaseMs` | 持久化身份、允许目标与配置、多池准入、额度与期限检查 | 核心/PC 账本及 `execution-channel.test`；实际执行尚未装配 |
| DispatchOffer：`dependencies`；Dependency：`nodeId, planRevision, committed` | 重复依赖校验；未提交依赖或计划版本不一致拒绝准入 | 核心账本；完整 DAG 就绪服务仍待实施 |
| DispatchOffer：`transferPlan`；TransferHop：`ref, from, to, via` | 当前校验、绑定 offer 防篡改、目的设备约束 | 授权制品传输及中继执行待 B5 |
| DispatchOffer：`reasonCode` | 当前只校验/保存 | 可解释调度追踪待 B10 |
| AdmissionReply：`attemptId, holderInstanceId, status, record` | 认证持有者匹配、准入接受/拒绝落库 | `execution-channel.test`、`channel.test` |
| AdmissionReply：`reasonCode, wait` | 当前只校验 | 等待估计更新、拒绝驱动重规划待 B7/B10 |
| ExecutionReport：`receipt, allotmentId, allotmentVersion, leaseId` | 回执与持久化 attempt、lease、fence/计划/实际目标匹配 | `execution-channel.test`、`store.test` |
| ExecutionReport：`actualModel, timings` | 当前只校验 | 实际模型一致性/后端变更归因、分段测量入库待 B6/B10/B11 |
| YieldNotice：`attemptId, kind, releaseMs, checkpoint, reasonCode` | 当前只校验 | 让出执行、检查点以及调度反馈待 B7；预测释放不是结算 |
| AttemptStatusReply：`attemptId, record` | B4 接续已接通 PC 持久化回复、TLS/WS 重传、协调者按查询和完整身份对账；null 不作为未执行证明 | `recovery-status.test`、`recovery-client.test`、PC `ledger.test`；旧回执不自动提交，真实引擎恢复仍待具体适配器 |

## T2 冻结出口

2026-10-31 后续：CPU 宿主已将 OS CPU/RAM、贡献配置、资源占用与持续画像发送装配；任务入口消费能力/目标/资源/配置并通过制品票据执行。`EvaluationChanged` 仅作事件唤醒，许可仍以持久化表为准。新入口及明确简化见 [CPU 宿主接口](../../contracts/scheduling/v2/CPU-HOST-API.md) 与 [设计差距核对](DESIGN-GAP-AND-CPU-HOST-20261031.md)。核心源码未因文本能力接入而修改，T2 仍未冻结。

2026-10-31 增量：`CalibrationWorker` 与 `RemoteEvaluationRunner` 已消费许可中的目标/执行器身份、组/持有者、运行域、账本代次、配置、输入摘要、结果大小与期限，实现跨进程可信校准和能力投影更新。网络许可类型位于 `packages/resource-transport/src/evaluation-wire.ts`，属于当前 Node 控制面扩展；尚未声明鸿蒙 ETS/HAR 已支持这些新接口。完整字段消费者及 T2 冻结状态仍按下列出口核对。

1. 上表“只校验/保存”字段逐项补行为消费者与拒绝测试，或从当前可上报协议中明确删减；不能以 fixture 存在替代。
2. 补贡献状态、credit 等动态信号的来源/有效期契约；当前心跳发送器绝不刷新采样时间。
3. 完成真实平台采集与能力状态发布适配。B4 接续已实现恢复通信的持久化序号/outbox 和重连对账；画像发布及新任务执行尚未合入同一个完整 agent，`ProfilePublisher` 仍为可注入适配层。
4. 完成能力包/模型/链路/排空/实际执行测量相关消费者后再冻结 T2。B3 与 B5/B6/B7/B11 存在交叉依赖，基础接口可继续接续，不能将 B3 标为全包完成。

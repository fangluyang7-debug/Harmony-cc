# Scheduling v2 — T1

本目录是第一批 T1 边界。结构 schema 使用 JSON Schema draft-07；跨字段规则由 `protocol-v2.ts` 与 `SchedulingProtocolV2.ets` 执行。接收端必须同时执行结构和语义校验；**schema 合法不表示通过认证或获得执行许可**。

## 编码与必填规则

所有对象字段必填；未知字段拒绝，未提供字段拒绝。允许未知值的字段显式使用 `null`，不能用 0 冒充未知值。ID 是 1–128 位 ASCII 标识符。版本、epoch、seq、fence counter 是从 1 开始的安全整数。时间单位为毫秒；`deadlineAt`、`expiresAt` 使用 Unix 毫秒，`startMono`、`endMono` 只在同一 `clockDomainId` 内比较。`durationMs` 必须等于二者之差（允许 0.001ms 以内浮点误差）。哈希为 SHA-256 小写十六进制。

`parameters` 与扩展 `payload` 是有界序列化内容，由能力契约/扩展处理器进一步解析及校验；控制信封 `payload` 由 `type` 指定的消息处理器解析，不能仅校验信封就执行内容。当前每个字符串最多 65,536 个 UTF-16 单元，传输层还须施加字节上限（B1）。此实现不提供任意能力输入的默认许可。

`allowedConfigurations`、`allowedTargetIds` 是非空允许集合，不能自行提升权限。`AppIdentity` 必须由认证适配层取得并绑定连接；请求中的身份字段只用于比对。`allowedContracts` 不授予身份真实性。制品授权限 group、App 安装实例、操作和到期时间，ODID 不参与授权。

## 对象作用域

| 对象 | 语义消费者 |
| --- | --- |
| VersionHello / Extension | `negotiateVersionV2` 选择双方支持的最高版本；任何一侧要求但另一侧不支持的扩展拒绝；可选未知扩展忽略 |
| MessageEnvelope | B1 按 messageId 去重，seq 排序，ackOf 确认；senderInstanceId 必须与连接身份一致；coordinatorEpoch 检查代次；traceId 关联追踪 |
| AppIdentity / ArtifactGrant | `allowsArtifactV2` 拒绝跨组、未授权 App、过期或越权操作；签名、凭证和制品哈希验证由适配层完成 |
| TaskContract / TaskInstance / Budget / Target | 规划与准入必须使用目标、位置、预算、质量、隐私与配置限制；IDEMPOTENT_WRITE 必须带业务幂等键；未知不可中断时长为 null |
| Workflow / Alternatives | 节点按拓扑序编码，拒绝环、自依赖、未知前驱和重复 nodeId；等价路径必须具有相同输出契约和质量目标 |
| AttemptRecord / Fence / ExecutionReceipt / AttemptStatusQuery | 持久化执行身份、对账与 `mayCommitReceiptV2` 的当前计划/代次/fence 提交门控 |
| TraceSpan | 同时钟域时长、因果关系与传输标识校验；跨设备不比较绝对单调时间；汇总实现属于 B10 |
| ProtocolError | 版本化、安全错误码；不能包含凭证或制品令牌 |

以上表中 B1、B4、B10 等是后续集成消费者，当前 schema/纯函数测试不代表网络服务或持久化已实现。T2 资源画像与额度消息在 B3 冻结；T3 App 策略和会话分别在 C2、D6 冻结。

## 至少一次投递、至多一次启动

1. 消息以 messageId 去重，但执行身份是认证域 + holderInstanceId/ledgerEpoch + attemptId。换 messageId 不能重新执行。
2. 先在同一可恢复事务内写 ACCEPTED、额度/fence/lease 关联；调用引擎前持久化 RUNNING。相同 attempt 的执行摘要不同返回 ATTEMPT_CONFLICT。
3. 摘要必须覆盖输入引用、契约版本、参数、目标和允许配置；由适配层使用规范化序列化与 SHA-256 生成。核心不获取随机数、时钟或密钥。
4. 重启后的 ACCEPTED 在满足“RUNNING 必须先于任何引擎调用持久化”的本地账本中，构成未启动证据，可持久化 CANCELLED_SETTLED（RECOVERED_BEFORE_START）再回报；这不授权重放旧 attempt。RUNNING 不自动重放，查询旧引擎，无法确定时 SIDE_EFFECT_UNKNOWN；成功但未确认的回执重发。
5. 取消、超时、fence 失效不代表资源释放。`resourcesSettled` 独立于执行状态；CANCELLED_SETTLED 必须为 true。其他终态也可能仍持有驻留资源。未知占用不能变成空闲容量。
6. fence 命名空间是 deviceId + holderInstanceId + ledgerEpoch + counter，不比较不同进程计数器大小。
7. 旧 coordinatorEpoch 的回执仅用于对账；`mayCommitReceiptV2` 拒绝直接提交，必须经当前有效计划与准入记录再次匹配。
8. PURE 可按策略新建 attempt；IDEMPOTENT_WRITE 保持业务幂等键并查询/重试；TRANSACTIONAL 先查询提交状态；NO_REPLAY 禁止自动重放或本地回退重放。
9. 每个持久化目录只有一个活动写者。未确认旧引擎停止前保留占用；排队改派必须先收到原端持久化的未启动/取消结算确认。
10. outbox 与关键状态同事务持久化，通道至少一次重发。发送队列必须有容量上限，超限断开后先同步状态。遥测不与关键状态混写。

## 校验边界与下一阶段

阶段 B 基础更新：`resources.schema.json` 与 `ResourcesV2.ets` 是 T2 草案，字段消费者仍未全验收，不标记冻结。`control.schema.json` 约束邀请/凭证、身份、额度申请及签名 ACK。

当前 WS 的 DispatchOffer payload 为完整 T2 DispatchOffer；AdmissionReply 为 T2 AdmissionReply（包含 AttemptRecord）；ExecutionReceipt 为 T2 ExecutionReport（包含 receipt、allotment/version/lease 等）。协调者保存完整 offer，实际目标与配置必须与之匹配。阶段 A 的单独 TaskInstance 派发不再用于新消息；数据库旧行可读取恢复，不重发旧派发。

额度租期使用执行方申请前持久化的单调起点 + leaseMs；网络等待包含在内，启动后旧在线期限清零。grant 的 signature 对去掉 signature 的 canonical JSON 使用 SHA-256/RSA。SignedAllotmentAck.signature 对 canonical ack 使用 HMAC-SHA256，密钥为 bearer token 的 SHA-256 原始字节。服务端同时要求有效认证，不能把签名 ACK 当作独立永久凭证。settlementSeq 随准入与结算两种占用变更单调递增。

`npm run protocol:v2:test` 使用同一 fixture 执行 TS 与 ArkTS 文件的转译结果，并使用 JSON Schema 检查结构；不是原生 ArkTS 编译证明。C1 必须执行 HAR 构建并处理平台限制，不能把此结果标成真机通过。

`mayCommitReceiptV2` 只是提交门控。调用者必须先验证凭证、当前有效 attempt、允许的目标/配置、输入摘要及输出制品。传入的 record 必须来自持久化准入记录，禁止信任远端自报记录。

## B4/B6 恢复通信增量（2026-10-30）

- `RecoveryRequest` 的 payload 为严格空对象 `{}`；组和持有者仅取认证连接。协调者将该持有者的未结算 attempt 派发替换为状态查询，已有当前代次、未确认查询复用；不会新建 attempt。它只适用于恢复流程，不能作为常规任务领取轮询。
- `AttemptStatusReply` 使用 T2 结构，信封 `ackOf` 必须指向当前代次的 `AttemptStatusQuery.messageId`。原 attempt 记录仍保留其原始协调者代次和 fence，不能改成当前代次冒充新授权。完整执行身份、额度、lease、目标和配置均匹配后才能保存对账证据。
- `record=null` 表示本地未找到记录，不能证明旧执行没有发生；未知准入转人工核实，已知记录突然丢失拒绝覆盖。查询本身不是资源结算或额度释放。
- 终态资源未结算仍允许回报（如结果已完成但模型驻留）；后续相同执行结果可将 `resourcesSettled` 从 false 升至 true，不能回退或改写结果。恢复结果不会自动标记节点 COMMITTED，也不会修改签发者的额度预留。
- PC `ledger.json` 升为带 `format:2` 的单快照封装：原账本、发送序号、接收去重记录和 outbox 一起校验、提交。旧无 format 封装先验原校验和再迁移，不创建第二份独立资源账本。
- Hello 为每条连接的版本协商，不推进业务消息接收游标；同 ID 内容冲突仍拒绝。否则新 Hello 的较大序号会误拒绝重连前已持久化但尚未发送的旧 outbox。业务消息仍严格有序，重复 ID 按持久化去重处理；ACK 不触发 ACK-of-ACK。
- 客户端校验来源 CA、主机名、证书固定值、协调者 ID/代次及 REAL/SIMULATED 域。身份不匹配不发送状态。旧代次待回复信封被 supersede，但本地 attempt/receipt 一直保留，等待新代次查询。
- 每个本地 outbox 最多 64 条/1 MiB，inbox 最多 4096 个去重标识；满时保守停止写入新消息，不丢弃未确认消息或清空资源。尚未实现安全历史压缩。连接帧 256 KiB、输入队列 64 条；未确认发送超时断开后重连，不通过轮询领取任务。
- `reconcileEngine` 仅接受本地受信引擎适配器。探测异常、仍运行或 UNKNOWN 不释放资源；SETTLED 必须通过账本的真实目标、配置、fence 和结算检查。未接入真实 CPU/GPU 引擎前，仅可用测试替身验证该接口。

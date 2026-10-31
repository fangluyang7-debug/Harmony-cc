# B4/B6 接续：持久化恢复通信与状态对账

> **历史记录（2026-10-31 标注）**：本文是当时的实现过程记录。现行方向、规则与执行顺序以 [规格修订 6](specification-r6.md) 和 [STATUS.md](STATUS.md) 为准；本文中的“下一步”、优先级以及云端相关建议已不再适用。

日期：2026-10-30。接续 [B3 画像交接](HANDOFF-B3-PROFILES-20261030.md)，依据 [实施规格修订 5](specification-r5.md) 的执行身份、持久化、恢复和资源结算规则。

## 本轮结论

工作包范围：B4 的恢复闭环，补齐其依赖的 B6 恢复客户端适配。**恢复通信增量按替身验收交付；不将 B4/B6 整包标为完成。** 网络、TLS、SQLite、文件持久化和独立 Node 进程真实运行；执行结果和外部引擎证据使用测试替身，未接入真实 CPU/GPU 执行器。

代码仍位于 `codex/scheduler-v2-foundation`，HEAD `5c63ee3a713f50076d6029059476c15e69afb333`。保留此前未提交改动，不修改购物业务流程，不提交或推送，不覆盖旧补丁。

## 已完成的行为

1. **账本与恢复消息同一快照。** PC `ledger.json` 使用 format 2 封装，将资源账本、持久化发送序号、接收去重记录及 outbox 一并校验与提交。旧无 format 文件先校验旧校验和，再原地升级；初始化标记存在但文件缺失仍拒绝空账本启动。没有另建第二份资源真相。
2. **状态查询双向闭环。** 协调者发送 `AttemptStatusQuery`，设备读取本地账本，将 `AttemptStatusReply` 与 inbox/outbox 一起落盘再发送。回复的 `ackOf` 指向原查询；收到 ACK 才删除待确认回复。重复查询不生成另一份执行结果，改内容重用 messageId 拒绝。
3. **恢复请求不授予执行。** 新增 `RecoveryRequest`，payload 只能是 `{}`，组与持有者来自已认证连接。协调者持久化该持有者未结算任务的状态查询，并 supersede 原派发，不新建 attempt。它是恢复事件，不能用作常规任务领取轮询。
4. **重启不重放旧任务。** ACCEPTED 根据“RUNNING 先于引擎调用持久化”的不变量，结算为 `CANCELLED_SETTLED / RECOVERED_BEFORE_START`。RUNNING 及其他无法确认释放的记录进入 UNKNOWN，保留资源、旧 fence 和执行身份。不能重新 begin 旧 attempt。
5. **严格核对远端状态。** 校验当前查询、组、持有者、物理设备、执行摘要、用户/App、原计划/代次、额度、lease 和 fence；回执另校验完整实际目标与配置。丢失 AdmissionReply 时可通过完整账本记录恢复。`record=null` 不视为未执行证明；已知记录突然丢失拒绝覆盖。
6. **结果与资源分开。** 任务成功但 `resourcesSettled=false` 时继续视为未结算；相同结果可后续从未结算升级为已结算，禁止回退或改写结果。恢复结果仅作为对账证据，不能自动提交当前计划。查询和回复均不修改签发者的额度预留，收回额度仍须原有签名确认流程。
7. **真实加密连接和独立恢复进程。** PC RecoveryClient 校验 CA、主机名、证书固定值、协调者 ID/代次和运行域，提供显式连接、自动退避重连、停止、发送缓冲/输入队列/超时限制。独立 `recovery-main` 进程只恢复已有账本，不接受新任务执行。
8. **外部引擎恢复接口。** `reconcileEngine` 仅调用本地受信 probe，不暴露启动/重试方法。异常、UNKNOWN、仍运行均保留占用；明确结算证据必须通过账本匹配校验。结算与新的恢复通知同快照提交，在线宿主随后调用 `client.flush()`；断线时等待重连发送。具体 CPU/GPU 引擎 probe 尚未实现。

## 本轮文件

| 范围 | 文件 |
| --- | --- |
| 核心恢复 | `packages/scheduler-core/src/ledger-v2.ts` |
| PC 持久化 | `services/pc-agent/src/durable-ledger.ts`；新增 `channel-journal.ts` |
| PC 连接与进程 | 新增 `services/pc-agent/src/recovery-client.ts`、`recovery-main.ts`、`engine-recovery.ts` |
| 协调者对账 | `services/coordinator/src/store.ts`、`channel.ts` |
| 协议 | `contracts/scheduling/v2/schema/channel.schema.json`、`SEMANTICS.md` |
| 测试 | PC `test/ledger.test.cjs`；新增协调者 `test/recovery-client.test.cjs`、`recovery-status.test.cjs`；`control-schema.test.cjs` |
| 依赖及说明 | PC `package.json`、根 `package-lock.json`、两个服务 README、T2 字段消费者表及本交接 |

PC 显式声明 `ws` 与 `@types/ws` 依赖，复用仓库现有版本范围，理由是独立客户端需要 WebSocket 及其类型；没有引入另一种传输框架。`npm install --package-lock-only --ignore-scripts` 更新 workspace 依赖记录；没有运行 audit fix、工具升级或生产数据库迁移。

## 验收场景

所有下列算力/引擎部分均为【替身】；不标为手机或真实 GPU 验收。

- 协调者与 holder 同时重启：一个 RUNNING 任务保留占用，一个 ACCEPTED 任务确认未启动后结算；其中一个准入响应故意未送达，仍能恢复身份。
- ACK 丢失后断线：相同持久化回复在重连后重发，较新的 Hello 不会阻止旧 outbox；同 attempt 不新增执行记录。
- 独立子进程启动恢复 CLI，读取已有账本并回报后续结算；旧成功结果仍为未自动提交的对账证据。
- 自动重连后，本地引擎替身提供结算回执，显式 flush 更新协调者状态，不启动新 attempt。
- 伪造证书固定值拒绝；状态查询跨组、持有者、设备、代次、执行摘要、lease/fence、状态组合错误拒绝。
- 本地记录丢失不是释放证据；外部引擎探测失败/仍运行不释放；错误 fence 的“结算”不释放。
- 旧文件格式升级不丢记录；journal 满时拒绝新增消息，之前提交的 outbox 与占用保持不变。
- 已成功但资源仍驻留的回执可以后续结算，同一结果不能回退或改写。
- 对账前后签发者 Allotment 预留逐字保持一致，证明状态回复没有偷偷释放容量。

开发过程中完整测试曾捕获主动 close 与最后一条 ACK 并发时的误报；关闭期间的预期发送中止现已区分于运行中的错误，保留原断言重测，不放宽测试预期。

## 协议与存储边界

- Hello 仍必须首先发送、通过版本/凭证/代次检查，并按 messageId 检查内容冲突；它不再推进**业务消息**序号游标。原因是恢复时必须先握手再重发旧 outbox。业务消息的乱序拒绝保持生效，ACK 不产生 ACK-of-ACK。
- 客户端跨协调者代次时 supersede 旧查询的待回复信封，但保留账本和回执，等待新代次重新查询；协调者 ID 变化或代次倒退拒绝连接。
- outbox 最多 64 条/1 MiB；inbox 最多 4096 条。尚未做安全历史压缩，达到上限须停止并处理，不能自动丢弃去重历史。每帧 256 KiB，待处理输入 64 条；发送/握手超时后断开恢复。
- 快照本地写入仍采用 write + fsync + rename 与单写者锁；验证范围是 Windows 本地文件系统及进程崩溃，不包含断电或共享网络盘。
- CLI 配置格式及运行命令见 [PC README](../../services/pc-agent/README.md)。配置中的凭证只在本机使用，不写日志/补丁。命令要求已有初始化标记；不因路径错误创建新的空资源账本。

## 接续顺序

1. **B5 制品通道**：对象范围授权、短期令牌、HTTPS 上传/下载/中继、大小/哈希/schema 验证及网络代次测量；输入引用不能换成任意 URL。
2. **B6 真实 CPU 执行路径**：复制改写纯计算叶子，实现 crop/normalize，装配可信能力准入、制品获取、额度、画像、执行、结算和发送循环。不得 import v1 worker。把当前恢复客户端与画像发布器收拢进同一个宿主，真正接上本地引擎 probe。
3. **B7/B8 队列与实验室、B10/B11 追踪/自动评测**：补公平性、所有者保护、测量和能力晋级；测试直接注入 ACTIVE 仍仅用于 SIMULATED。
4. **B3/T2 冻结出口回查**：仍缺多个字段的完整行为消费者，不因本轮状态回复已接通而宣布 T2 冻结。
5. **真机环境**：手机 SDK、HAR 原生构建、手机+PC/GPU 实际执行继续单独验收。没有真实设备证据前不能宣称路演完整闭环已完成。

尚未完成：新任务自动准入与执行、制品通道、真实 OS 采集、真实 CPU/GPU 引擎恢复、在线额度自动续租/签名 ACK、生产能力晋级、长期消息历史压缩。恢复 CLI 不承担这些职责。

## 最终验证

| 命令 | 最终结果 |
| --- | --- |
| `npm run scheduler:v2:test` | 退出码 0；核心 4 套件/18 测试；PC 13 测试；协调者 35 测试；架构边界 18 测试 |
| T1/T2 协议（包含在上项） | T1 495 断言；T2 352 fixture/非法输入检查；不是原生 HAR 编译 |
| `npm run architecture:test` | 退出码 0；原有 worker、protocol、迁移、cloud-shopping、placement 通过；API 41 套件、326 单测通过 |
| `npm run api:build` | 退出码 0；核心、Prisma 生成、Nest 构建通过 |
| `git diff --check` | 退出码 0；仅覆盖已跟踪文件差异，新增文件另经编译/测试验证 |

日志：`.test/v2-recovery-final.log`、`.test/v2-recovery-regression.log`、`.test/v2-recovery-api-build.log`。依赖记录日志为 `.test/v2-recovery-lock.log`；依赖安装报告不等于已完成安全审计。本轮没有升级依赖以外的工具，没有运行 audit fix，没有部署或迁移生产服务。

# 跨设备资源协同 v2：通信与资源账本阶段交接

日期：2026-10-30。规格：同目录 `specification-r5.md`（文档 36 修订 5）。本记录接续 `HANDOFF-20261030.md`，不覆盖阶段 A 的历史交付记录。

## 接手结论

仓库：`C:/Users/17321/Desktop/Harmony-final`；分支：`codex/scheduler-v2-foundation`；HEAD：`5c63ee3a713f50076d6029059476c15e69afb333`。本轮仍为本地未提交修改，未推送。此前 Java 插件仓库未修改。原有两份未跟踪的团队设计文档未修改、未纳入补丁。

本轮推进的是阶段 B 的通信与资源账本基础，**不是 B1–B12 整阶段完成**。配对、TLS/WebSocket、额度、持久化准入和替身回执已联调；尚不能启动一个完整 PC agent 或宣称手机与 PC 已协同执行。

| 工作包 | 当前状态 | 完成内容与剩余边界 |
| --- | --- | --- |
| A1–A6 | 保留此前完成-替身状态 | v1 回归仍须通过；新 T2 已替换协调者新增 offer 的线格式 |
| B1 | 完成-替身 | 认证 WS、Hello、持久化去重/序号/ACK、重连、epoch、背压；新派发后由调用者显式 flush |
| B2 | 完成-替身 | 一次性/过期邀请、二维码载荷、凭证轮换/撤销、CA + 主机名 + 指纹固定；管理 API 暂无 UI/CLI |
| B3 | 部分完成；T2 草案，未冻结 | 20 类资源协议与 TS/ETS fixture、设备目录、过期与未知拒绝；完整字段消费者、能力状态协议、画像事件/心跳生产适配尚缺 |
| B4 | 账本与额度模块完成替身测试；工作包尚未全验收 | 原子持久化、签名额度、整机预算、先缩后放、取消后结算、崩溃恢复已测；独立 agent 事件循环、AttemptStatusQuery/Reply 网络恢复闭环与完整断线对账还需 B6 接入 |
| B5–B8、B10–B11 | 未完成 | 未实现制品通道、真实执行器、微观队列、调度实验室、统一追踪、自动校准 |
| B9、B12 | 未开始真实验收 | 本机未找到 hdc/hvigor，规格中的 E 盘 SDK 路径不存在，未提供可用手机；不能据 ETS 转译测试标为原生构建通过 |

按完整 WP 计，累计 A 的 6 项及 B1/B2 共 8 项完成-替身；B3/B4 不计入完整完成数。不按文件数量或代码行数推算三分之一进度。

## 本轮改动入口

- `services/coordinator/src/channel.ts`：`/v2/channel`；最多 256 KiB 帧、64 条待处理消息、1 MiB 发送缓冲、64 条在途消息。压缩关闭。每条消息重新认证，撤销关闭连接。同持有者新连接替换旧连接。消息处理失败可重试同一个 messageId，因此业务 handler 必须持久化、幂等。
- `auth.ts`、`pinned-client.ts`、`app.ts`：邀请、凭证及 TLS 控制接口。数据库只保存邀请码与令牌摘要。邀请决定 group/principal/device，兑换仅提交 holder；撤销后不允许同 holder 冒充另一物理设备或用户。客户端先校验证书来源与指纹，再发送凭证，并验证响应结构。
- `directory.ts`：画像绑定、序号、代次、域、采样时间检查。同物理设备资源池汇总多个持有者占用；同组目标/设备实例冲突拒绝。候选要求已具备 CANARY/ACTIVE 证据；测试直接写入资格仅限显式 SIMULATED fixture，生产尚没有晋级服务。
- `packages/scheduler-core/src/resources-v2.ts`：20 类 T2 类型/校验器；`contracts/scheduling/v2/schema/resources.schema.json`、60 个 T2 fixture；对应 `ResourcesV2.ets` 仅做共享输入转译一致性测试。
- `packages/scheduler-core/src/ledger-v2.ts`：无 I/O 的多资源原子准入、基础/增量额度、fence、取消和结算状态转移。一个池排空不阻塞不依赖该池的任务。
- `services/pc-agent/src/durable-ledger.ts`：Node 平台单快照提交、单写者、签名校验、恢复、状态/回执导出。见该目录 README 的调用顺序与边界。
- `services/coordinator/src/allotments.ts`：用户确认的整机预算与安装绑定；签发/续期签名额度；所有组的同设备预留合计受限。失联和到期不减少预留；缩额确认后预留取各池 `max(新额度, 尚占用)`。
- `store.ts`：新增 offer 保存完整 T2 描述；准入/回执检查 allotment、实际 target 和配置。A 阶段旧行的 `offerJson=null` 仅用于恢复；新派发必须传 T2。

新增迁移为 `003_channel`、`004_credentials`、`005_dispatch_offer`（完整目录名称带日期前缀）；保留已有数据库，执行正常迁移，不删除库。新 Attempt.offerJson 可空，支持读取 A 阶段旧行。

## 冻结给接续者的安全语义

1. `leaseRequestId` 必须唯一。客户端申请前持久化本地单调起点；截止点是该起点加 leaseMs，网络等待不被扣除。相同请求原样重试返回同一授权，改参数重试拒绝；新请求才续期。重启在线期限归零，旧授权不能重置计时。
2. grant 对除 signature 外的规范化 JSON 做 SHA-256/RSA 签名，公钥来自配对时固定的证书。ACK 对规范化 ack 做 HMAC-SHA256，key 是设备 bearer token 的 SHA-256 原始字节；服务端用所存 tokenHash 校验，Bearer 仍必须有效。轮换后用新令牌重新签确认。
3. `settlementSeq` 是持久化资源账本修订号：准入增加占用、结算减少占用均递增。相同修订号不能报告不同占用。确认必须匹配当前 grant 的 holder、ledgerEpoch、coordinatorEpoch、版本。
4. 预算依据可信物理设备绑定，不根据 ODID 或远端自报设备名授权。同机身份未确认不给额度。agent 无离线基础额度；SDK 基础额度绑定安装实例且不能重复分配。
5. ACCEPTED 与预留先落盘，RUNNING 先于引擎调用落盘。取消、超时、撤销不释放。UNKNOWN 持续占用，外部引擎停止需真实证据。重复 attempt 返回原记录；输入、参数、完整 offer 变化则拒绝。
6. SQLite 协调者额度事务与执行方快照之间不是分布式原子事务；协议靠“先预留、后授权；先持久化缩额、后确认释放”保持保守。丢失任一步会占住额度，不会制造额外容量。
7. Windows 已测进程崩溃和目录单写者；没有断电/网络盘测试。任何存储损坏、初始化标记存在但快照缺失均拒绝空账本启动。

## 线协议变更

- `DispatchOffer` 的 payload 现在是完整 `DispatchOfferV2`，不再是单独 TaskInstance。
- `AdmissionReply` 的 payload 是 `AdmissionReplyV2`，ACCEPTED 中包含持久化 AttemptRecord，REJECTED 不创建 fence。
- `ExecutionReceipt` 的 payload 是 `ExecutionReportV2`（含 receipt、allotment/version/lease、actualModel、timings）；旧 epoch 的回执只用于对账，不能直接提交当前计划。
- `DeviceProfile` 接入 T2 画像。额度申请/确认走 HTTPS；结构见 `control.schema.json`。
- `AttemptStatusQuery` 仍由恢复 outbox 发出；客户端可用 DurableLedger.status 查询本地记录，但自动应答及服务端状态对账 adapter **尚未接上**。接续优先补齐这一项，不能用自动重试旧 attempt 替代。

## 验证方法

环境：Node 22.18.0、npm 10.9.3、TypeScript 5.9.3、Prisma 6.19.3、OpenSSL 3.5.3。保留项目原 npm packageManager 声明，未擅自全局升级。

```powershell
npm ci
npm run scheduler:v2:test
npm run architecture:test
npm run api:build
```

`scheduler:v2:test` 顺序运行核心、T1/T2 协议、PC 账本、协调者及架构边界测试。协调者测试会构建 PC 账本适配器，不依赖预先存在的 dist。测试目录位于根 `.test/`，不会打包。

本轮验收重点：认证 TLS/WS 真实连接 + 替身结果的完整链路；错误指纹、过期/复用邀请、撤销凭证；乱序/重复消息与背压；共享 RAM 超配拒绝；不同 fence 命名空间；取消不释放；同设备先缩后放；基础额度不重复；子进程在 RUNNING 后/结算后直接 exit，重启不重复启动；损坏/丢失账本拒绝启动。测试不声称 CPU 裁剪、GPU 模型或手机执行真实通过。

最终测试数量与日志见下方“最终验证记录”，应以本次实际运行输出为准。

## 接续顺序与未完成项

1. 完成 B3：补能力准入状态 schema，建立逐字段消费者清单。model、pack、link.networkEpoch/relay、实际耗时、yield 等已有结构但还没有对应生产服务；不要宣称 T2 已冻结。把 DeviceDirectory.snapshot 接入快照发布，并完成事件上报/心跳和多持有者设备快照一致性测试。
2. 收拢 B4/B6 恢复：独立进程连接、持久化发送序号/待 ACK 回执、AttemptStatusQuery/Reply 双向处理、外部引擎恢复对账。旧 ACCEPTED 目前也保守标 UNKNOWN，需要在有未启动证据时结算；不得把恢复流程改成清空预留。
3. B5 制品：授权范围、短期令牌、HTTPS 上传下载/中继、大小/哈希/schema 验证；链路按方向和 networkEpoch 拟合。不能直接给现有 offer 的输入引用补一个任意外部 URL。
4. B6 CPU 真实路径：复制改写 v1 纯计算叶子，不 import v1 device-worker；真实 crop/normalize、取消、重启。GPU 必须由实际 CUDA/模型健康状态决定是否注册。
5. B7/B8：资源队列、所有者保护、允许配置、让出/结算、公平性，以及确定性/多进程实验室；当前测试不等于完成 AC8 全集。
6. B10/B11：追踪与可信能力评测；生产派发必须校准晋级，不能保留测试中直接写 ACTIVE 的做法。
7. C1/X 实验/B9/B12：确认 SDK 和真机环境后再原生构建和手机+PC 验收。已有 ETS 文件未原生编译。

## 交接文件与应用

本轮累计补丁为 `artifacts/handoff/20261030/scheduler-v2-phase-a-b-foundation.patch`，包含 A 和本轮 B 基础，不能再叠加旧 A 补丁。在干净的上述 HEAD 上先 `git apply --check` 再应用；已有这些修改的工作区不要重复应用。历史 A 补丁不覆盖。对应校验和与文件清单为 `phase-a-b-foundation.SHA256SUMS.txt`、`phase-a-b-foundation.CHANGED-FILES.txt`。

打包使用临时 Git index，核对真实 index 未变化，排除生成代码、数据库、证书、凭证、测试输出和原有两份团队文档。没有执行 git commit/push；协作者确认后自行提交。

## 最终验证记录

以下命令最终退出码均为 0：

| 命令/范围 | 结果 |
| --- | --- |
| `npm run scheduler:v2:test` | 全部通过；核心 4 套件/18 测试，PC 账本 7 测试，协调者 22 测试，架构边界 18 测试 |
| T1/T2 协议（包含在上一命令） | T1 495 断言；T2 320 fixture/非法输入校验；均非原生 HAR 编译 |
| `npm run architecture:test` | 全部通过；包含 v1 worker/protocol/迁移/cloud-shopping/placement 及业务 41 套件、326 测试 |
| `npm run api:build` | 通过；原有 API Prisma 生成及 Nest 构建 |
| `git diff --check` | 通过 |

本机日志：`.test/v2-stage-b-final.log`、`.test/v2-stage-b-regression.log`、`.test/v2-stage-b-api-build.log`。日志是本地验证证据，不纳入源代码补丁。暂未执行 `npm audit fix` 或无关依赖升级；安装报告的依赖安全项需要另行评估，不把测试通过等同于安全审计通过。

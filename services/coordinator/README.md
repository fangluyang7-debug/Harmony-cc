> 局域网演示入口：在根目录构建后执行 `npm run coordinator:lan -- <本机 IPv4> 7443`。证书信任、设备接入及双设备验收见 [局域网指南](../../docs/scheduler-v2/LOCAL-COORDINATOR-20261031.md)。

> 2026-10-31：协作空间首页、成员/设备管理与 Railway 云端协调已落地。访问 https://harmony-space-production.up.railway.app ，接入和验证记录见 [协作空间云端交接说明](../../docs/scheduler-v2/TEAM-SPACE-CLOUD-20261031.md).

# Coordinator v2 — 通信与资源账本基础

2026-11-01，S1：网页与命令行 CPU 任务经过 `PlanningService.plan()`、持久化计划、`preflight()` 后进入 outbox。来源 App 身份按认证 principal/holder/group 签发并保存在 ConsoleApp；任务状态包含真实快照/策略版本，追踪查询包含 PLAN/OFFER 与代理阶段。当前状态以 [STATUS](../../docs/scheduler-v2/STATUS.md) 为准，API 见 [CPU Host API](../../contracts/scheduling/v2/CPU-HOST-API.md)。主部署使用上方局域网入口，下面的历史实现记录不作为开发顺序。

最新可运行入口：设置 `COORDINATOR_CPU_HOST=1` 后启动 main，自动装配内置文本/向量参考包、校准循环和单节点 CPU 任务服务。公开接口包括 `GET /v2/devices`、`POST /v2/jobs`、`POST /v2/jobs/:id/start`、`GET /v2/jobs/:id` 及执行者专用 `/v2/executions/:id/:action`。先提交元数据、取得票据上传输入，再通过 WS 派发；已有非默认组策略不会被覆盖。完整步骤与当前简化边界见 [运行说明](../../docs/scheduler-v2/DESIGN-GAP-AND-CPU-HOST-20261031.md)。旧段落保留各组件介绍，关于未装配入口的描述以此处为准。

2026-10-31：`startCalibration` 现在可以省略 `runner`，使用持久化远程评测。新增认证的 `/v2/evaluations/claim`、`/v2/evaluations/:id`、`/v2/evaluations/:id/report`，PC 通过网络执行本机可信样例。运行方式和边界见 `docs/scheduler-v2/HANDOFF-REMOTE-CALIBRATION-20261031.md`。默认 main 仍需安装能力包并启动该循环。

独立 NestJS 控制面、SQLite 控制状态、事务 outbox、恢复查询和快照规划；包括 WebSocket、一次性配对、设备目录、额度、HTTPS 制品及认证追踪查询。可信校准服务已有可注入的执行适配器，整合测试连接真实 PC CPU 子进程。业务 PC 宿主的安装/启动与管理接口尚待产品化，手机 agent 尚未验收。最新状态见 `docs/scheduler-v2/HANDOFF-B-INTEGRATION-20261030.md`。

在仓库根目录使用 Node 22、npm 和 OpenSSL（本机验证为 3.5.3）：

```powershell
npm ci
npm run coordinator:test
npm run coordinator:dev
```

开发命令依次构建纯核心、生成本服务独立 Prisma Client、构建服务、执行迁移、启动 HTTPS。不加载根 `.env`，不要求购物、COS 或模型配置。默认监听 `127.0.0.1:7443`，证书主机名为 `localhost`。

| 环境变量 | 默认值/语义 |
| --- | --- |
| COORDINATOR_DATA_DIR | `services/coordinator/data/<real 或 simulated>` 的绝对路径 |
| COORDINATOR_DOMAIN | REAL；SIMULATED 使用独立目录和身份，不能把已有目录改成另一个域 |
| COORDINATOR_HOST | 127.0.0.1；只是监听地址 |
| COORDINATOR_PORT | 7443；测试允许 0 让 OS 分配端口 |
| COORDINATOR_CERTIFICATE_HOST | localhost；证书 SAN，需与连接主机名一致 |
| COORDINATOR_OPENSSL | openssl；可指定可执行文件绝对路径 |

`COORDINATOR_DATABASE_URL` 由迁移脚本根据数据目录计算，不使用业务 `DATABASE_URL`。生成的 Prisma Client 在 `generated/client`，不覆盖业务服务的 Client。Prisma 固定 6.19.3；生成命令为 `npm --workspace @harmony/coordinator run generate`。

健康检查：`/v2/health/live` 表示服务存活；`/v2/health/ready` 在恢复完成前返回 503。自签证书必须显式信任；`pinned-client.ts` 同时校验受信邀请中的证书指纹和 TLS 主机名，不关闭 TLS 校验。

| 接口 | 认证与用途 |
| --- | --- |
| GET `/v2/identity` | 启动身份、epoch 和域；配对前可读 |
| POST `/v2/pair` | 一次性邀请兑换；请求不允许自报设备/组/用户身份 |
| POST `/v2/credentials/rotate`、`revoke` | Bearer 凭证；轮换/撤销立即关闭旧长连接 |
| WS `/v2/channel` | Bearer + Hello；持久化消息去重、序号、ACK、重连重发、背压 |
| POST `/v2/allotments/request` | Bearer；额度必须受已确认的整机预算与安装绑定约束 |
| POST `/v2/allotments/ack` | Bearer + HMAC 签名；持久化缩额/占用确认 |
| GET/PUT `/v2/artifacts/:artifactId/:contentVersion` | 短期操作票据 + 设备凭证；组/用户/持有者、哈希、schema、长度、有效期校验 |
| POST `/v2/traces`、GET `/v2/traces/:traceId` | Bearer；写入绑定真实 offer 的 holder/target/workflow/trace，查询按组及读者隔离 |

邀请与物理设备预算只能通过受信本地 API `runtime.auth.invite(...)`、`runtime.allotments.confirmDevice(...)` 建立；没有公开管理接口；新设备可用下文的受信本地 provision CLI 初始化预算与邀请。完整调用实例见 `test/control-schema.test.cjs`、`test/execution-channel.test.cjs`。不要把这些管理方法暴露给任意远端。

首次启动把身份、私钥、证书一起原子写入 `identity.json`。数据目录及生成代码已忽略。数据库已有启动记录但身份文件丢失时拒绝启动，不自动生成一个可以冒充旧身份的新身份。不要把数据目录、数据库或私钥加入补丁。

Windows 单写者使用绑定于规范数据目录的命名管道；其他平台保留 loopback 端口锁。进程退出后 OS 释放。当前只验证 Windows 本机文件系统，不支持共享网络目录上的多主机协调者。

## 接续 API

- `CoordinatorStore.persistOffer`：现接收 T2 `DispatchOfferV2`，同事务持久化完整 offer、OFFERED、当前节点和 outbox。它是内部 API，生产派发还需 B11 的能力准入与业务授权。
- `recordAdmission`：只接收执行方已持久化的 ACCEPTED 及其 fence；协调者不预先制造 fence。
- `recover`：递增启动代次后，对未完成/未结算状态生成幂等状态查询，旧派发被 supersede，不创建新 attempt。
- `flush(send)`：按持久化序号发送。只有 ACK 才移出待确认集合；长连接通过连接/消息事件和显式 `channel.flush()` 推送，生产调度调用者在持久化新 offer 后须触发 flush。
- `receive`：当前有效计划、attempt、fence、目标与配置同时匹配才提交。旧结果只保存对账证据；已提交回执不可用另一组输出覆盖。
- `reconciliationAction`：给出查询、等待结算、业务查询或人工处理建议；即使 PURE 可以新建 attempt，也不重放旧 attempt。
- `requestStatus/reconcileStatus`：认证 RecoveryRequest 触发持久化状态查询；AttemptStatusReply 必须通过当前查询 ID 和完整执行身份校验。未找到本地记录不能作为未执行证明；终态证据只对账，既不自动提交当前计划，也不回收签发者的资源预留。
- `DeviceDirectory.ingest/snapshot`：验证已认证持有者的 T2 画像、域、代次和序号；过期/未知信息不产生可用候选。发现能力只进入 DISCOVERED，不自动批准业务执行。候选有效期包括安全信号、额度与质量证据；删除并重新注册执行器不会复活旧审批。
- `runtime.profiles.configure(groupId, planningPolicy, contributionPolicy)`：受信本地入口，持久化组的目标授权及贡献策略；没有配置的组仅保存画像，不自动授权规划。`DeviceProfile` 事件与更新后的快照同事务提交后才 ACK；重复画像不增加快照版本。快照按设备和持有者分别保存，多个持有者共享池的占用相加。
- `runtime.profiles.refresh(groupId)`：供后续受信评测服务在证据变化后刷新投影；没有远端自报 ACTIVE 的接口。T2 `CapabilityAdmission` 必须匹配组、持有者、目标、执行器身份、域、修订号及有效期；旧的无结构证据失效，不自动迁为审批。
- `PlanningService.plan`：仅使用传入快照、请求、策略和时钟。`preflight` 重新检查组、域、版本、撤销与目标可用性；它不持有资源，最终准入仍属于 B4。

凭证、邀请、画像与额度已有对应服务，其余 metadataJson 表仍是后续对象的存储落点。不得向其中写入业务图像、业务登录态或模型密钥。T2 尚未最终冻结；能力状态机和完整字段消费者验收仍待完成。

本轮接续说明及字段缺口见 `docs/scheduler-v2/HANDOFF-B3-PROFILES-20261030.md` 与 `T2-FIELD-CONSUMERS.md`。画像心跳不会释放额度；它不是账本结算凭证。

恢复通信增量见 `docs/scheduler-v2/HANDOFF-B4-RECOVERY-20261030.md`。WS 新增 `RecoveryRequest`（严格空 payload）与 `AttemptStatusReply`（T2，ackOf 为当前状态查询的 messageId）。Hello 不推进业务序号游标，防止重连握手越过旧待发消息；业务消息的有序校验、持久化去重和凭证检查保持生效。新控制接口不授予执行权限。

## P0 接续：设备注册、资格读取与自动校准

新增本地管理命令 `npm --workspace @harmony/coordinator run provision -- <spec.json> <absolute-invitation-output.json>`。先构建并执行 `db:init`，在协调者停止时使用；它使用相同的单写者锁，拒绝修改已存在的设备预算绑定。规格包含 `address`（将启动服务的 HTTPS 地址）、`deviceId`、`groupId`、`holderInstanceId`、`principalId`、`capacity`（所有者确认的资源向量）。输出含一次性配对信息，只写入指定的新文件，不输出凭据到终端。此命令不会自动发现物理容量，也不会改写已有设备绑定。

`GET /v2/qualification/:targetId` 使用设备 Bearer 凭证，只返回该持有者、设备、组当前注册目标的执行器与能力证据；返回 DISCOVERED 并不授权执行。响应禁止缓存，PC 仍校验身份、有效期、模型和允许配置。移除目标、撤销凭证后不可再读取。schema 为 `control.schema.json` 的 `QualificationResponse`。

受信宿主调用 `runtime.startCalibration({packs, runner, policy, gate, onError, intervalMs})` 后，协调者枚举有效凭证对应的画像目标，定期推进可信评测。每轮限量、单次推进不重叠，持续旋转目标；推进后刷新快照，服务关闭时等待当前评测退出。凭证撤销在下一次准入检查生效；runner 仍必须按许可、额度、实际引擎结算实现。健康 ACTIVE 证据不会仅因周期到来而增加修订号。当前默认 main 尚未安装远程评测 runner，不能把这个宿主接口写成自动远程校准已经交付。

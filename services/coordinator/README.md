# Coordinator v2 — 通信与资源账本基础

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

邀请与物理设备预算只能通过受信本地 API `runtime.auth.invite(...)`、`runtime.allotments.confirmDevice(...)` 建立；没有公开管理接口或现成管理 CLI。完整调用实例见 `test/control-schema.test.cjs`、`test/execution-channel.test.cjs`。不要把这些管理方法暴露给任意远端。

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

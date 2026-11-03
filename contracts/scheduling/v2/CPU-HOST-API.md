# CPU 软件宿主接口（S1—S3，2026-11-01）

用于当前可运行的单节点 CPU 子集，包含注册 App SDK 与来源宿主；多阶段和会话展示尚未实现。协调者须启用 `COORDINATOR_CPU_HOST=1`；设备端请求携带配对凭证，SDK 提交携带独立 App 注册凭证，均使用 `Authorization: Bearer <凭证>`，使用配对时固定的 HTTPS 证书。

## 提交与结果

`GET /v2/devices` 返回 `{ profiles: DeviceProfileV2[] }`，范围为当前凭证所属组。画像中的采样来源与有效期应原样展示；UNKNOWN 不能显示为零。

`POST /v2/jobs` 接收以下元数据，不接收业务输入内容：

```json
{
  "requestId": "client-generated-unique-id",
  "capability": "text.count.v1",
  "contentHash": "输入文件的 SHA-256，小写 64 位十六进制",
  "bytes": 123,
  "targetId": "可选；作为正式规划器的目标约束",
  "budgetMs": 30000,
  "parameters": "{}"
}
```

支持 `text.count.v1`、`vector.normalize.v1`，以及 S2 接入的 `image.crop.v1`。后者目前由鸿蒙 ImageKit 代理贡献，PC 独立宿主仍只发布文本、向量两个目标。requestId 最长 100 字符；输入最多 8 MiB。`parameters` 是可选 JSON 字符串，最多 32 KiB，默认 `"{}"`；被纳入任务执行身份，同 requestId 的参数变化返回 `JOB_CONFLICT`。重复相同请求返回同一任务及新的短期上传票据；同 requestId 的内容、能力或明确目标冲突会被拒绝。身份、App 标识、资源需求和能力契约由服务端派生，不能在请求中自授。

裁剪输入直接上传 PNG/JPEG 二进制，schema 为 `image.raster:1`，不是包装图片的 JSON。参数示例：`{"box":{"x":0,"y":0,"width":0.5,"height":1},"paddingRatio":0,"targetSize":32,"jpegQuality":90}`。box 使用归一化坐标；输出为 JPEG 二进制。先由正式规划器选择已通过参考质量评测的目标，再上传和派发。非法裁剪参数返回已结算的 `FAILED` 回执，不发布输出。该入口没有增加单独的图像调度路径。

主启动方式见 `docs/scheduler-v2/LOCAL-COORDINATOR-20261031.md`。提交经 `PlanningService.plan()`；开始执行前重新规划并经 `preflight()` 复核，最多因快照变化重新规划两次。`budgetMs` 可选，范围 0–30000，默认 30000；0 返回规划器的 `BUDGET_EXHAUSTED`。截止时间从首次登记起计算，上传和重规划不延长它；输入等待期间预算耗尽时不得创建 attempt。目标不合格、无可达链路或预算不足以形成计划时，返回 `NO_LEGAL_PLAN`，不能通过指定目标绕过规划器。`PLAN_STALE` 表示有界重规划后仍未能通过派发前复核，尚未创建 attempt。

协调者为已认证的来源 principal + holder + group 持久化签发临时控制台 App 身份；不是完整 C2 App 注册服务。计划记录真实 snapshotVersion、policyVersion、请求和规划结果。输出大小按参考能力的保守上界估算，当前计划范围是输入中继到执行端并回传中继，来源随后拉取结果的耗时记为 `SOURCE_PULL_NOT_ESTIMATED`，不宣称完整端到端预测。

成功返回 `{ jobId, targetId, deviceId, reason, inputTicket }`。inputTicket 沿用既有 ArtifactTicket 格式。调用既有制品 HTTPS 上传方法传输数据，完成后调用 `POST /v2/jobs/:jobId/start`，正文 `{}`。未上传输入时返回 `INPUT_NOT_UPLOADED`；同任务重复 start 不创建新 attempt。

`GET /v2/jobs/:jobId` 返回 `{ jobId, state, targetId, deviceId, traceId, decisionEvidence, rejection, dispatch, outputTicket }`。outputTicket 只有在成功回执已提交且输出仍在缓存中时提供；调用既有制品 HTTPS 下载方法读取。只有创建任务的 principal + holder 能查询结果。S3 已使用独立 App 凭据；`POST /v2/sdk/jobs/:id/cancel` 持久化取消意图，执行方确认停止并结算前只返回 CANCEL_REQUESTED，不释放占用。使用设备凭据调用 `GET /v2/traces/:traceId`，或使用网页会话调用 `GET /v2/spaces/:spaceId/jobs/:jobId/trace`，可查正式任务的 PLAN、OFFER、QUEUE、ADMIT、EXECUTE、PUBLISH 等跨度；无 SDK 根计时及完整跨端依赖时，分析仍为计量不完整。

文本输入：`{"text":"Hello Harmony\n资源协同"}`；输出：`{"characters":18,"words":3,"lines":2}`。characters 按 Unicode 码点计数，包含换行字符；words 按空白分隔，非中文分词；lines 支持 CRLF/CR/LF，空文本为 0 行。

向量输入：`{"dimension":2,"rows":[[3,4]]}`；输出：`{"dimension":2,"rows":[[0.6,0.8]],"norms":[5]}`。

## 执行者接口

以下接口仅允许该 attempt 的实际执行 holder/device 调用；由 PC 或 Harmony 宿主自动使用，不用于来源客户端：

| 请求 | 正文 | 返回 |
| --- | --- | --- |
| `POST /v2/executions/:attemptId/authorize` | `{}` | `{ offer: DispatchOfferV2, snapshotVersion, inputTicket }`，比对任务、取得真实派发快照版本及输入读票据 |
| `POST /v2/executions/:attemptId/input` | `{}` | `{ ticket: ArtifactTicket }`，READ |
| `POST /v2/executions/:attemptId/output` | `{ bytes, contentHash, schemaId }` | `{ ticket: ArtifactTicket, delivery: "LOCAL" | "RELAY" }`，WRITE；LOCAL 由来源 App 宿主在私有缓存持久化，RELAY 按票据上传 |

票据使用固定的协调者制品端点；输入任务不能自带任意网络地址。业务载荷存放于制品缓存，CpuJob 控制记录只保存引用和元数据。

`POST /v2/link-probe` 使用设备凭据，正文为 `{mode:"upload",bytes,padding}` 或 `{mode:"download",bytes}`，`bytes` 为 1–32768。上传 padding 必须为指定长度的 `x`；下载不允许 padding。返回 `{relayId,padding}`，上传响应 padding 为空，下载响应为指定长度。PC 宿主分别测量两种方向、三个大小的完整 HTTP 请求区间，交给已有 B5 `DirectionalLinks` 拟合，并通过现有画像字段发布。它包括控制开销，不是裸链路单向带宽；网络变化会丢弃旧批次，无观测时 `links=[]`、本地状态 UNKNOWN。当前操作系统计费状态未采集，保守按 metered 处理。刷新约每 20 秒、TTL 30 秒；这是链路采样，不是领取业务任务。

## 事件与错误

业务继续通过原 WS `DispatchOffer` 派发。校准使用同一连接上的 `EvaluationChanged` 提示，payload 为 `{}`；它只唤醒 worker 查询持久化许可，不授予直接执行权限，不要求 ACK。断线重连完成恢复后再查一次；空闲时不周期领取。评测许可和结果仍通过 `/v2/evaluations/*` 交换。

常见可见原因：`NO_AVAILABLE_TARGET`、`ALLOTMENT_UNAVAILABLE`、`INPUT_NOT_UPLOADED`、`JOB_CONFLICT`、`JOB_SCOPE`、`JOB_RECOVERY_REQUIRED`、`CAPABILITY_NOT_QUALIFIED`、`OUTPUT_CONFLICT`。HTTP 错误正文的 message 携带代码；客户端不会打印完整配置或凭证。

当前结果等待超时只表示客户端不再等待，不表示任务已取消。已提交的 requestId 可继续查询，不应直接用新 ID 重复同一操作。完整 SDK 生命周期、DAG、传输规划、会话结果目的地和 App 配额在后续补齐。

### S3 取消与来源本机结果

`POST /v2/executions/:attemptId/control` 正文 `{}`，返回 `{cancel,settled}`；仅已认证的执行 holder/device 可以查询。控制状态查询不要求旧任务仍可新准入，以便旧占用恢复和取消结算。取消意图保存在 CpuJob，查询失败不能当成取消成功。PC 持久化请求并中止执行器，Harmony 在执行安全边界检查；两端都等实际执行退出后才结算，已经成功的结果可能先于取消生效。

来源 App 在私有宿主执行且计划声明本机结果时，结果字节不上传协调者，输出清单与回执仍按原协议提交。SDK 使用同一安装私有缓存读取并验证哈希/长度；跨宿主任务继续通过中继。旧计划没有声明本机结果时保留中继行为。`decisionEvidence.resultDelivery=ORIGIN_LOCAL` 标记此路径；它不表示存储读写耗时已经实测。

### S5 已提交中间结果的 PC 推送

`POST /v2/executions/:attemptId/output` 在保留输出时返回 `{delivery:"RETAINED",descriptor,endpoint}`。在执行回执提交前，生产宿主保存并校验字节，通过 `POST /v2/executions/:attemptId/retained` 发送完整描述。该接口沿用执行宿主身份和活动 attempt 的限制。

`GET /v2/data/deliveries` 使用宿主控制通道凭据，返回当前 holder 和端点代次的待交付项。每项包含 `deliveryId`、作为下游 jobId 的 `attemptId`、`producerAttemptId`、接收端 `endpointId`、`ref` 和 `bytes`。宿主调用 `POST /v2/data/authorizations`，提交 `{deliveryId,attemptId,endpointId,operation:"WRITE"}`。v2 签名另含生产 attempt、交付事项和制品原始硬期限 `artifactExpiresAt`。签发与在线核销均按工作流声明的数据边、父节点当前已提交回执、双方端点、安装实例与下游目的地复核。接收方完整校验后调用既有 receipts 接口。重复确认沿用首次记录的期限。普通来源输入继续使用 v1 授权。

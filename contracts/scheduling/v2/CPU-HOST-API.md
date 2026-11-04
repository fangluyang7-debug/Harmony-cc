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
| `POST /v2/executions/:attemptId/output` | `{ bytes, contentHash, schemaId, retentionFailure?: "ARTIFACT_CACHE_FULL" }` | LOCAL / RELAY 返回 `{ ticket: ArtifactTicket, delivery }`；RETAINED 返回 `{ descriptor, endpoint, delivery }`；详见下文 |

票据使用固定的协调者制品端点；输入任务不能自带任意网络地址。业务载荷存放于制品缓存，CpuJob 控制记录只保存引用和元数据。

`POST /v2/link-probe` 使用设备凭据，正文为 `{mode:"upload",bytes,padding}` 或 `{mode:"download",bytes}`，`bytes` 为 1–32768。上传 padding 必须为指定长度的 `x`；下载不允许 padding。返回 `{relayId,padding}`，上传响应 padding 为空，下载响应为指定长度。PC 宿主分别测量两种方向、三个大小的完整 HTTP 请求区间，交给已有 B5 `DirectionalLinks` 拟合，并通过现有画像字段发布。它包括控制开销，不是裸链路单向带宽；网络变化会丢弃旧批次，无观测时 `links=[]`、本地状态 UNKNOWN。当前操作系统计费状态未采集，保守按 metered 处理。刷新约每 20 秒、TTL 30 秒；这是链路采样，不是领取业务任务。

## 事件与错误

业务继续通过原 WS `DispatchOffer` 派发。校准使用同一连接上的 `EvaluationChanged` 提示，payload 为 `{}`；它只唤醒 worker 查询持久化许可，不授予直接执行权限，不要求 ACK。断线重连完成恢复后再查一次；空闲时不周期领取。评测许可和结果仍通过 `/v2/evaluations/*` 交换。

常见可见原因：`NO_AVAILABLE_TARGET`、`ALLOTMENT_UNAVAILABLE`、`INPUT_NOT_UPLOADED`、`JOB_CONFLICT`、`JOB_SCOPE`、`JOB_RECOVERY_REQUIRED`、`CAPABILITY_NOT_QUALIFIED`、`OUTPUT_CONFLICT`。HTTP 错误正文的 message 携带代码；客户端不会打印完整配置或凭证。

当前结果等待超时只表示客户端不再等待，不表示任务已取消。已提交的 requestId 可继续查询，不应直接用新 ID 重复同一操作。SDK、DAG、传输规划和 App 配额的当前范围以 STATUS 为准；会话结果目的地仍待后续。

### S3 取消与来源本机结果

`POST /v2/executions/:attemptId/control` 正文 `{}`，返回 `{cancel,settled}`；仅已认证的执行 holder/device 可以查询。控制状态查询不要求旧任务仍可新准入，以便旧占用恢复和取消结算。取消意图保存在 CpuJob，查询失败不能当成取消成功。PC 持久化请求并中止执行器，Harmony 在执行安全边界检查；两端都等实际执行退出后才结算，已经成功的结果可能先于取消生效。

来源 App 在私有宿主执行且计划声明本机结果时，结果字节不上传协调者，输出清单与回执仍按原协议提交。SDK 使用同一安装私有缓存读取并验证哈希/长度；单节点跨宿主结果及未声明 S5 保留/直传的计划沿用中继。S5 图内中间结果按下文交付已提交输出。`decisionEvidence.resultDelivery=ORIGIN_LOCAL` 标记来源本机路径；它不表示存储读写耗时已经实测。

### S5 已提交中间结果的 PC 推送

`POST /v2/executions/:attemptId/output` 在保留输出时返回 `{delivery:"RETAINED",descriptor,endpoint}`。在执行回执提交前，生产宿主保存并校验字节，通过 `POST /v2/executions/:attemptId/retained` 发送完整描述。该接口沿用执行宿主身份和活动 attempt 的限制。

`GET /v2/data/deliveries` 使用宿主控制通道凭据，返回当前 holder 和端点代次的待交付项。每项包含 `deliveryId`、作为下游 jobId 的 `attemptId`、`producerAttemptId`、接收端 `endpointId`、`ref` 和 `bytes`。宿主调用 `POST /v2/data/authorizations`，提交 `{deliveryId,attemptId,endpointId,operation:"WRITE"}`。v2 签名另含生产 attempt、交付事项和制品原始硬期限 `artifactExpiresAt`。签发与在线核销均按工作流声明的数据边、父节点当前已提交回执、双方端点、安装实例与下游目的地复核。接收方完整校验后调用既有 receipts 接口。重复确认沿用首次记录的期限。普通来源输入继续使用 v1 授权。


### S5 交付失败与按需中继（PC）

`POST /v2/data/deliveries/failed` 正文 `{authorizationId}`，仅授权的申请宿主可报告。已完成回执优先：响应丢失时保留已确认副本；其余失败只记录本次交付失败，不删除原件，也不重开计算 attempt。

尚未派发的下游在输入准备阶段调用同一 `PlanningService`，按原工作流截止时间排除已失败的直传目的地并比较合法路径。中继方案保存两跳估计和可用并发；变更目的地时更新交付 ID、撤销旧的未使用授权。输入确认前继续拒绝启动计算。

中继交付使用同一 `/v2/data/authorizations` v2 签名。`endpointId` 是协调者身份派生的认证中继，绑定原生产回执、完整 ref、App、下游交付 ID 和协调者代次。业务 PUT 发往签名端点的 `/v2/direct/:authorizationId`，只携带一次性授权与 proof。中继与 PC 复用同一签名传输处理器，在线原子核销并校验全部字节，回执完成后输入才可派发；终态 `/executions/:id/output` 保护继续生效。中继签名路径用于局域网原生 TLS，代理 TLS 模式暂不启用。

中继签名接收与既有制品上传/下载共享 4 个 HTTP 并发槽位；签发另限制最多 4 项未过期的中继上传授权。规划使用可用槽位与两跳成本，实际传输仍在服务端限流。中继验收回执幂等，不延长制品硬期限或业务预算。下游沿原执行输入读取接口从中继下载并校验哈希，复用 LOAD 区间；中继接收增加带传输授权 ID 的 TRANSFER_RECV 区间。不同域区间不直接相加冒充完整端到端。

### S5 精确缺失、容量拒绝与预派发改派

以下接口均使用已有宿主控制凭据；业务传输端点仍只接收一次性授权和 proof：

| 请求 | 正文 | 范围与结果 |
| --- | --- | --- |
| `POST /v2/data/deliveries/missing` | `{attemptId,deliveryId,ref}` | 当前待交付项的发送宿主报告本地缺失；绑定完整 ref 与当前端点代次，返回 `{recorded:true}` |
| `POST /v2/data/missing` | `{authorizationId}` | 仅已核销 READ 的实际数据端点报告缺失，精确标记该副本，返回 `{recorded:true}` |
| `POST /v2/data/rejections` | `{authorizationId,code:"ARTIFACT_CACHE_FULL"}` | 仅已核销 WRITE 的接收端报告缓存不足；授权变为 REJECTED，记录交付失败，返回 `{recorded:true}` |

普通超时或通用 403 只影响路径判断，不证明文件消失。准备步骤先复查已确认副本，再经过同一规划器改派或换路；已有 attempt/outbox 不被覆盖。可对外服务的 C 副本必须来自已确认 v2 收货，沿用 B 已提交回执的数据血缘；本地专用和普通 v1 上传副本不被升级。无可行来源且端点换代、全部认证确认缺失、硬期限到期或剩余预算不足时，图返回 FAILED，并在 `rejection` 中给出 `ARTIFACT_UNAVAILABLE` 及原因，不重算已提交的 B。

生产端仍持有完整输出字节、但 RETAINED 落盘返回缓存满时，可在活动 attempt 上再次调用 output，附 `retentionFailure`。服务端经同一规划器核对固定生产者的中继发布成本及剩余后续预算，成功才返回 RELAY 写票据；不会重新选执行器或创建计算 attempt。接收端缓存满可改为从中继读取到内存消费，仍须由规划器判定可行。终态 attempt 不能调用该接口。

中继的实际剩余缓存字节数进入输入准备的内部容量快照；空间不足时不选择需要新增中继副本的路径。已确认的中继副本仍可下载，合法直传也继续参与比较。该快照不是磁盘预留：并发传输仍以实际写入时的容量检查为准。核销后发生中继缓存满时，由协调者本地签名接收处理器关联同一授权登记 REJECTED 和 `ARTIFACT_CACHE_FULL`，发送者的通用失败报告不覆盖它；不会由发送者任意声明中继容量。无可行输入路径且中继空间不足时，图返回 FAILED，`rejection.code=ARTIFACT_CACHE_FULL`、`reason=NO_FEASIBLE_INPUT_PATH`，不等待原预算耗尽或重新计算已提交节点。

### S5 保留、释放和结果领取确认

| 请求 | 正文 | 返回 |
| --- | --- | --- |
| `POST /v2/data/cache/inventory` | `{epoch,objects:[{ref,bytes,expiresAt}]}`，每批最多 64 项 | `{recorded:true}`；当前端点仅登记待清理清单，不生成可读或可服务证明 |
| `GET /v2/data/retention` | 无 | `{endpointId,epoch,release:[{id,ref,epoch}]}`；按持久化图、实际结算和在途授权生成释放意图 |
| `POST /v2/data/releases` | `{id,epoch,ref}` | `{released:true}`；实际删除文件后确认，重复确认幂等 |
| `POST /v2/sdk/jobs/:id/received` | `{ref,bytes,sourceInterval?:{clockDomainId,startMono,endMono}}` | `{received:true}`；仅任务来源 App，对成功输出的完整 ref 和长度确认 |

中间结果保留至全部依赖消费者提交，并保护未结算执行与有效传输。释放意图使副本不再供新选路；宿主在无传输、缓存快照未变化时删除精确描述和字节文件，再确认。离线或端点换代后使用清单补清理，清单不恢复旧副本权限。最终输出保留到 SDK 完整校验后确认领取，或原任务截止后五分钟与制品硬期限中较早者；下载票据本身不是领取确认。

SDK 结果重复读取和回调复用该任务对象已校验的字节。可用时，来源 SDK 用一次原始提交到完整校验的同域单调区间上报；恢复对象、时钟换代或缺少测量端口时不拼接起点。追踪 `coverage` 提供 `sourceSdkRoot`、`sourceDurationMs`、`criticalPathPending` 和 `reasonCode`；来源耗时已实测也不等于完整跨域关键路径已建立。计量上报失败不改变已校验的业务结果。

### S5 传输追踪、因果投影和分段估计

`POST /v2/data/traces` 使用宿主控制凭据，正文严格为 `{authorizationId,side:"SENDER"|"RECEIVER",interval:{clockDomainId,startMono,endMono}}`。仅接受已 COMPLETED 的 v2 WRITE：发送方绑定该授权的申请凭据和 sender holder，接收方绑定 receiver holder/device；服务端从授权和下游记录核对完整 ref、字节数及生产 attempt。响应 `{recorded:true}`，同一授权/侧的重复报告保留首次记录。制品内容、proof 和长期凭据不进入追踪。

- 发送方记录完整 HTTP 请求区间，`TRANSFER_SEND / FULL_TRANSFER / SENDER`；接收方记录从接收处理到完整校验落盘的区间，`TRANSFER_RECV / PARTIAL_TRANSFER / SENDER`，在回执 RPC 前结束。PC 与中继共用该边界。
- 接收方校验完成可能早于发送方收到 HTTP 响应。因果分析保留接收方就绪节点，不能把它替换成发送方完整区间的结束点。累计传输工作量按唯一权威完整区间计一次；缺失/冲突时标记计量不完整，不取两端最大值。局部接收区间进入已测因果链时仍标明边界不完整。
- 计时上报异步、有界；接收响应和传输槽位释放不等待追踪消费者，失败不改变已完成传输。普通 v1 来源上传没有升级为此范围。

`GET /v2/traces/:traceId` 继续使用既有 reader 权限，增加 `causality:{complete,links:[{beforeSpanId,afterSpanId,reason}],missing}`。读取时把已认证的来源根、持久化的已提交前置、实际派发和已完成收货连接起来，保留原始跨度记录。C 转交给 D 的关联同时要求同一 App 完整 ref、生产血缘和同一进程时钟上先收到后转发；重启或证据不足会登记缺失。查询不执行规划或派发。

`causality.complete` 描述当前因果投影所需记录是否齐备；完整计量由 `analysis.status` 和 `coverage.criticalPathPending` 共同判断。跨时钟未知间隙、部分传输边界或旧 LOAD/PUBLISH 中未拆开的数据传输仍阻止完整关键路径及残差结论。协调者保存规划区间的时钟域，重启后不会把旧进程的单调时间绑定到新进程。

规划时保存对应快照的 EXECUTE、QUEUE、PUBLISH 分段估计；PUBLISH 包含该计划的结果发布传输。读取时仅对快照版本和目标一致的跨度关联该估计。`analysis.predictionErrors` 按段返回 `{spanId,phase,targetId,snapshotVersion,predictedMs,measuredMs,errorMs}`，`errorMs=measuredMs-predictedMs`，保留负值；没有对齐估计的段不补零。LOAD、冷启动和旧传输的完整分解、在途剩余时间仍待后续，不用这些单段误差代替端到端收益。

PC 旧制品 HTTP 路径现在在 LOAD/PUBLISH 内上报传输子跨度：下载为 `TRANSFER_RECV / FULL_TRANSFER / RECEIVER`，上传为 `TRANSFER_SEND / FULL_TRANSFER / SENDER`，成功原因 `RELAY_HTTP_ROUND_TRIP`。区间覆盖本次调用的请求、响应及传输层完整性检查；每次实际请求生成独立 transferId，不复用票据或制品哈希，不记录凭据。输入哈希与输出引用校验仍包含在外层 LOAD/PUBLISH；请求失败同时记录失败子跨度和失败阶段，不改变结算行为。

这些跨度复用已认证的执行追踪批次；与 `/v2/data/traces` 的授权绑定两端跨度分别记录。累计工作量只计算叶子跨度，外层发布阶段的预测误差仍按完整 PUBLISH 区间对照，不因新增子跨度而消失。尚未完成的跨域关联、外层阶段中未拆分的控制/本地处理区间以及资源等待继续保留计量缺口；不能将本次细分标为完整关键路径。当前仅接通 PC，鸿蒙对应细分待实现。

鸿蒙 NativeAgent 同步记录中继 GET/PUT 的 FULL_TRANSFER 子跨度，并在 LOAD/PUBLISH 结束时绑定父阶段。该端的 HTTP 子跨度截至响应完成，后续输入长度/哈希校验包含在 LOAD 外层；HTTP 返回成功但校验失败时，LOAD 仍记录 PHASE_FAILED。传输子跨度不参与前后阶段依赖选择。

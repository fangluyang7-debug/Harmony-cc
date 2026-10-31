# CPU 软件宿主接口（实验性，2026-10-31）

用于当前可运行的单节点 CPU 子集，不代表 T2/T3 已冻结或鸿蒙 SDK 已实现。协调者须启用 `COORDINATOR_CPU_HOST=1`；所有下列请求携带配对所得 `Authorization: Bearer <设备凭证>`，使用配对时固定的 HTTPS 证书。

## 提交与结果

`GET /v2/devices` 返回 `{ profiles: DeviceProfileV2[] }`，范围为当前凭证所属组。画像中的采样来源与有效期应原样展示；UNKNOWN 不能显示为零。

`POST /v2/jobs` 接收以下元数据，不接收业务输入内容：

```json
{
  "requestId": "client-generated-unique-id",
  "capability": "text.count.v1",
  "contentHash": "输入文件的 SHA-256，小写 64 位十六进制",
  "bytes": 123,
  "targetId": "可选；不提供则从当前合格候选中选择"
}
```

支持 `text.count.v1` 和 `vector.normalize.v1`。requestId 最长 100 字符；输入最多 8 MiB。重复相同请求返回同一任务及新的短期上传票据；同 requestId 的内容、能力或明确目标冲突会被拒绝。身份、App 标识、资源需求和能力契约由服务端派生，不能在请求中自授。

成功返回 `{ jobId, targetId, deviceId, reason, inputTicket }`。inputTicket 沿用既有 ArtifactTicket 格式。调用既有制品 HTTPS 上传方法传输数据，完成后调用 `POST /v2/jobs/:jobId/start`，正文 `{}`。未上传输入时返回 `INPUT_NOT_UPLOADED`；同任务重复 start 不创建新 attempt。

`GET /v2/jobs/:jobId` 返回 `{ jobId, state, targetId, deviceId, traceId, outputTicket }`。outputTicket 只有在成功回执已提交且输出仍在缓存中时提供；调用既有制品 HTTPS 下载方法读取。只有创建任务的 principal + holder 能查询结果。本版本没有按 App 独立颁发凭证，也没有远端取消接口。

文本输入：`{"text":"Hello Harmony\n资源协同"}`；输出：`{"characters":18,"words":3,"lines":2}`。characters 按 Unicode 码点计数，包含换行字符；words 按空白分隔，非中文分词；lines 支持 CRLF/CR/LF，空文本为 0 行。

向量输入：`{"dimension":2,"rows":[[3,4]]}`；输出：`{"dimension":2,"rows":[[0.6,0.8]],"norms":[5]}`。

## 执行者接口

以下接口仅允许该 attempt 的实际执行 holder/device 调用；由 PC 宿主自动使用，不用于来源客户端：

| 请求 | 正文 | 返回 |
| --- | --- | --- |
| `POST /v2/executions/:attemptId/authorize` | `{}` | `{ offer: DispatchOfferV2 }`，用于比对收到的任务 |
| `POST /v2/executions/:attemptId/input` | `{}` | `{ ticket: ArtifactTicket }`，READ |
| `POST /v2/executions/:attemptId/output` | `{ bytes, contentHash, schemaId }` | `{ ticket: ArtifactTicket }`，WRITE |

票据使用固定的协调者制品端点；输入任务不能自带任意网络地址。业务载荷存放于制品缓存，CpuJob 控制记录只保存引用和元数据。

## 事件与错误

业务继续通过原 WS `DispatchOffer` 派发。校准使用同一连接上的 `EvaluationChanged` 提示，payload 为 `{}`；它只唤醒 worker 查询持久化许可，不授予直接执行权限，不要求 ACK。断线重连完成恢复后再查一次；空闲时不周期领取。评测许可和结果仍通过 `/v2/evaluations/*` 交换。

常见可见原因：`NO_AVAILABLE_TARGET`、`ALLOTMENT_UNAVAILABLE`、`INPUT_NOT_UPLOADED`、`JOB_CONFLICT`、`JOB_SCOPE`、`JOB_RECOVERY_REQUIRED`、`CAPABILITY_NOT_QUALIFIED`、`OUTPUT_CONFLICT`。HTTP 错误正文的 message 携带代码；客户端不会打印完整配置或凭证。

当前结果等待超时只表示客户端不再等待，不表示任务已取消。已提交的 requestId 可继续查询，不应直接用新 ID 重复同一操作。完整 SDK 生命周期、DAG、传输规划、会话结果目的地和 App 配额在后续补齐。

# v2 错误码

`ProtocolError.version = 2`；码使用稳定标识符，messageId 为对应控制消息，无法关联时为 null。`retryable` 只表示是否值得恢复联系，不授权重放 attempt。

| 码 | 意义 | 恢复方式 |
| --- | --- | --- |
| PROTOCOL_INVALID | 缺字段、未知字段、非法值或跨字段不一致 | 修正输入 |
| VERSION_UNSUPPORTED | 没有共同协议版本 | 升级端点 |
| EXTENSION_REQUIRED_UNKNOWN | 必需扩展不支持 | 协商失败 |
| AUTHORIZATION_DENIED | 组、App、会话、制品授权失败 | 重新授权 |
| CREDENTIAL_REVOKED | 凭证已撤销 | 重新配对 |
| ATTEMPT_CONFLICT | 相同执行身份的摘要发生变化 | 拒绝，不能返回旧输入结果 |
| STALE_EPOCH | 代次已过期 | 对账，不能提交旧结果 |
| STALE_PLAN | 计划已更新 | 对账 |
| FENCE_MISMATCH | 回执与准入 fence 不同 | 拒绝提交 |
| SIDE_EFFECT_UNKNOWN | 无法证明执行或结算状态 | 按 sideEffectPolicy 对账 |
| CAPACITY_UNAVAILABLE | 额度或共享资源不足 | 重新规划/排队 |
| QUEUE_STARVED | 就绪但等待超限 | 先撤销并确认，再改派 |
| MEASUREMENT_INCOMPLETE | 追踪缺失或时钟域不完整 | 保留未知，不制造指标 |
| MEASUREMENT_CONFLICT | 重叠/负残差/计量口径冲突 | 保留冲突，排查采样 |

本表冻结语义；后续组件添加错误处理时必须补正例和拒绝例，不得仅增加字符串常量。

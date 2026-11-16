# 鸿蒙协调中心：手机重新接入被旧交付任务阻塞（R9）

## 现场证据

2026-11-13 通过 HDC 对鸿蒙电脑数据库执行只读查询。手机旧图片 App 的两条 `photo.deliver.v1` 任务创建于 08:14:56，分别为 `130ee5b7-1fd9-4d28-9dd3-a42db162c652.deliver` 和 `d036775f-8fb6-4e36-9571-9f9a0846636e.deliver`。两者属于 epoch 11，状态为 `HOLDER_RECORD_MISSING`，无 admission record、Receipt 或 TraceSpan。历史状态查询已有 ACK；旧派发已 superseded。

`HOLDER_RECORD_MISSING` 由经过身份验证的执行端状态回复触发。旧恢复逻辑保留这一终态，接入检查却要求所有历史 Attempt 具有结算记录，因而手机重新配对到同一空间也被 `SPACE_SWITCH_BUSY` 拒绝。Windows/B 当前无同类阻塞，用户确认两者已可连接；此前短暂连接失败未确定原因。

## 修复与必须保留的行为

- 新增 `CoordinatorUnadmitted.ets`，在协调中心开启新 epoch 的同一事务中收尾历史记录；收到旧 epoch 的否定状态回复时也执行同一收尾。
- 仅处理状态明确为 `HOLDER_RECORD_MISSING`、没有接单记录及 Receipt、任务与执行身份一致、属于旧 epoch 的 PURE 任务。旧 epoch 已无法通过执行授权；不能仅凭超时或没有回执就释放未知执行。
- 状态改为 `CANCELLED`，记录 `recoveryClosure` 原因、旧状态、关闭时间和新 epoch，终止残留 Outbox，保留 Attempt、CpuJob、额度和其他历史。不伪造成功、接单或资源结算回执，不重算照片。
- 重新配对和退出共用 `assertCoordinatorDeviceSettled`；带明确收尾标记的未接单任务不再阻塞。实际存在未结算 admission 时优先阻塞，不能用关闭标记掩盖它。
- 同步 Windows 已有的“任务在派发前取消、没有 Attempt 时允许退出/重配”的判断。未知额度记录、当前 epoch 缺失记录、未结算执行仍阻塞。
- 一台设备一个活跃空间的规则不变；新配对成功后旧设备凭据和业务 App 授权按原流程撤销。图片 App / SoleAI 可能需要重新授权。

## 验证

23 项针对性回归通过，包含原配对/执行/数据库事务，以及新增的手机 App 历史任务阻塞、同空间重新配对、退出、历史保留、重复收尾、当前 epoch 不误放行、已接单任务优先和派发前取消情形。

API24 HAR 与已签名协调中心 HAP 均构建成功。已保留数据覆盖安装到鸿蒙电脑 `5XQ0226206001861`，启动服务为 `https://172.20.10.2:7443`、epoch 28。只读核对真机数据库，两条原任务均自动转为 `CANCELLED`，带 `RETIRED_EPOCH_WITHOUT_ADMISSION` 收尾原因，接单记录仍为 NULL、Receipt 数量仍为 0，原历史保留。

安装文件：`.test/photo-api24-harmony-coordinator/entry/build/default/outputs/default/entry-default-signed.hap`；SHA256：`85a6abd0f673ded35e38493978b07bc816c0a8b573069c325fa619584f287e36`。本轮没有更新手机或 B 的包；中心侧更新即可处理本次阻塞。

证据在忽略目录 `.test/space-busy-diagnosis/`：`before-update.txt`、`after-update.txt`、`closures.json`、`rejoin-running.json`、构建日志和回归结果。手机没有调试连接，实际重新扫码由用户确认；没有执行新的照片性能测试。该修复不改变 GPU 配额、任务分块或模型运行路径。

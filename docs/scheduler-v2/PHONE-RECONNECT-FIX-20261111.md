# 手机重新接入被 SPACE_SWITCH_BUSY 阻止

日期：2026-11-11。分支：`imageprocessing`；本轮为 `df79a6b` 后工作区修改，尚未推送新提交。

## 现象与证据

鸿蒙电脑可以连接，手机能发现同一协调中心 `172.20.10.6:7443`，但重新输入配对码、核对指纹后返回 `SPACE_SWITCH_BUSY`。读取证书指纹及取得明确服务端错误，证明这次配对请求可以到达中心，不能继续笼统归为 Wi-Fi 或防火墙故障。

手机旧图片 App 有 4 条 `AppJobReservation`：

- `cba5f8bc-7a13-4e6d-a383-100f63631f14`
- `14bd8ab7-c6a9-47dd-b517-d233a8a37958`
- `04a95f02-31a9-489d-a937-eff9d1ae306d`
- `e09ed40b-9487-4450-bf46-acc1aad419a6`

四条均有对应 `CpuJob.state=CANCELLED`，没有 `Attempt`。任务在派发前取消，保留了额度历史；旧接入检查把所有没有 Attempt 的额度记录视为未知占用，永久阻止同设备重新配对。此处不是图片仍在后台计算。

原生宿主还存在连续不可达约 20 秒后清除当前配对的行为；中心显式关闭也会清除配对。这能解释断连后需要重配，但没有日志可证明手机本次究竟由哪一条路径触发。本次没有改变该行为。

## 修复与不可覆盖语义

- `services/coordinator/src/device-membership.ts` 新增 `appReservationSettled`：优先检查实际 Attempt；仅当没有 Attempt、同空间同用户的 CpuJob 明确为 CANCELLED 时，允许继续接入。
- `services/coordinator/src/auth.ts` 的退出设备检查复用同一规则，防止已取消任务同样卡住退出。
- 保留全部历史记录；不修改已取消任务为成功，不删除额度表，不因超时推断资源结算。存在实际 Attempt 时，其未结算状态优先，即使 CpuJob 被标为 CANCELLED 也仍阻止切换。
- 一台设备同时只加入一个空间的约束不变。成功重新配对后，旧业务 App 授权按原规则撤销；图片 App / SoleAI 如提示旧授权失效，应重新连接当前空间授权，不能复用旧身份。

## 验证、部署与边界

- coordinator TypeScript 编译通过；App 回归 7/7；设备成员关系回归最终 2/2，覆盖等待输入、无任务的未知额度、过期未知额度、未结算 Attempt、派发前取消后重配和退出、历史保留。
- 首次新增测试因测试夹具缺少调度盘读取的 offer 字段失败，补全夹具后通过；一次从仓库根目录执行测试失败于 migrate 相对路径，切回 `services/coordinator` 后通过。不是所有首次测试均通过。
- 更新本机协调中心 `auth.js`、`device-membership.js` 并重启。重启前暂停 Windows 执行器、关闭鸿蒙电脑调度 App，重启后恢复，避免它们收到关闭通知后丢失配对。
- 使用手机正常 6 位配对码流程完成接入，手机显示“已连接 · 前台贡献”、12 CPU / 10816 MiB；Windows 显示运行中，中心同时存在 `172.20.10.2`、`.3` 和本机的已建立业务连接。USB 只用于调试操作。
- 未进行照片处理或性能复测；手机图片 App 的重新授权留给用户操作。
- 同步更新 `dist/调度系统分发-20261111-r2/01-Coordinator-Windows-x64/01-Coordinator-Windows-x64.zip`，SHA256：`d55266c9928daafeeacbb322bf9fced02f4dc40979030ab7e24dcf3d03129a9c`。这次修复在中心，无需重装手机 HAP。

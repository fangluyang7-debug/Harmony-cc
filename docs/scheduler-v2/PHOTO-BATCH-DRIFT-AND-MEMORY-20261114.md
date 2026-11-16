# 六图协作中断与手机内存修复（2026-11-14）

## 结论与部署

Windows 协调中心和手机图片 App 已更新。中心于 00:20 重启，新进程 PID 39880，HTTPS `/v2/health/ready` 返回 `{"ready":true}`。设备 B 无需更换安装包；中心重启后按原约定使用新配对码重新接入。

协作失败已定位到资格管理错误。手机历史闪退没有保留下来的崩溃报告，尚不能认定确切原因；本轮修复实测发现的重复模型内存问题，并补充系统退出原因记录。

## 协作失败原因

实际轮次 `49b4bdd9-0501-4d70-8559-2fe11dfb735a`：六张 192×128 照片，预算 180 秒，23.016 秒后失败，前五张已交付。第六张工作流 `44ab8aa2-8587-4213-aa6a-675a3b89b9ff` 分析成功，增强步骤先出现 `RESOURCE_UNAVAILABLE`，随后出现 `CAPABILITY_NOT_QUALIFIED`；已经准入的 GPU 分块被工作流取消，手机替代执行收到 `CANCEL_REQUESTED`。

协调中心把成功执行的耗时上升当作计算资格失效。GPU 部分样本从约 55～167 ms 波动到 335～847 ms，触发 `EXECUTION_COST_DRIFT`，资格从第 3 代重置到第 4 代，冷却并重新校准。冷却约在首个拒绝前 93 ms 开始；新一代稍后恢复 ACTIVE，但批次已经取消。

修复：成功执行的耗时只用于成本预测，不因时间波动撤销资格、重跑参考用例。模型、执行器身份变化、有效期及真实参考质量失败仍按原规则处理。没有强制 GPU 胜出，没有跳过实际资源准入。

## 手机处理中退出

Faultlogger 未查到图片 App 历史崩溃报告，滚动日志未覆盖原事件。旧版本轮重放没有闪退，但 VmHWM 达 5,045,740 KiB，约 4.81 GiB。

原模型缓存为 thread_local，鸿蒙 NAPI 工作线程轮换导致多个线程各持有重模型副本。现在鸿蒙进程共享不可变模型，每个任务独立输入、输出及 Extractor；锁只保护模型取得/加载，不串行化推理。shared_ptr 保证配置切换和缓存重置不释放在用模型。Windows 保留原线程缓存策略。

没有缓存照片或成品，没有缩小原图，没有改变模型、精度和处理步骤。新增 `APP_START lastExitReason/lastExitMessage` 日志。安装后的 UpgradeApp 退出原因属于更新，不是历史闪退证据。

## 验证

| 检查 | 结果 |
| --- | --- |
| 协调中心资格集成测试 | 13/13；变慢保持资格，模型身份变化仍重校准 |
| 手机本地、模式切换、展示回归 | 13/13 |
| 原生真实模型并发 | 8 个并发任务输出与串行一致，共享模型及更换/重置生命周期通过 |
| HAR、图片 HAP | API24 签名构建和手机安装成功 |
| 旧版同序六图 | 54.283 秒，6/6，VmHWM 4.81 GiB |
| 新版同序六图 | 54.710 秒，6/6，VmHWM 1.70 GiB |
| 成品 | 六张输出哈希逐一相同 |

旧版进程此前运行过协作/本地任务，新版为新启动进程，内存是实际观测，不是严格同生命周期基准。新版没有复现闪退，不能宣称历史闪退原因已确证。耗时基本相当，不宣称本机加速。修复后的设备 B GPU 整批真机复测尚未进行，留待用户同图测试。

## 修改与证据

- 中心：`services/coordinator/src/qualification.ts`、`services/coordinator/test/qualification.test.cjs`。
- 原生模型：`apps/harmony/scheduler/src/main/cpp/photo-core.h`、`photo.cpp`。
- 退出诊断：`apps/harmony-photo/entry/src/main/ets/entryability/EntryAbility.ets`。
- 原生回归：`tests/sdk/photo-model-cache-native.cpp`。
- 本地证据目录：`.test/photo-failure-20261114/`，含失败摘要、测试日志、手机内存采样和实际处理日志。
- 已安装 HAP：`.test/photo-api24-harmony-photo/entry/build/default/outputs/default/entry-default-signed.hap`。
- HAP SHA-256：`40910deae9b24f24269e946835f8efd3963c81634ac4f3b8bd7835e545f58fe3`。
- 已部署 `qualification.js` SHA-256：`338978b07c00270cb0633115955954142940bc3af4e62062c5c882221eec47d9`，与本地构建一致。

上次 `dist/Harmony-All-Apps-20261113-Final.zip` 未包含本次修复。本轮未覆盖旧合集、未推送 GitHub；鸿蒙原生协调中心也未在本轮升级，当前答辩主线为 Windows 中心。

## 复测步骤

1. 本机中心进入“设备配对”，生成新码。
2. 手机、设备 B 和其他参与节点重新接入；图片 App 恢复协作授权并等待真实就绪。
3. 同一顺序六张照片进行协作，确认六张均交付。
4. 若再次失败或退出，保留现场状态和大致时间，以便提取退出原因及回执。

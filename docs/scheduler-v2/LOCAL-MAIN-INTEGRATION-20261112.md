# 本地 main 整合与应用更新（2026-11-12）

## 来源和边界

按用户确认，在本地拉取协作者 main，再整合 GPU 优化；不回退性能修改，不向远端 main 推送。

- main 基线：`e442b06`（已包含此前 `9f31cd6`）。
- 补入提交：`c65def3`，在本地 cherry-pick 为 `97c2595`。
- 本地工作分支：`codex/main-gpu-integration-20261112`。
- 原备份分支 `codex/imageprocessing-gpu-20261112` 保持不变。本次未推送远端。
- 代码自动合并，唯一冲突在 `MERGE-PROTECTION.md`，同时保留 main 整合记录及 M29。

保留协作者的独立 App 授权、SoleAI 生命周期修复、调度件单一连接/退出入口及在线状态反馈；补入 GPU 模型常驻、最新快照语义复核、工作流等待诊断和无效重规划削减。模型可常驻，业务图片和计算结果不预置、不复用为已完成任务。

## 本地补充修复

桌面回归暴露：退出已登记的空间后，活动绑定清空，但无参数的状态查询/启动会回退到历史默认设备目录，从而可能显示旧配对或启动旧节点。

现在当绑定已有历史且当前活动绑定为空时，无参数状态查询返回未配对，启动要求重新配对；保留首次迁移旧安装的兼容行为，也不删除旧账本。对应回归显式构造历史默认目录，验证退出后不误读、不启动旧配对。

文件：`scripts/runtime-desktop.cjs`、`scripts/runtime-desktop.test.cjs`。

## 构建与验证

- TypeScript / Web SDK / Prisma 构建完成；整合后重编协调器和 PC 节点。
- 共享 HAR、调度连接、图片 App、SoleAI 的签名 HAP 构建成功。
- 使用本机 DevEco SDK API 24（6.1.1），不声称已在 API 22 验证。
- 桌面、App Session、SoleAI 生命周期、本地照片处理、仅展示连接及统一展示页：34 项通过。
- 调度规划与跨设备工作流：21 项通过，包括最新快照复核和并行工作流推进。
- 另有 CPU 原生运行库、照片打包及输入验证 7 项通过；2 项需要显式 Vulkan 设备环境的测试跳过，本轮未验收 NVIDIA 独显硬件。
- 分发目录独立集成：新协调中心启动、6 位码配对、节点上线、5 项照片能力可用；Windows 自动 CPU 额度为 22。使用临时身份和数据目录，未向用户空间提交业务任务。
- 调度测试第一次从仓库根目录调用导致迁移脚本相对路径错误；改在 `services/coordinator` 目录运行后 21 项全部通过，没有因此修改生产代码。

本机日志（忽略入库）：`.test/main-integration-tests.log`、`.test/main-planning-tests.log`、`.test/main-gpu-integration-tests.log`、`.test/main-package-pairing.log`、`.test/main-distribution-r4.log`。

## 鸿蒙安装结果

均使用覆盖安装，未卸载应用、未清理应用数据。

| 设备 | 已更新应用 | 启动检查 |
| --- | --- | --- |
| 鸿蒙手机 | `org.harmonycc.agent`、`org.harmonycc.photo`、`org.harmonycc.soleai` | 三个应用均启动成功 |
| 鸿蒙电脑 | `org.harmonycc.agent`、`org.harmonycc.photo` | 两个应用均启动成功 |

鸿蒙电脑原未安装 SoleAI，本轮没有额外安装手机业务 App。手机最初锁屏，用户解锁后完成启动检查。以上只是安装和启动检查，照片业务与性能复测由用户完成。

## 分发文件

Windows 已更新安装目录 `%LOCALAPPDATA%/Programs/ZhiDiao/` 下的协调中心及设备调度件，并重新打开两个窗口。逐文件校验协调中心 9,426 个文件（更新 38 个）、节点 453 个文件（更新 24 个）。旧文件备份在 `.test/main-install-backup-20261112-030308/`，其中 `manifest.json` 记录修改前后哈希；原中心数据库和设备身份目录保留。

更新后协调中心界面已显示“运行中”，地址 `https://172.20.10.6:7443`，当前空间“本地调度空间”。Windows 节点窗口已打开，但仍显示上一会话的历史配对，需要用户重新配对；本轮未启动其向旧会话贡献。当前无线地址恢复为 `172.20.10.6`，以实际网络变化为准。

本机产物目录：`dist/调度系统分发-20261112-r4/`（未上传）。

- `01-Coordinator-Windows-x64/01-Coordinator-Windows-x64.zip`
- `02-Device-Agent-Windows-x64/02-Device-Agent-Windows-x64.zip`
- `03-Device-Agent-HarmonyOS/Harmony-Device-Agent-API24-signed.hap`
- `04-SoleAI-HarmonyOS/SoleAI-Cooperative-API24-signed.hap`
- `05-Photo-HarmonyOS/Harmony-Photo-API24-signed.hap`

校验值见同目录 `SHA256SUMS.txt`。Windows 包构建基线记为 `97c2595` 加上述桌面绑定修复；HAP 为 `97c2595` 的源码。签名 HAP 使用本机调试 Profile，仅适用于该 Profile 授权设备。

Windows 节点包已带模型、CPU 推理程序和常驻模型版 Vulkan 引擎；NVIDIA 电脑仍须安装显卡驱动。独显机未在本轮安装/测试，不可把本机 CPU 上线验证当成其 GPU 验收。

## 手动复测注意事项

保留 main 的新行为：**每次启动协调中心创建新的会话、证书和数据库**。旧目录保留，但不会自动恢复旧空间。请一次启动后完成一轮测试，不要中途关闭重启协调中心。

1. Windows 启动协调中心，选择与手机、鸿蒙电脑互通的 Wi-Fi 地址，默认端口 7443。
2. 打开设备配对，为 Windows、手机和鸿蒙电脑分别生成邀请/6 位码；每台设备各用自己的配对码。
3. 在各设备调度连接/设备节点中重新配对并开启贡献；调度盘确认三台设备在线、照片增强能力可用。
4. 手机图片 App 再次连接协作空间并授权，回到图片页选取相同顺序的照片。
5. Windows 从协调中心打开“真机任务展示（单机 / 协同）”，再由手机发起处理。仅展示连接与协作计算仍是两条独立链路。
6. 若纳入独显电脑，先更新第 02 包，再在新会话中配对，确认 `PHOTO_GPU_READY` 和调度盘 GPU 能力就绪后测试。

本轮没有代用户执行六张图的性能对照；不能据此声明性能已提升或协作者整合已通过完整真机验收。

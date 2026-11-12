# 鸿蒙原生协调中心手机离线验收

## 基线与范围

- 2026-11-12 拉取 `origin/main` 至 `c6d4970`；原生协调中心主要来自 `5bb4f0d`。
- 独立检出目录：`.test/native-coordinator-main-c6d4970`。当前照片/GPU 优化工作分支与未提交修改未合并、未覆盖。
- 仓库树及 GitHub Release 中未找到已发布的协调中心 HAP；本轮使用 main 源码在本机构建。已有 Release 的照片 App HAP 不是协调中心。
- 用户要求手机离线验收，不测试设备间连接、组网或真实调度，不启动图片任务。

## 当前结果

1. 手机经 USB/HDC 在线，系统报告 API 26；已成功安装并启动 `org.harmonycc.coordinator`，桌面名称“鸿蒙协调中心”。
2. 应用声明支持 `phone`、`tablet`、`2in1`，独立包名不会覆盖原来的设备节点、照片 App 或 SoleAI。
3. API 24 / HarmonyOS SDK 6.1.1 原生 HAR、HAP 构建通过。此结果不是 API 22 构建验收。
4. main 的 31 项原生协调中心逻辑测试全部通过；初次稀疏检出遗漏 migrations 导致的文件缺失已补齐并重跑。
5. 16:30 已通过 DevEco 自动生成独立调试签名并完成 SignHap；HDC 安装与启动均成功。
6. 8 个页面逐一实测可打开：运行总览、设备资源、任务追踪、网络链路、异常恢复、设备接入、应用授权、中心设置。页面空状态正常，不代表各后台业务已实现。
7. 未联网情况下完成两次本地服务启动/停止。日志记录 `TLS_LISTENING`；重开 App 后证书指纹相同，epoch 由 1 增至 2，身份和纪元保存有效。最终停留“中心设置”，服务已停止。

## 产物与日志

- 构建工程：`.test/native-coordinator-main-c6d4970/.test/phone-check-api24-harmony-coordinator/`
- 未签名 HAP：上述工程下 `entry/build/default/outputs/default/entry-default-unsigned.hap`
- HAP SHA-256：`d0a16afcfc6911998351efb699530df3d754f915e8a02eebc78bdbad5ccc954e`
- 本地日志：`.test/native-coordinator-har-build.log`、`.test/native-coordinator-hap-build.log`、`.test/native-coordinator-main-tests.log`。
- 已签名交付包：`.test/native-coordinator-phone-20261112/Harmony-Coordinator-API24-phone-signed.hap`，同目录 `manifest.json` 记录哈希及验收范围。此为针对已连接手机的调试包，不保证其他未授权设备可安装。
- 签名构建日志：`.test/native-coordinator-hap-signed-build.log`；页面检查记录：`.test/native-center-offline-tabs-results.json`；截图：`.test/native-center-overview.png`、`.test/native-center-running.png`。

## 必须区分的能力边界

main 原生 App 包含本地数据库、证书生成、TLS 监听、接入邀请/六位码、配对、资源额度与设备设置服务。页面本身标注“任务调度协议仍在移植”。

`CoordinatorRoutes.ets` 对未实现路由（包括 readiness）返回 HTTP 503、`COORDINATOR_MIGRATION_IN_PROGRESS`。网络链路页面也明确标注方向探测、端点与传输回执尚未接入。因此，即使本轮完成离线启动，也不能认定它已能替代当前 Windows 协调中心运行照片工作流。

## 已发现的限制与待验

- 地址为空也允许启动，本轮只验证本地服务运行，未生成邀请或连接其他设备。源码会将空地址拼为 `https://:7443`，正式联网前应补有效地址校验。
- 源码只在首次生成时写入证书，后续修改地址不会自动重建 SAN；离线首次启动生成的证书只覆盖本地回环地址，之后用真实局域网 IP 的证书验证待修复/实测。不要直接把本轮启动通过视为局域网接入可用。
- 重开 App 且尚未启动服务时，总览显示空间数量 0；前一进程停止服务后显示 1。再次启动 epoch 递增且证书相同，因此不能据此判断数据丢失；启动前总览恢复逻辑需要后续核对。
- 未测试设备发现、配对、资源授予或图片调度，未修改协作者源码。
- DevEco 原缓存目录残留旧 PID/IPC 锁导致无法打开。已备份普通锁记录，使用 `.test/coordinator-sign-ide.properties` 指定独立 system/log 缓存恢复启动；自动审批拒绝删除旧 `.port` 文件，该文件保留，未绕过该清理限制。原账号和签名材料保留。新签名仅保存在本机忽略目录，不上传密钥。

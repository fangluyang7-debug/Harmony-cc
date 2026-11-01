# X7 跨工程引用 HAR 实验

状态：**完成-替身**。日期：2026-11-01。这里只验证 API 24 环境，不代表 API 22 构建或真机签名通过。

## 环境

- DevEco Studio `6.1.1.290`（build `243.24978.46.36.611290`）。
- 安装目录 `D:/Users/17321/AppData/DevEco Studio`；内置 Hvigor、Node、JBR。
- SDK `sdk/default`：`6.1.1(24)`，SDK `6.1.1.125`。
- 保留 v1 工程和其本地签名配置；构建在忽略目录 `.test/s2-*` 进行。

## 实际结果与退路

1. `npm run harmony:v2:har` 实际完成原生 ArkTS 编译及 HAR 打包，包括 v1 导出、v2 protocol/core、agent 持久化接口和 client 边界。
2. 独立工程 `apps/harmony-har-probe` 首先用 `file:` 指向 `apps/harmony/scheduler` 源码目录。ohpm 解析成功，但 HAP 编译失败：`00309001 Cannot import files outside of the current module using relative paths`，涉及 HAR Index 的相对导出。原始日志 `.test/s2-probe-debug.log`；没有修改 v1 导出或关闭校验来绕过。
3. 按规格退路，将依赖改为实际构建的 `scheduler.har`。独立探针和 `apps/harmony-agent` 两个工程都原生构建通过，并在模拟器调用同一 HAR 导出。
4. 探针实际执行与 TS 共用的 27 组账本 fixture；生产代理使用同一 HAR 账本、额度与微观队列，通过黑盒协议测试和裁剪链路。

```powershell
npm run conformance:build
npm run harmony:v2:har
npm run harmony:v2:probe
npm run harmony:v2:agent
```

路径覆盖变量：`DEVECO_STUDIO_HOME`、`DEVECO_SDK_HOME`。生成的包均不提交 Git；跨工程源码目录引用的失败保留记录，默认工程已使用 `.har` 退路。

| 构建 | 本地证据 | 结果 |
| --- | --- | --- |
| scheduler HAR | `.test/s2-har-build.log` | 原生 BUILD SUCCESSFUL |
| 独立探针 HAP | `.test/s2-probe-har-build.log` | 原生 BUILD SUCCESSFUL |
| 独立代理 HAP | `.test/s2-agent-hap-build.log` | 原生 BUILD SUCCESSFUL |
| 原生导出运行 | `.test/s2-probe-runtime.log`，tag `HarmonyProbe` | 27 fixtures；重启后 ledger/outbox RECOVERED |
| 依赖边界 | `.test/s2-architecture-final.log` | TS/ETS 核心纯净、client/agent 双向及桥接依赖扫描，24/24 |

本轮 HAR SHA-256：`3d9f80b34418a628a956a44487c8995cce3edc11d0291593f02cd7d01a7023f5`。重建后哈希可能变化，以实际输出为准。代理/探针没有复制另一套核心来替代引用。

API 22 兼容构建、真实手机安装、同开发者签名均未验证。client 当前只有提交端口边界，通用 SDK 在 S3/C3 实现，不能因 HAR 编译通过而宣称 SDK 已完成。

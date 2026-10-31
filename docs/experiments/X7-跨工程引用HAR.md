# X7 跨工程引用 HAR 实验

状态：部分（构建环境核对）；双工程构建未执行。日期：2026-11-01。

## 已核对环境

- DevEco Studio 安装在 `D:/Users/17321/AppData/DevEco Studio`，产品版本 6.1.1.290，build `243.24978.46.36.611290`（安装目录 product-info.json）。
- 内置 SDK：`sdk/default`，API 24 / HarmonyOS 6.1.1 / SDK 6.1.1.125（sdk-pkg.json）。这与规格 §9.3 记录的另一环境 API 22 不同，后续构建必须记录实际 target/compatible SDK，不把本次核对替代 API 22 兼容验证。
- 已找到 `tools/hvigor/bin/hvigorw.js`、`tools/node/node.exe`、`jbr/bin/java.exe`。
- 仓库 `apps/harmony/scheduler/oh-package.json5` 声明模块名 scheduler；尚无 `apps/harmony-agent`、`apps/harmony-indexer`。未创建空工程冒充跨工程引用成功。

## 最小入口与后续步骤

1. S2 中按 WP-C1 建立 HAR protocol/core 与独立 harmony-agent；另建最小引用探针工程，避免提前实现完整第二个业务 App。
2. 两个独立工程通过本地路径引用 scheduler，调用同一导出协议/核心函数。
3. 用已核对的 DevEco 内置 Node、JBR 和 SDK 执行两个工程的构建任务，记录完整命令、SDK、依赖解析与编译日志。
4. 本地路径引用失败时先记录实际错误，再按规格改用构建后的 .har 文件路径引用，重跑相同探针。

通过条件：两个独立工程均实际编译通过，并且编译期/运行探针能读取同一 HAR 导出。当前只有环境与目录证据，不记为完成-替身。

对架构的影响：S2/S3 不复制一套 ArkTS 核心或协议来绕过引用问题。采用的退路仍以实际构建结果决定，目前尚未启用退路。

| 工程 | 引用方式与 HAR 哈希 | SDK / Hvigor | 构建命令 | 日志位置 | 结果 |
| --- | --- | --- | --- | --- | --- |
| harmony-agent | 待实现 | 已核对安装，未构建 | 待执行 | 待记录 | 未执行 |
| 独立 HAR 引用探针 | 待实现 | 已核对安装，未构建 | 待执行 | 待记录 | 未执行 |

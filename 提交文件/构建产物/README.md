# HAP / HAR 构建产物

本目录最初从旧工作区当前 build 输出保留三个原件：未签名 `entry-default-unsigned.hap`、本机调试签名 `entry-default-signed.hap`、`scheduler.har`。未签名 HAP 和 HAR 纳入 Git；本机签名包仅本地保留。

2026-10-21 已在 Harmony-cc 新目录使用便携配置重新构建 HAP/HAR，并通过 scheduler 173 项、entry 27 项原生单测。重建输出仍在 `apps/harmony/entry/build/default/outputs/default/` 和 `apps/harmony/scheduler/build/default/outputs/default/`，属于可再生产的 Git 忽略文件。

原调试证书已于 2026-10-11 过期。提交安装演示前，请在 DevEco 中为目标手机重新签名，不把旧签名包视作当前可安装凭据。源码构建步骤见根 README。

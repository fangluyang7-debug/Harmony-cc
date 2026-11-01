# S2a 真机一致性验收接入点

状态：**待真机，未执行**。本轮只完成 PC 与 DevEco 模拟器验证。

## 准备

- 一台 HarmonyOS 手机和同一局域网内的协调者 PC；记录型号、系统版本、SDK、网络、签名证书主体。
- 当前本机构建采用 API 24。手机不支持时，先在匹配 SDK 上验证兼容构建，不能直接称 API 22 已通过。
- 使用 `org.harmonycc.agent` 独立工程，通过 DevEco 配置同一开发者的合法签名。不要复用模拟器未签名 HAP 作为真机安装包；不要覆盖 SoleAI 或其他应用。
- 测试使用专用的临时组、身份与数据目录，不连接 Railway 或既有运行中心。

## 执行

```powershell
npm ci
npm run conformance:build
npm run harmony:v2:har
npm run harmony:v2:agent
$env:CONFORMANCE_MANUAL = '1'
$env:CONFORMANCE_HOST = '<这台 PC 的局域网 IPv4>'
npm run conformance:test -- --agent harmony-device --include-crop
```

手机安装已签名的独立代理，保持前台。终端会输出本次私有 `invitation.json` 路径；打开该文件，将完整 JSON 粘贴到代理配对页面。默认等待配对的时间为 180 秒。该模式不会自动安装、卸载或控制手机应用，也不会启动 PC 代理代替手机；如该安装已有另一身份，应由测试者先处理这个专用测试 App 的旧配对，不得修改其他 App 数据。

预期共同 8 项检查和裁剪 1 项通过。`REAL` 域与模拟器 `SIMULATED` 域分开；记录 `.test/agent-conformance-*/report.json`、失败项、手机日志和签名后的 HAP 哈希。正常裁剪独立校验左右区域，非法参数必须失败并确认资源结算。测试最后撤销临时设备凭证，代理不能再上报或重连。

生命周期的真实手机操作另按 [B9](B9.md) 执行。后台保活、扫码及局域网证书的真实环境限制仍分别属于 X1/X2/X4，不得用模拟器结果代替。

| 记录项 | 待填写 |
| --- | --- |
| 操作者、时间、代码提交 | 未执行 |
| 手机型号、系统、SDK、签名 | 未执行 |
| PC 地址、网络与负载 | 未执行 |
| 测试报告、HAP SHA-256、日志 | 未执行 |
| 8 项协议 / 裁剪结果 | 未执行 |
| 失败项及复现步骤 | 未执行 |

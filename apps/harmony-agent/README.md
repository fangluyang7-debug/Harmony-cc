# Harmony v2 贡献设备

独立 bundle `org.harmonycc.agent`。前台运行，粘贴局域网控制台生成的完整设备邀请 JSON 配对。贡献开关和 CPU 槽位、内存上限保存在本机，调整不得超过配对时确认的上限；后台停止新的准入，已占用资源在实际执行结算后释放。CPU 槽位是配置的执行并发量，不代表测得的硬件核心数。

使用 scheduler HAR 的 v2 协议、账本、额度和微观队列；平台层提供 relationalStore、证书验证、HTTPS/WSS 和 ImageKit。文本计数、向量归一化、图像裁剪通过同一正式规划器派发。参考输入随 HAP 安装，不能从派发广告中取得期望答案或自授质量资格。业务和校准共用一个账本，校准回报使用独立持久化许可通道。

```powershell
npm run conformance:build
npm run harmony:v2:har
npm run harmony:v2:agent
```

构建结果在 `.test/s2-harmony-agent/entry/build/default/outputs/default/entry-default-unsigned.hap`。本机实际 SDK 为 API 24；脚本从安装元数据生成构建配置，不修改冻结的 v1 工程或签名配置。本地源码目录的跨工程引用在本机失败，因此工程使用实际生成的 `.har` 引用，见 [X7](../../docs/experiments/X7-跨工程引用HAR.md)。

模拟器与黑盒测试说明见 [agent-conformance](../../tests/agent-conformance/README.md)。真机应由 DevEco 给这个独立 bundle 配置同一开发者签名，不能直接把模拟器未签名包当成真机交付。真机步骤见 [B9](../../docs/experiments/real-device/B9.md)。本轮未运行手机或 GPU 验收；扫码入口仍按 X4 待后续实验。

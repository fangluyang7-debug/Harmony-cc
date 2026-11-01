# v2 代理黑盒一致性测试

本套件启动隔离的协调者和真实代理，仅通过 WSS、HTTPS、制品接口检查行为。PC/Harmony 使用同一套 8 项断言；适配器只负责启动和停止程序，不读取代理的内存、账本文件或数据库来断言通过。正向任务经过生产 `PlanningService`；重复、冲突、越权回执、篡改签名等由测试协调者注入。不会在 Harmony 选项下启动 PC 代理代替。

```powershell
npm ci
npm run conformance:test -- --agent pc
```

鸿蒙模拟器需先启动现有 DevEco phone 模拟器。默认 hdc 目标为 `127.0.0.1:5555`，可用 `HDC_TARGET` 指定另一个本机模拟器端口；`HDC_PATH`、`DEVECO_STUDIO_HOME`、`DEVECO_SDK_HOME` 可覆盖本机工具路径。

```powershell
npm run conformance:build
npm run harmony:v2:har
npm run harmony:v2:agent
npm run harmony:v2:probe
npm run conformance:test -- --agent harmony-emulator --include-crop
node tests/agent-conformance/trust.cjs
npm run ledger:v2:parity
```

`--include-crop` 额外检查经规划器派发的左右区域裁剪、独立颜色/尺寸评测、非法参数结算；模拟器还实际打开独立探针 HAP 切到后台，再返回代理，核对停止准入与恢复贡献。最终模拟器报告为 10 项，基础共同协议检查仍为 8 项。仅运行基础检查时可以去掉此选项。

测试会重新安装 **`org.harmonycc.agent` 这个测试 App**，清除其配对数据；探针为 `org.harmonycc.harprobe`。不操作 SoleAI 或其他应用。制品、私有邀请、临时证书、日志和 JSON 报告写入忽略目录 `.test/agent-conformance-*`；不要提交这些文件。参考能力包变更后须重新构建 HAP，以保持本地安装的参考输入与协调者一致。

覆盖配对/一次性邀请/撤销、画像与未知值、签名额度/续期/先缩后放、准入与拒绝、重复 attempt/冲突/外来 fence、执行/状态查询、所有者让出/结算、重连。重复投递还检查输出制品只上传一次；伪造额度签名不得得到持久化 ACK；业务追踪的快照版本必须与正式规划一致。未满足启动条件或检查失败时非零退出，不能作为通过报告。

真机入口只准备、不在本轮执行，见 [S2a.md](../../docs/experiments/real-device/S2a.md)。使用 `--agent harmony-device` 时必须显式设置 `CONFORMANCE_MANUAL=1` 与局域网地址，手工用已签名的原生代理配对。该模式不自动安装/删除手机应用，不使用 PC 替身。

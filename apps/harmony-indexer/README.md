# Harmony 图片缩略图 App

开发与构建基线：HarmonyOS 6.0.2 / API 22。独立包名 `org.harmonycc.indexer`，只通过共享 scheduler HAR 接入 v2。

```powershell
npm run harmony:v2:har
npm run harmony:v2:indexer
npm run harmony:v2:soleai
npm run s4:core-check
```

HAP 默认未签名，构建目录为 `.test/s2-harmony-indexer` 和 `.test/s2-harmony`。构建脚本将同一个 HAR 与真实参考包数据装入两个工程。设备签名时在 DevEco 打开对应构建目录，配置同一开发者的签名；重新运行脚本会重建无签名配置，应先保存签名产物及其哈希。

设备所有者通过正式注册接口为两个 App 各生成一份邀请，邀请必须分别在对应 App 内兑换。CLI 支持 `node services/pc-agent/dist/app-register-main.js owner.json policy.json invitation.json --invite-only`；省略选项会立即兑换为 PC 配置，不能再粘贴给手机。policy 的 allowedContracts 使用 `image.crop.contract`，每个 App 至少分配 1 CPU 和 64 MiB RAM，二者总额不得超过已经确认的同机物理预算。

启动后粘贴邀请并连接，等待资格准备完成，选择最多 8 张用户授权图片。App 将图片复制至自己的沙箱，使用 SDK 批量生成 128×128 缩略图，校验真实输出并显示。取消后不再开始下一张，当前任务等待执行端结算。SoleAI 对应入口为“本机偏好 → v2 裁剪验收”。完整图像检索入口仍属于 C5。

真机操作和记录见 `docs/experiments/real-device/C7a.md`。没有手机运行证据时，只能声明构建通过。

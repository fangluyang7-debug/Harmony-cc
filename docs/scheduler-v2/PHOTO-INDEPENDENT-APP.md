# 独立图片 App 与电脑评委页

2026-11-10，分支 `codex/real-device-acceptance`。实现基线为 `7a3a1fa`。后续已通过 DevEco 为新包生成独立调试签名，HDC 安装成功并启动到手机首次连接页；尚未验收新 App 的授权、选图或完整协作任务。已有 agent / SoleAI 安装包未被替换。

## 三个 App 的职责

| App | 包名 / 源码目录 | 职责 |
| --- | --- | --- |
| Harmony 协作空间 | `org.harmonycc.agent` / `apps/harmony-agent` | 发现中心、扫码/加入码、接入设备、共享额度、业务 App 授权、调度盘 |
| Harmony 图片演示 | `org.harmonycc.photo` / `apps/harmony-photo` | 从相册选图、提交照片工作流、手机本机/自动协作、进度与结果 |
| SoleAI | `org.harmonycc.soleai` / `apps/harmony` | 现有日常购物业务；本轮没有迁移或修改购物界面 |

评委页只在电脑上展示。手机图片 App 加载 `apps/team-space-web/photo-mobile.html`，仅有业务操作和结果，不显示评委图表、证据表或展示页入口。电脑仍使用原有 `photo.html?space=<空间ID>&view=judge`，保留左右照片队列、实时任务规划与设备分工、结束后的耗时；调度盘仍为 `dispatch.html`。两者读取同一份已核验任务记录。

原协作空间的 WebView 桥已移除选照片与 USB 导入照片方法。空间和调度盘的照片链接改为只读展示链接，不能经该链接提交照片计算。图片提交职责转入独立 App。

## 接入与计算链路

1. 在 Harmony 协作空间完成设备接入，再打开 Harmony 图片演示，点击“连接 Harmony 协作空间”。
2. 经现有 `EnrollmentAbility` 完成一次授权；图片 App 交换并私有保存自己的 App 身份，不共用 SoleAI 凭据，不把设备凭据传入网页。
3. 图片 App 前台运行自己的 `NativeAgent`，声明五项照片能力；模型及运行库可以预装，用户照片不打包。前台/后台额度沿用现有宿主管理。
4. 从手机相册选图，点击“开始处理”后才上传本轮输入。网页复用 `SchedulerSdk` 和既有照片 DAG，经原生 `HarmonySdkPort` 提交、传输、等待与核验结果；设备由既有 PlanningService 决定。
5. `/v2/apps/photo` 只处理 App 自己的展示记录、原图预览和已交付结果留存，**不派发计算**。结果留存从 SDK 读取已核验输出，不能提交自制成品冒充完成。
6. 电脑登录同一空间，打开照片任务展示；逐张收到真实交付结果后才显示成品。

原生入口：`apps/harmony-photo/entry/src/main/ets/pages/Index.ets`。身份与宿主：`PhotoSession.ets`；原生桥：`PhotoBridge.ets`。共享网页逻辑：`apps/team-space-web/photo.js`、`photo-app-port.mjs`、`photo-gallery.mjs`；手机样式：`photo-mobile.css`。

同时修正独立 App 的 CPU 总量上报：`/v2/apps/me` 返回设备所有者已确认的共享容量，宿主把它作为 PRIOR 总量；当前 App 的贡献额度仍分别限制，避免把较小 App 配额当作整台设备总容量后再重复扣减其他宿主额度。没有把申报额度当作实测物理核数。

## 构建与签名

协作者可从 [API 24 图片 App 分发包](https://github.com/fangluyang7-debug/Harmony-cc/releases/tag/photo-app-api24-20261110) 下载 `Harmony-Photo-API24-unsigned.hap`。源码基线 `7a3a1fa`；74,509,350 字节；SHA-256 为 `2167c2b6aa4fcef9baa44f971ef89954b443f6b07b924acbd9c5184abb16fe50`。Release 同时提供 `SHA256SUMS.txt` 和 `manifest.json`。

该附件是**未签名分发包，不能直接安装到真机**，需要接收方为 `org.harmonycc.photo` 及目标设备配置自己的调试签名。当前手机已安装的设备专用签名包不用于公开分发；私有证书、密钥、profile 不上传。模型/运行库已包含，用户任务照片不包含。HAP 放在 Release 附件，不进入 Git 历史。

默认仍为 API 22。照片模型与 ncnn 配置沿用 `PHOTO-WORKFLOW-LOCAL-20261110.md`，先构建 HAR，再构建消费它的 App：

```powershell
npm run harmony:v2:har
npm run harmony:v2:photo
npm run harmony:v2:agent
```

本机 API 24 验证使用 `HARMONY_BUILD_API=24`、`HARMONY_BUILD_PREFIX=photo-api24-` 及现有 `DEVECO_STUDIO_HOME`、`DEVECO_SDK_HOME`、`HARMONY_PHOTO_MODEL`、`HARMONY_NCNN_DIR`。API 24 成功不代表 API 22 验收。

新包的 DevEco 工程为 `.test/photo-api24-harmony-photo`；必须给 `org.harmonycc.photo` 生成独立调试签名，再用同一命令重建。不能套用 agent 或 SoleAI 的 profile。生成的证书、私有配置及大模型不提交 Git。

当前 HAR、图片 HAP（已签名并安装）、agent HAP（已签名）及 probe HAP（未签名）均构建通过。图片包位于 `.test/photo-api24-harmony-photo/entry/build/default/outputs/default/entry-default-signed.hap`，手机已显示独立首页。协调中心正在运行的旧进程和手机现有 agent 尚未更新；完整联调前需更新中心并核对授权链路。标准分发包清单尚未加入新包；当前通过上述独立构建命令生成。

## 本地验证和边界

```powershell
node node_modules/typescript/bin/tsc -p services/coordinator/tsconfig.json
node --test tests/sdk/photo-app-port.test.cjs
# 在 services/coordinator 下运行：
node --test test/photo-app.test.cjs test/photo-batch.test.cjs test/photo-storage.test.cjs
# 在仓库根目录，先按既有文档准备 CPU 模型运行环境：
node scripts/photo-local-rehearsal.cjs --check-app
```

独立 App 元数据、身份隔离、超过 1 MiB 的输入上传、未完成结果拒绝及二进制 SDK 桥测试通过。本地完整验证用浏览器替代原生桥，但 HTTP SDK、模型 CPU 推理、七个唯一节点、回执与交付均为真实执行；手机视口不显示评委组件，电脑页收到同一份结果。测试输入在空执行宿主就绪后生成，仅用于链路验证，不能充当真实照片质量或加速证据。证据与截图在 `.test/photo-tools/independent-app/`。

未验收：新包真机授权、系统相册、ArkWeb 桥、前后台切换、跨空间重新授权、手机与 Windows 协作、GPU 与同输入性能对照。当前单机选项仍需要连接协调中心，不是离线 App；原生结果保存到相册尚未提供。不要把本轮本地测试称为三设备或 GPU 提速。

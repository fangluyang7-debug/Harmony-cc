# 鸿蒙协调中心：照片演示与 Windows GPU 节点接入补齐

日期：2026-11-13

基线：`codex/main-gpu-integration-20261112`，`d9e3e504a5156dc83b04b95c5b42241ef83b2036`。本轮是在该基线及本地已有接入修复之上修改，未合并其他远端分支，尚未提交或推送。

## 1. 本轮修复与定位

### 图片展示不只是缺少按钮

此前原生协调中心只支持单节点任务、最高 30 秒任务预算，没有图片 App 使用的 `/v2/apps/photo` 和多阶段 DAG 接口。仅加入 WebView 入口无法运行现有照片任务。

本轮新增：

- 首页“图片任务演示”入口，以及调度盘与演示页之间的切换。
- 在应用内复用 `apps/team-space-web/photo-display.*`，保持左右原图/成品、真实阶段分工、逐张交付、轮次历史、完成后的耗时和清空功能。
- 原生展示服务监听 7460；页面只在协调中心本机读取，手机通过展示码发送事件。任务执行仍通过 7443 的认证 SDK 链路。
- 手机不加入空间时，“仅展示连接”只同步实际选图、进度和结果，不注册计算设备、不提交计算任务。
- 协作批次通过现有 SDK 创建多阶段图：手机分析 → 可并行增强分片 → 手机合成和交付。节点仍由 `CoordinatorJobs`、统一规划器、配额账本和实际回执控制。
- 补齐批次创建、原图接收、任务绑定、阶段状态、成品捕获、交付确认及能力数量查询接口。保留手机现有预算，原生单任务上限调整为 300 秒；正常图片批次仍使用手机传入的 180 秒预算。
- 各阶段使用原始总预算的剩余值，不在每次派发时重置预算。独立批次、同层分片独立推进；阶段重试沿用任务 ID，已成功节点不重新执行。
- 中间结果复用协调中心内不可变制品引用；汇合步骤由协调中心生成 bundle，不再要求手机逐阶段下载、上传。

### 设备 B 配对成功但看不到 / 无法使用照片 GPU

发现并修复了三个不同问题：

1. **成员显示和计算就绪混在一起。** 旧列表只显示拥有新鲜、在线、前台画像的成员。现在有效配对的设备会持续显示，尚无可用画像时标注“已接入 · 待就绪”，不会把它伪装成可调度设备。退出或撤销凭据后不再显示为有效成员。
2. **GPU 额度不一致。** 原生物理预算只提供 1 个 GPU 槽位，而现有 Windows GPU 节点申请 4 路执行生命周期额度。原生预算已对齐为 4；这表示传输、计算、发布的流水额度，不表示有四块显卡，也不绕过实际显存与设备账本。
3. **真实评测队列被空输入卡住。** B 已完成 `image.crop.v1` 的前四项，但下一项空输入用例在原生 Base64 解码时抛错，后续照片能力一直没有机会评测。空输入现在使用真正的零字节数组计算摘要。评测同时按执行器已声明的配置筛选，保留完整的对应配置正确性/边界用例；不再向仅支持 standard 的 GPU 下发 CPU parallel-2/4/8 配置。

此外，派发不再因某个 OFFERED 尚未确认而封锁整个宿主；未体现在画像中的持久化派发会扣除资源和接单额度，再决定能否继续派发。CPU、GPU、内存额度仍由真实画像决定。

## 2. 与已有优化的关系

保持以下内容：独立图片 App、SoleAI 与调度件分离；单设备单空间；原始输入从手机提交；同一模型；手机来源端负责分析/交付；已有融合 prepare+enhance、assemble+deliver 工作流；Windows 节点的常驻模型和 Vulkan 运行库；共享规划核心；结果完整性校验和逐张成品确认。

原生投影已使用共享规划器的工作量缩放成本解析，保持像素规模对计算成本的影响；空的本地等待队列不会因为另有在途任务而被误判为未知等待。没有对 Windows 协调中心的既有 R7/R9 实现做回退。

**边界必须明确：本轮不等于原生协调中心已完整复制 Windows 所有性能机制。** 原生照片链路目前使用协调中心中转；Windows 的设备间直传、执行端保留制品、完整历史成本反馈和繁忙 GPU 释放预测尚未全部移植到原生中心。因此不能把 Windows 历史批次速度直接作为本版鸿蒙协调中心的速度结论。后续要在同图、同预算下测量再优化。

## 3. 验证结果

### 本地回归

执行：

```text
node --test tests/sdk/native-coordinator-*.test.cjs tests/sdk/native-space-switch.test.cjs tests/sdk/native-photo-engine.test.cjs
npm --workspace @harmony/scheduler-core run build
```

55 项相关测试通过，覆盖：配对/重新接入、在线与待就绪区分、GPU 四槽位授予、未上报派发的资源计账、零字节边界用例、配置筛选、依赖/分支/汇合、剩余预算、重复推进不重复计算、成品确认、仅展示事件、清空与旧展示码失效。

多阶段测试使用本地 SQLite 和测试执行端，不作为实际照片性能数据。另有真实原生 Jobs 的入队、授权、输出上传和回执落库回归。

API24 HAR 和已签名协调中心 HAP 构建成功。已用本机个人签名覆盖安装到鸿蒙电脑，保留空间及设备配对记录。

### 本次现场设备观察

- 鸿蒙电脑自动获取 `172.20.10.2`，协调中心在 7443、展示服务在 7460 运行。
- 应用内“真机任务演示”实际打开，展示服务就绪。
- 用户重新连接 B 后，调度盘显示在线。实时画像为 CPU 准入 15 槽、内存约 20.21 GiB、GPU 准入 4 槽、显存约 6.48 GiB。
- B 的 `photo.analyze / prepare / assemble / deliver` 为 ACTIVE；`photo.enhance.v1` 的 `ncnn.photo.vulkan.v1`（VULKAN）为 ACTIVE。
- GPU 真实参考评测记录包含 known-image、fused-prepare、representative-pixels 以及输入边界用例，均已结算。representative-pixels 的执行上报约 355.19 ms；这是参考用例耗时，**不是用户整批照片耗时**。
- 手机图片 App 已连接鸿蒙电脑的“仅展示”服务。打开实际选图页后，服务收到手机的 `PICKING` 事件；该事件没有派发计算。未替用户选取私人照片。
- 本轮没有重新执行用户的完整六张照片，因此不报告整批提速或完全交付率。

诊断采集通过 USB 的本机只读端口转发完成；该通道不用于图片计算/业务传输。原始记录在 `.test/native-photo-parity-20261113/`，含设备运行信息，不随源码打包提交。

## 4. 用户复测方法

1. 鸿蒙电脑打开“鸿蒙协调中心”，首页点击圆形按钮；运行后点“图片任务演示”。可返回调度盘查看设备。
2. B 保持当前设备调度件运行、连接同一 Wi-Fi。**本次无需替换 B 的安装包**；现有版本已完成原生中心的 GPU 参考评测。
3. 手机单机轮：图片 App 选择本机处理，通过展示页“连接手机”的二维码设置“仅展示连接”，选图并开始。该连接本身不加入协作空间。
4. 协作轮：手机的“调度连接”加入该鸿蒙协调中心，图片 App 完成一次“连接协作空间”授权，等待照片能力就绪后，用同一组、同一顺序图片运行。大屏仍是同一个展示页，自动显示新的协作轮次。
5. 等全部成品交付后再比较完成耗时。若某张未完成，保留页面和记录，不把未完成轮次当作成功轮次比较。

手机原来的图片 App、B 的节点不要求因本次服务端修复换包。手机“仅展示连接”的旧文案仍写 Windows，但此次已验证它实际可连接鸿蒙展示服务。

## 5. 关键源码

| 作用 | 仓库内路径 |
| --- | --- |
| 原生首页、调度盘、图片入口 | `apps/harmony-coordinator/entry/src/main/ets/pages/Index.ets` |
| 原生展示 HTTP 服务 | `apps/harmony-coordinator/entry/src/main/ets/PhotoDisplayServer.ets` |
| 共用展示页面 | `apps/team-space-web/photo-display.html`、`photo-display.js`、`photo-display.css` |
| DAG 与批次、展示记录引擎 | `packages/scheduler-core/src/native-photo-engine.ts` |
| 原生数据库/任务适配 | `apps/harmony/scheduler/src/main/ets/v2/coordinator/CoordinatorPhoto.ets` |
| SDK/照片/能力接口 | 同目录 `CoordinatorRoutes.ets` |
| 派发、资源占用和结果回执 | 同目录 `CoordinatorJobs.ets`、`CoordinatorArtifacts.ets` |
| 配额与设备成员显示 | 同目录 `CoordinatorDeviceSettings.ets`、`CoordinatorDatabase.ets` |
| 评测解码与配置筛选 | 同目录 `CoordinatorQualification.ets` |
| 共享规划器的原生投影 | `packages/scheduler-core/src/native-coordinator-planning.ts` |
| 打包展示资源与保留照片参考包 | `scripts/harmony-v2-app-build.cjs` |
| 生成共享原生 JS，不要手改生成物 | `scripts/generate-native-coordinator-core.cjs` |

安装包：`dist/native-photo-parity-20261113/Harmony-Coordinator-API24-personal-signed.hap`。只含安装包、说明和校验信息，不含签名私钥、口令或调试连接码。

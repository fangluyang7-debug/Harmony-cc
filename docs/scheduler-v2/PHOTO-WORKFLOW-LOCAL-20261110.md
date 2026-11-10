# AI 照片处理、任务规划与现场展示：本地实现记录

## 基线与整合

- 工作分支：`codex/real-device-acceptance`。
- 本轮重新 fetch，协作者 `origin/codex/scheduler-v2-foundation` 合入基线：`4fe0d16`。
- 合并前真机修改完整保留在 stash `d19a338c627c2347644cc0b449a8962f5e402b7a` 对应的本地恢复点；准确 SHA 以 `git stash list` 为准。另有 `codex/backup-pre-photo-20261110` 分支。恢复点不得随意删除。
- 保留现有设备单空间约束、应用内 WebView、短码/扫码、独立 App 授权及真实购物代码。协作者的新原生接入页保存在 `apps/harmony-agent/entry/src/main/ets/pages/ConnectionLauncher.ets`，原有应用内空间页面继续作为主入口。
- 本轮整合提交位于 `codex/real-device-acceptance`；未连接或更改其他真实设备。后续评委页的新视觉方案先预览确认，本次提交保留已验证的原版展示页。

## 用户看到的效果

空间首页和已有调度盘都新增“AI 照片工作台”入口。手机应用中可以从系统相册选择照片；Windows 应用和浏览器使用文件选择器。大屏打开同一空间的评委视图：

`photo.html?space=<空间ID>&view=judge`

手机点击开始后，展示页自动跟随最新运行，展示：

1. 来源端端到端计时、已交付阶段数、实际参与设备和执行后端。
2. 从输入到成品的依赖图，节点标明等待、计算、完成或失败，连线对应实际依赖。
3. 每个节点的执行设备、规划理由、候选数量、输入/输出字节数和内容哈希、已提交回执。
4. 排队、计算、发布的实测耗时条形图。异机单调时钟不直接拼成绝对时间轴。
5. 本次实际输入与增强成品、高清文件下载、JSON 证据导出、历史运行对照。

单机模式通过 SDK 的 `executionScope: ORIGIN_DEVICE` 限制全部计算发生在发起设备。自动协作模式由现有规划器选择执行位置。单机模式仍通过局域网协调中心编排；它不是“无协调中心的离线执行”性能基线。未能识别发起设备的普通浏览器不提供该单机按钮，以免把控制电脑冒充手机。

## 工作流与架构

```text
现场选图、规范方向/RGB（来源端，计入端到端耗时）
  → SDK 注册本次输入
  → 分析与校验
  → 图块准备 × N
  → Real-ESRGAN AI 超分 × N
  → 多输入汇合、覆盖/重复/哈希校验
  → 完整 PNG + 预览
  → SDK 返回、校验、收件确认
```

- 根据照片尺寸生成至多 4 个核心图块，各带 16 像素边界上下文。最多 11 个节点，处于现有规划器 16 节点前瞻范围内。CPU 原生推理内部再按 128 像素核心、16 像素上下文处理，限制同时存在的激活张量；不是减少输出分辨率或省略区域。
- 任务图来自应用的照片处理模板；执行位置由既有 `WorkflowJobs → CpuJobs → PlanningService` 决策。没有另建派发入口，没有根据设备名称强制选 GPU，也不宣称任意自然语言目标的自动规划已经完成。
- 五个能力：`photo.analyze.v1`、`photo.prepare.v1`、`photo.enhance.v1`、`photo.assemble.v1`、`photo.deliver.v1`。
- SDK 增加 `inputFroms`，支持真实 fan-in。每一份输入都校验字节数和 SHA-256；不完整或重叠图块不能生成成功成品。
- 第一版多输入工作流通过协调中心物化中间结果。传输开销计入链路；后续可在真实测试后优化为点对点汇合。目前不把该路径描述成零中转。
- 总工作流最多 300 秒；所有节点继承同一个截止时间，不因重试获得新预算。暂态配额确认继续等待同一个任务；确定性汇合失败进入收尾。
- 展示服务只读取正式工作流、执行记录和回执。成品在 SDK 收件后另作展示留存，不作为执行缓存。

## 模型、资源与公平对照

使用预装的 **Real-ESRGAN x4plus**（4×），Windows CPU 和鸿蒙原生模块共用 ncnn 推理代码；NVIDIA 路径使用真实 ncnn Vulkan 推理，并须通过设备探测和参考输出检查后才登记为 GPU 目标。没有 NVIDIA 或探测失败会明确缺失 GPU 能力，不能把 CPU 回退记成 GPU。

- 权重 SHA-256：`713ee713b0353afaa27976f0563a64a5043bd70b9bd8936c2e26e25ebcdbcddf`
- 参数 SHA-256：`35330ececcea33b6c397a72548e788d5d53becee4734c50b7fada36e89f10a86`
- ncnn 源码基线：`7e36d25cb153092ba87a60530455c7376fedf452`。
- 参考包包含维护者固定的 8×6 合成资格样本；它不是用户任务素材，也不用于任务缓存。任务输入只在点击运行后经 SDK 传输。
- Windows CPU 初始便携构建关闭 OpenMP/AVX，优先验证正确性；性能结论必须等优化构建和真实设备复测。Vulkan 与 CPU 的内部精度可能不同，以锁定的模型、输出尺寸与资格质量阈值约束，不声称 GPU 全程 FP32。
- 输入当前限制 100 万像素、长边 1920 像素；不会静默缩小照片制造加速。单份传输/汇合/成品仍受现有 8 MiB 上限约束，超限明确失败。较大的复杂照片可能触及该上限，现场任务规模须据真机实测确定。
- 仅同来源设备、同输入哈希、同模型、同放大倍率、同预算及成功回执的 REAL 记录显示相对单机倍数。SIMULATED 本机测试不生成多设备提速结论。

## 本机运行

需要 Node/npm、CMake、Git、Python 3，以及可用的 C++ 编译器。安装脚本默认使用 `C:/msys64/mingw64/bin`，可通过 `CC`、`CXX` 指定。

```powershell
npm run conformance:build
npm run photo:prepare
npm run photo:rehearse
```

`photo:rehearse` 新建隔离的 `.test/phase-b-*` 数据目录、测试账户、空间及一个真正执行 AI 的 Windows CPU 代理，输出本地预览地址。页面有明确“本机进程验证”标记。它不会接管旧协调中心、旧空间或真实设备。选一张实际小图后点击开始即可；首次启动需等待五项能力完成资格验证。

浏览器回归脚本：

```powershell
npm install --prefix .test/photo-ui --no-audit --no-fund playwright
node scripts/photo-local-rehearsal.cjs --check-ui
```

使用本机 Chrome，预览桥只监听 `127.0.0.1`；桥到协调中心使用本次生成证书校验 TLS。浏览器没有关闭证书校验。测试期间会真实提交和执行，截图与日志位于 `.test/photo-tools/`、`.test/photo-ui.log`。

## 本地手动演练步骤

1. 按上述命令准备模型并运行 `npm run photo:rehearse`，保持终端运行；等终端显示 `PHOTO_READY`。资格验证使用通用参考样本，不加载本次任务照片。
2. 浏览器打开终端打印的地址。此地址进入隔离测试空间，不是原有真机空间。
3. 选择实际照片，选定预算，点击“开始高清增强”。本机便携 CPU 首次检查建议先用约 96×48 的小图；100 万像素／长边 1920 是接收上限，并非承诺该大小可在 180～300 秒内算完。不会在运行时暗中缩小输入。选图本身不会提交给执行设备。
4. 在另一个窗口打开“评委展示页”，点击“全屏展示”；调度盘链接可查看原有设备与任务视图。展示页先显示任务计划，再显示真实准入、处理和回执。
5. 检查完成阶段数、执行设备、阶段耗时以及原图／成品对照；下载高清成品，并导出本轮 JSON 证据。失败必须保留失败状态，不作为成功对照。
6. 本地演练只有这台 Windows 的真实 CPU 参与，标为 `SIMULATED / LOCAL_PROCESS_TEST`，没有手机、鸿蒙电脑或 NVIDIA 性能结论。普通浏览器不能识别手机身份，所以不会开放“只用发起设备计算”的手机基线按钮。

后续设备安装完毕后，手机在 Harmony 应用内选图和发起任务，大屏只打开同一空间的评委展示页。模型提前安装；每轮输入、图块及成品按本轮 SDK 任务传输。手机单机模式仍使用协调中心编排，只将执行位置限制到手机，不能称为无网络的离线单机。

## 部署到后续验收设备

Windows 代理打包可设置 `HARMONY_PHOTO_RUNTIME` 指向安装脚本生成的 `.test/photo-tools/runtime.json`，再运行现有 `scripts/build-windows-agent.cjs`。包中只放模型、运行器和必要动态库，不放用户输入、结果或身份账本。`host-main` 在加载能力注册表之前读取安装配置。GPU 首次探测可能较慢，应用启动等待已相应延长。

NVIDIA 电脑在“共享这台设备”中明确填写共享显存（例如 4096 MiB，须不超过实际可用显存）。显存填 0 时仅共享 CPU，不进行 GPU 注册。GPU 还必须通过实际推理和参考输出校验；连接失败或未通过资格验证不会伪装成 GPU 在线。

```powershell
$env:HARMONY_PHOTO_RUNTIME=(Resolve-Path .test/photo-tools/runtime.json).Path
$env:CXX='C:/msys64/mingw64/bin/g++.exe'
node scripts/build-windows-agent.cjs
```

鸿蒙构建准备：

```powershell
node scripts/prepare-photo-runtime.cjs --harmony
$env:HARMONY_PHOTO_MODEL=(Resolve-Path .test/photo-tools/realesrgan/models).Path
$env:HARMONY_NCNN_DIR=(Resolve-Path .test/photo-tools/harmony/ncnn-20261020-harmonyos).Path
# DEVECO_STUDIO_HOME / DEVECO_SDK_HOME 指向实际已安装 SDK。
# 默认保留协作者 API 22；只有既有 API 24 环境才显式设置：
$env:HARMONY_BUILD_API='24'
$env:DEVECO_STUDIO_HOME='D:/Users/17321/AppData/DevEco Studio'
$env:DEVECO_SDK_HOME="$env:DEVECO_STUDIO_HOME/sdk"
# 本轮使用独立目录，保留既有 s77 真机工程和签名。
$env:HARMONY_BUILD_PREFIX='photo-api24-'
node scripts/harmony-v2-build.cjs
node scripts/harmony-v2-app-build.cjs harmony-agent --har
```

未安装原生模型后端时不发布 AI 增强执行能力。签名和设备安装仍沿用原有流程。

## 验证与未完成验收

- 已实跑原生 ncnn CPU 推理；全图 7 节点 SDK 工作流成功，两个增强分片各执行一次，回执齐全，结果哈希一致，保持原始预算。
- 首次链路记录：72×16 合成输入 → 288×64 输出，端到端约 72.08 秒，剩余预算约 108.10 秒。这只是当前便携 CPU 与本机控制链路的正确性证据，不是手机或多机性能数字。
- SDK 单元测试 11 项通过；照片边界/引用包/合成/对照条件测试 5 项通过；fan-in、配额等待及存储超时回归 3 项通过。
- 慢通道发送请求合并测试 2 项、控制台只读身份查询测试 1 项通过。已派发节点不再被轮询反复启动；存储暂态错误保留原任务编号核对，不另起一次计算。
- 增加 SQLite 事务和独立写操作共用的写队列，读查询保持并发，保留原事务及幂等语义；真实 SQLite 32 路事务并发、独立写入与事务混合、回滚后继续提交、数组事务与嵌套拒绝回归通过。问题分析参考 [Prisma 并发 SQLite 事务报告](https://github.com/prisma/orm/issues/29870)，未将其视为本机故障原因的唯一证明。
- 修正画像 ACK 超时误触发本机 `UNKNOWN`、取消已准入推理的问题：上报失败不覆盖已经采集到的本地资源和所有者状态；暂停贡献和本地采样失败仍收回资源。两项画像/资源采样回归通过。浏览器请求增加有限超时，避免断连后按钮永久等待。
- 已准入任务在 `WAITING_WINDOW` / `WAITING_RESOURCE` 等明确的临时校准等待状态下，可提交已算完的结果；新准入、撤销的资格和过期质量证据仍被拒绝。对应完成提交回归通过。画像身份校验从逐执行目标查询改为单次批量读取。
- Windows 便携应用已完成本轮构建，输出 `.test/windows-app/Harmony/Harmony.exe`，含模型、CPU 运行器及可选 Vulkan 运行器；包内不包含安装源压缩包自带的示例照片或用户任务结果。是否能够在另一台电脑正常加载驱动与模型，仍须安装后实测。
- 完整浏览器闭环通过（`.test/photo-ui.log` 中 `PHOTO_UI_PASSED`）：正常选图 → SDK 上传 → 7 节点规划执行 → 两块真实增强 → 汇合 → 回执 → 原图与成品显示。最终本机测试为 72×16 输入、288×64 输出、180 秒预算、约 **72.88 秒**端到端，7 次唯一执行与 7 份提交回执，无重复计算。证据在 `.test/photo-tools/ui-evidence.json`，桌面与手机截图在同目录。该合成小图仅验证链路，不作为自然照片质量或性能指标。
- 修复 Windows 文件短暂占用引发的运行记录原子替换失败；保留上一完整版本并有限重试，不先删除原文件。补充回归验证重试成功、永久错误保持旧版本、清理临时文件及结果尚未就绪的明确状态。成品视图等来源端确认完整交付后再加载，避免“回执已到而展示文件尚未写入”的状态竞态。
- 页面完成刷新后才恢复“开始”按钮；并行轮询不能用较旧 revision 覆盖新的完成状态，也不能把切换前的任务显示回来。
- 自然照片检查通过：在运行端就绪后，由来源浏览器读取并生成引擎发行包海滩样图的 **96×48 缩略图**，以 180 秒预算提交；最终约 **83.20 秒**，384×192 成品正常显示，7 个阶段各执行一次、回执齐全。`.test/photo-natural-ui.log` 为 `NATURAL_PHOTO_UI_PASSED`，`.test/photo-tools/natural-ui-evidence.json` 保存证据。此处缩略图是显式的测试输入准备，不是产品运行时偷偷降采样；不是完整原照片质量验收，也不以相对上一轮 110.47 秒的差异宣称优化倍数。模型预热、系统负载等未受控，且两轮都仅本机执行。
- 启动器整合回归通过；手机窄屏的证据表使用内部横向滚动，避免把列挤成逐字换行。原调度盘补充五项照片能力中文名称，未改写其整体布局。
- 已定位 D 盘 DevEco Studio 与 API 24 SDK，独立 `photo-api24-har` 工程已完成 HAR 构建：照片推理 NAPI 的 ARM64 / x86_64 编译及 ArkTS 编译通过。修复 SDK 重试参数中的 ArkTS 不支持对象展开写法。
- 鸿蒙协作空间 HAP 构建通过，输出 `.test/photo-api24-harmony-agent/entry/build/default/outputs/default/entry-default-unsigned.hap`。含预装模型，约 73 MB；这是**未签名包**，尚未安装到设备。构建脚本同步暂存工程的 modelVersion 与所选 SDK，源工程仍保留默认 API 22 基线。
- 资格状态未变化时不再反复发布相同快照；实质状态、校准进度或质量证据变化仍更新。无效重复发布回归及设备画像原子写入回归通过。
- NVIDIA 显卡、鸿蒙电脑和手机未连接：跨设备一致性、GPU 后端成功探测、温控、内存峰值、整图边界观感及三轮速度排序均待真机验收。
- 尚未验证推理中强制终止宿主时所有原生子进程的退出时序；正常完成和唯一回执已测，不能将其扩展为已经通过所有取消／掉线故障验收。

后续按“手机计算基线 → 手机+鸿蒙电脑 → 再加入 NVIDIA 电脑”使用同一输入、同一质量和预算测量；大屏控制 Windows 不启用执行贡献。若更慢或某节点没有分配出去，展示真实决策和耗时，再优化成本估计、图块规模和传输，不能预设倍数或重复算无用任务制造分工。

## 当前交付边界

2026-11-10 后续本地演示再次完成，同一 96×48 测试输入记录约 9.39 秒，7/7 阶段交付。该值随机器负载、热状态和已有成本资料变化，不以它与先前记录的差值宣称跨设备加速。新提出的左右图片队列展示尚未替换正式页面，需在独立示例确认后接入真实结果事件。

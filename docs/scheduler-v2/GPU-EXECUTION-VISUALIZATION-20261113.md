# 跨设备照片执行可视化 · 2026-11-13

## 本轮目标与交付

评委可以看到照片由哪些设备执行、每台设备承担什么步骤、输入和输出如何衔接。保留原有照片左右画廊、实际交付后显示成品、完成后显示耗时和轮次对比。仅新增只读观察，不增加任务提交入口，不改变调度算法、CPU/GPU 配额、常驻模型或原有性能优化。

本机 Windows 协调中心已更新代码和展示资源。手机 App 本轮无需更新。设备 B 使用新完整包，文件位置：

`dist/Harmony-GPU-Execution-20261113/02-Device-Agent-Windows-x64-GPU-Execution.zip`

大小 255,823,050 字节（约 244 MiB）。SHA-256：

`1b0248aab12d8a23d91db92267b0df8862e82073f851accdae5178efcb007ceb`

完整包从 R8 设备节点包保留模型、CPU/Vulkan 引擎、Node/Electron 运行环境，并叠加当前工作树的设备执行代码。包内 BUILD-INFO.json 记录基线和叠加文件哈希。没有打入用户照片、成品、配对身份和凭证。模型允许预装，业务照片仍由用户提交后进入原 SDK 数据路径。

## 演示操作

1. 本机协调中心启动后，在“设备配对”中重新为参与设备配对。中心继续使用每次启动新会话的原规则。
2. 本机点击“打开真机任务展示（单机 / 协同）”。保留原有照片结果区，向下查看“任务规划与设备分工”。
3. B 退出旧设备调度件，将完整 ZIP 解压到新文件夹，运行 `ZhiDiaoHongShu.exe`。不要删除用户目录下 HarmonyRuntime。配对本机中心后，点击“执行现场 · GPU 分块”。
4. 手机图片 App 按原流程授权并选图，点击处理。中心页自动跟随当前照片，可点击照片标签或区块查看具体证据；B 页显示本机真正收到的任务，并可点击任一任务。
5. 答辩可先展示中心总流程，再投屏 B 的执行现场：指出接收的原图/图块、任务坐标、VULKAN 后端、输出及下游确认。最后回到中心看逐张成品和总耗时。

## 中心页面

- 每张照片的阶段由真实工作流生成。融合后的三阶段计划不会硬画成五阶段。
- 展示实际目标设备/后端、各步骤状态、已确认数量；成功回执的 actualTarget 优先于原计划目标。
- 分块地图由任务参数 x/y/width/height 绘制，标出完成、执行和等待状态。
- 显示当前步骤的数据依赖：哪个设备的哪一步输出交给哪个设备的哪一步。LOAD 成功记录支持“接收步骤已读取校验”。这不等同于已经证明某条网络链路的实时传输。
- 展示输入/输出类型、大小、哈希摘要，LOAD/EXECUTE/PUBLISH 已结束阶段耗时、完整 attemptId。
- 约每秒读取一次现有接口；短步骤可能在相邻采样之间完成，保留最终状态而不人为拉长动画。原图/成品展示仍只由真实数据触发。

## B 执行现场

来源为实际派发、CPU/GPU 执行器、阶段跟踪及直连推送确认。进程内最多 96 个业务尝试、每条 24 个事件；校准/预热排除。通过本地 IPC 向启动器发送变更，再由 localhost 页面读取，没有额外上传图片或重复推理。

区分收到任务、排队/准入、输入读取校验、EXECUTE、输出发布、本机结算和下游确认。任务可能收到源照片并在本机取块，不把逻辑图块错误描述为网络必定只传了该块。图块坐标来自本次派发参数。

引擎上报 inferenceMs、modelLoadMs、modelLoaded；显示实际推理耗时、本次加载或复用。GPU 标签依据 CUDA/VULKAN 执行后端，不依据设备名称。计数不是 GPU 利用率，不捏造实时百分比。后端未就绪时明确提示。

输出暂存本机与下游收取分开显示。直连 WRITE 成功获得接收确认后才标记“下游已确认接收”；中继上传仅表示到中继，不代表最终设备已经收取。READ 拉取没有本页端到端确认时保留未确认说明，不能伪造成已回传。应用停止/断连不再展示计算动画；进程重启清空本页观察记录，中心历史回执保留。

## 文件索引

| 内容 | 仓库相对路径 |
|---|---|
| 中心照片执行投影 | services/coordinator/src/photo-runs.ts |
| 中心流程可视化 | apps/team-space-web/photo-execution-view.mjs |
| 展示页接入、样式 | apps/team-space-web/photo-display.js、photo-display.css |
| 展示静态资源路由 | scripts/photo-display-server.cjs |
| B 页面与入口 | apps/runtime-desktop/execution.html、execution-view.mjs、execution.css、agent.html |
| B 本地观察 API/IPC 接收 | scripts/runtime-desktop.cjs |
| 有界执行观察模型 | services/pc-agent/src/execution-observer.ts |
| 真实执行事件接入 | services/pc-agent/src/agent.ts、execution-runtime.ts、execution-trace.ts、host.ts、host-main.ts、photo-accelerator.ts |

## 验证与边界

- PC agent、coordinator TypeScript 构建通过。
- 14 项 agent 测试、18 项展示/启动器/投影测试通过，共 32 项。真实 CPU 子进程执行验证输入哈希、输出回执、各阶段记录、资源结算、重复提交不重复计算；观察缓存、准入/完成/交付区分有针对性断言。
- 维护了已有 native-trace 测试夹具的 occupied 方法，生产鸿蒙代码未因本功能改动。
- Headless Chrome 验证区块图、数据路径、GPU/CPU 状态、模型复用、断连动画停止、空历史清除、无 JS 错误。页面样例为明确标注的模拟数据，不是设备 B 成绩，也未注入生产中心。
- ZIP 全量 CRC 与叠加文件哈希通过。解压后的自带 Node、桌面静态资源及子进程 IPC 验证通过；自带 CPU 推理质量检查 READY、score=1、OpenMP 实际 4 线程。CPU 检查为标准夹具，不是用户业务速度。
- 此轮没有设备 B 真机 GPU，也未进行新的多设备性能对照。安装 B 后仍需用户提交同一组照片检验真实 GPU 推理、交付状态与中心记录。
- 此次完善 Windows 协调中心。鸿蒙原生协调中心的投影接口并未同步新增字段；不能宣称所有协调中心已经同版。

本地检查原始记录和页面预览在 `.test/gpu-execution-view-20261113/`，其中 `coordinator-plan.png`、`device-execution.png` 均为 UI 模拟预览。


## 2026-11-13 展示页启动修复

用户反馈页面停在“正在连接展示服务”、二维码和连接码为空。实际安装目录的 `photo-display.js` 已是新版，但 `photo-display-compare.mjs` 仍是旧版，缺少 displayRounds/roundDevices 导出。浏览器在模块链接阶段报错，整页初始化没有执行。此前仅核对新增模块 HTTP 200 和源码页面测试不足以发现安装目录混版。

已补齐 Windows 安装目录的 `photo-display-compare.mjs`，核对该页面的全部 8 个静态资源与源码一致。静态更新生效，不重启中心、不清空轮次、不重新配对。

新增 `scripts/check-photo-display-modules.cjs`，对实际服务返回的 ES 模块图做链接检查，能发现遗漏文件、MIME 错误和缺少命名导出。执行：

`node --experimental-vm-modules scripts/check-photo-display-modules.cjs http://127.0.0.1:7460/`

新增两个回归：完整页面依赖可以链接；旧版缺少 displayRounds 导出的场景必须被检查拒绝。实际安装页面经浏览器验证：无 pageerror，二维码与连接码生成，历史 7 条可读，“连接手机”按钮可展开/收起。没有提交新的计算任务或清空数据。

同时将共享页面新增的 photo-execution-view.mjs 加入鸿蒙协调中心打包资源清单，防止今后构建 HAP 时遗漏静态依赖；本轮未更新任何 HAP。

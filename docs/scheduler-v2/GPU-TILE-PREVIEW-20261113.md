# 设备 B 的真实 GPU 图块预览

## 展示内容

设备调度件的“执行现场 · GPU 分块”新增图块墙：左侧是送入 GPU 的核心区域，右侧是本次 GPU 执行器实际产生的增强图块。图块在 GPU 计算完成、异步缩略成功后逐块出现；不是最终合成成品。每块附有任务节点、原图坐标、原图位置小地图与输出分辨率，点击后查看原有派发、推理、模型复用、发布和下游确认记录。

输入预览按执行器裁切信息去掉 halo，以便比较相同区域。输出取 `enhanceOn` 本次返回的 `photo.tile`；校验图块 image/hash、prepared/enhanced 阶段、VULKAN 后端和区域一致性。校准和预热没有业务观察记录，不会进入图块墙。输出预览出现只代表计算确实产生图块，不自动表示下游已经接收。

## 性能处理

- 不增加 GPU 推理、模型加载或调度任务，不改变原有参数与算法。
- 原执行器只将已有 Buffer 引用放入有界队列，不 await 缩略，不在计算回调中解析图片、裁切或编码。
- `setImmediate` 后交给独立 Node 子进程；该进程请求低于正常的操作系统优先级，libvips 并发 1、独立 libuv 线程池 1，禁用图片缓存。
- 仅展示页可见并持续请求观察时采集。兴趣租约 8 秒，无兴趣直接跳过；队列最多 4 个等待项，等待字节上限 32 MiB，单项上限 16 MiB。拥堵、超大图块或预览失败只影响预览，不能增加任务重试或改变结果。
- 缩略图最长边不超过 256、最高 192 像素，JPEG quality 65，每张最多 32 KiB。启动器只保留最近 32 对，最大图片负载约 2 MiB；进程重启清空。
- 图片通过独立 IPC 消息传一次；500 ms 状态轮询仅包含预览 ID 与元数据。浏览器用认证接口按需取图并缓存 Blob，后续状态更新不重复下载。记录被淘汰时释放 Blob。

这不是“绝对零开销”的承诺：缩略、IPC 和浏览器渲染仍消耗少量 CPU/内存。本设计把工作移出计算的等待链路并设置上限，优先保证任务交付。设备 B 的整批速度需要用户安装后用同输入复测。

## 验证

- PC agent TypeScript 编译、页面 JavaScript 语法检查通过。
- 12 项观察/预览/启动器测试通过：实际图片字节与哈希、输入核心区域、输出像素来源、关闭页面不采集、异步子进程、队列上限、缓存淘汰、认证及图片路由。
- 一次本地微基准 40 次入队调用合计 0.152 ms，队列满时仅跳过预览。此数字只说明入队调用开销，不代表 GPU 推理或整批端到端耗时。
- 浏览器检查 6 对图块均解码显示；首次 12 次图片读取，后续轮询和切换详情新增下载为 0；800 像素宽度无横向溢出，无脚本错误。
- 浏览器夹具明确为 SIMULATED UI，仅验证显示，不作为 B 真机 GPU 结果。此轮未连接设备 B 进行 GPU 性能对照。
- 完整 ZIP 的 CRC 与全部叠加文件哈希通过；使用包内 Node、Sharp、独立缩略子进程和认证 JPEG 接口完成验证。状态响应只有 ID/元数据，没有图片内容。

## 文件与发布

| 内容 | 相对路径 |
|---|---|
| GPU 完成后采集已有结果 | `services/pc-agent/src/photo-accelerator.ts` |
| 有界队列、兴趣租约、后台进程 | `services/pc-agent/src/execution-previews.ts` |
| 实际像素缩略与校验 | `services/pc-agent/src/execution-preview-worker.ts` |
| 宿主 IPC 与关闭清理 | `services/pc-agent/src/host-main.ts` |
| 元数据观察 | `services/pc-agent/src/execution-observer.ts` |
| 启动器图片缓存及接口 | `scripts/execution-preview-cache.cjs`、`scripts/runtime-desktop.cjs` |
| 图块墙、比较与详情 | `apps/runtime-desktop/execution.html`、`execution-view.mjs`、`execution.css` |
| 正式发行资源清单 | `scripts/prepare-harmony-distribution.cjs` |

完整 B 包：`dist/Harmony-GPU-Tile-Preview-20261113/02-Device-Agent-Windows-x64-GPU-Tile-Preview.zip`。包含已有 CPU/Vulkan 运行库、照片模型及本轮代码，不包含测试图、结果、用户配对身份。校验值见同目录 SHA256SUMS.txt。

文件大小 255829837 字节；SHA-256：`965204388a2f0ad7519eab82fb0bcec418fd39658fbe9353073a7ac19ebec810`。

安装时退出 B 的旧设备调度件，将完整包解压到新文件夹，运行 `ZhiDiaoHongShu.exe`，连接当前中心。手机点击开始前先打开 B 的“执行现场 · GPU 分块”，保持窗口可见。此轮不需要更新手机或重启本机协调中心。

合并时必须保留新 worker 编译产物和启动器 cache helper，以及正式打包清单中的执行页静态资源。不能把原始图片塞入每次执行状态快照，也不能将预览等待加入调度/执行 await 链路。预览失败应降级显示，绝不能让计算任务失败。

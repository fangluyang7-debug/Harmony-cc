# 设备 B：与本机协调中心匹配的照片 GPU 节点包

日期：2026-11-12。分支 `imageprocessing`，基线 `df79a6b` 加本机现有工作区修改；不能用该 Git 基线单独重建本次二进制，须同时保留 M25、M26 等未提交修改。

## 原包的问题

本轮检查的是用户提供的 `02-Device-Agent-Windows-x64(1).zip`，不是前一天同名无括号旧文件。

- 大小 222,846,644 字节，SHA-256 `cbc0c749fbd5a597919928d665d80e41df93e0e2dbd369a9e5cfdc7933a9a40d`，438 个 ZIP 条目。
- 缺少 `services/pc-agent/dist/photo/runtime.json`、照片模型、CPU runner、Vulkan runner 与相邻依赖。GPU 探测代码存在，但 `HARMONY_PHOTO_VULKAN` 没有安装来源，无法靠这个完整 ZIP 自行启动照片 GPU 后端。
- 原包桌面启动/配对代码与本机不同。本轮没有 B 的失败日志，**不能断言版本差异就是配对失败的唯一原因**；局域网互访、防火墙、旧绑定和一次性配对码仍需在 B 上检查。

## 交付

`dist/调度系统分发-20261112/02-Device-Agent-Windows-x64/02-Device-Agent-Windows-x64.zip`

ZIP 根目录直接包含 `ZhiDiaoHongShu.exe`，没有再套一层 ZIP。包内包含：

- 与本机安装版一致的设备协议、照片契约 v2、融合步骤适配、线程池和模型复用代码。
- Real-ESRGAN x4plus 权重、真实 OpenMP/SIMD CPU 引擎、Vulkan GPU 引擎及 OpenMP DLL；运行配置全部使用包内相对路径。
- NVIDIA/Vulkan 设备匹配、参考推理质量验证、显存上报与自动额度协商。
- `Check-Photo-GPU.cmd`：不修改配对，不运行用户照片；检查权重哈希、真实 CPU 融合步骤和 GPU 参考推理，输出 `PHOTO-DEVICE-CHECK.json`。GPU 检查包含新融合输入，不能仅检测到显卡就报告就绪。
- `BUILD-INFO.json`：记录源码基线、包含工作区改动、关键实际文件哈希。最终 ZIP 校验在外层 `SHA256SUMS.txt`。

本机协调中心、手机和鸿蒙电脑本轮均无需替换。**不要为了接入 B 而改装协作者不匹配的协调中心。** 本轮只交付 02 节点包，分发目录中其他生成的产物不是本轮应用更新指令。

## B 上的操作

1. 关闭 B 上的旧设备调度件，完整解压新 ZIP 到一个新目录。不要只复制 EXE，也不要直接在 ZIP 内运行。
2. B 与协调中心接入同一个可互访的局域网。使用协调中心窗口当前显示的 HTTPS 地址，不能沿用以前网络的地址。
3. 可先双击 `Check-Photo-GPU.cmd`，等待报告。`gpu.state=READY` 表示实际 GPU 参考推理和融合步骤校验通过；`PHOTO_GPU_DRIVER_MISSING` 表示当前进程无法使用 NVIDIA 驱动工具，`PHOTO_GPU_DEVICE_UNMATCHED` 表示 Vulkan 没有匹配到 NVIDIA 设备。失败时保留 JSON，交给实现方排查，不把 CPU 回退说成 GPU 就绪。
4. 双击 `ZhiDiaoHongShu.exe`。若已有当前中心的有效配对，直接开启设备调度件。否则在当前中心生成一个新的 **6 位设备配对码**，在 B 选择该中心；未发现时输入中心窗口地址，输入配对码、核对证书指纹并配对。每台设备单独生成码，码不能复用。
5. 保持自动贡献额度，开启设备调度件，等待能力初始化完成。照片 GPU 使用 **Vulkan**；不要选择高级图像编码配置中的 CUDA，也不需要 Python、PyTorch 或 CUDA Toolkit。需要 B 自身安装可用的 NVIDIA 驱动。
6. 系统弹出网络访问提示时，允许此新目录的程序在当前测试网络通信。中心侧也必须允许协调中心程序通信；不需要关闭防火墙。若旧绑定或配对失败，不删除账本，先提供具体提示。
7. 调度盘确认 B 在线、`photo.enhance.v1` 可用且后端 `VULKAN`。随后由用户从手机开始图片任务，检查实际执行目标和成功回执是否为 B 的 `ncnn.photo.vulkan.v1`。仅 GPU 初始化成功不等于本次业务已经分配给 GPU。

包内只预装模型、引擎和明确的引擎参考样例，没有本轮演示照片、分片或处理成品；真实任务输入仍由手机在提交后传入。诊断参考耗时不能当作协同加速成绩。

## 已验证与边界

- 打包、GPU 设备选择、照片契约和显存自动额度回归 14/14。
- 独立临时协调中心 + 新包节点：6 位码兑换、TLS 指纹一致性、配对、在线上报成功，五项照片能力均 ACTIVE/可用，自动额度上报通过。使用临时身份和空间，未修改用户现有空间。
- 最终 ZIP 解压后使用包内 Node 和运行库检查：模型哈希正确，CPU 融合参考推理质量评分 1；真实 OpenMP 线程检查通过。清除了开发机图片运行环境变量，不依赖开发目录的模型或 Node。
- 本机无 NVIDIA 独显，GPU 诊断如实返回 `PHOTO_GPU_DRIVER_MISSING`。**B 的驱动、真实 Vulkan 推理、业务调度回执及端到端加速尚待 B 安装后验证。**
- ZIP CRC、重复条目、用户身份/数据库/照片排除与现用部署文件哈希检查通过。没有运行新一轮手机照片任务，没有本轮 GitHub 推送。

## 可复用检查入口

- `scripts/check-photo-device.cjs`：独立安装包诊断；`--cpu-only` 可用于没有 NVIDIA 的构建机。
- `scripts/check-device-package-pairing.cjs <解压后的中心目录> <解压后的节点目录>`：隔离配对与能力注册集成检查。
- `scripts/prepare-harmony-distribution.cjs`：正式打包入口，携带诊断、协议 schema、版本指纹；`HARMONY_PHOTO_RUNTIME` 必须指向完整运行库。

最终 ZIP：250639546 字节，SHA-256 `8ec213f24dc02ef5d87db2074a5da286defc9e5beb1381ebd796879809fce2b9`。179 个本机现用节点部署文件全部一致，协调中心共享协议/照片契约哈希一致。

# B 节点 GPU 结果一致性故障与统一推理内核

## B 返回的事实

用户报告 `PHOTO-DEVICE-CHECK.json`（北京时间 2026-11-12 00:18:38）：

- 模型两个文件的固定 SHA-256 正确。
- CPU READY，参考评分 1，参考耗时 219 ms；OpenMP 请求/实际线程均为 4。这不是用户照片任务或协同加速成绩。
- GPU 返回 `PHOTO_GPU_QUALITY_FAILED`。按代码执行顺序，已匹配 NVIDIA/Vulkan 设备，并取得有效尺寸的推理输出，但与 CPU 参考的像素一致性评分小于 0.99。
- 此旧版诊断没有记录 B 的具体评分或像素差异，因此不能声称 B 的分数就是本机复现值，也不能把失败归因于网络或配对。

## 本地复现与原因

用同一个旧 `realesrgan-ncnn-vulkan.exe`、相同权重与 8×6 参考输入，在本机 Intel Arc 核显实际执行 Vulkan 推理，输出为 32×24。相对现有 CPU 参考评分 **0.7294236792**，平均通道绝对误差 **68.99696/255**，最大误差 168；不是简单修改一个浮点容差就能合理通过的差异。

原包把两个不同实现拼在一起：CPU/鸿蒙使用本项目 `photo-core.h` 的 RGB/float32、128 核心块/16 halo、边缘裁切；旧 GPU CLI 使用其自身预处理、边界扩展和浮点存储选项。官方实现设置 prepadding=10 并执行反射坐标变换，GPU 默认开启 fp16 storage，均与本项目原生路径不同。来源：[官方 main.cpp](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan/blob/master/src/main.cpp)、[预处理 shader](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan/blob/master/src/realesrgan_preproc.comp)、[推理实现](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan/blob/master/src/realesrgan.cpp)。这些源码差异解释了需要统一实现，未把某一个差异宣称为 B 未记录像素误差的唯一原因。

## 修改

1. 新建 `scripts/prepare-photo-vulkan.cjs`，用与现有 CPU/鸿蒙相同的固定 ncnn 修订构建原生 Vulkan 引擎，复用 `photo-core.h`；RGB、float32、分块/halo、裁切及像素取整一致。模型、参考样例和 0.99 校验标准不变。
2. 新运行库 ABI `harmony-raw-v1` 传递原始 RGB，而不是调用旧 PNG CLI 的另一套图像预处理。GPU 设备编号由经过匹配的 NVIDIA Vulkan 编号传入；不把 CPU 运算标成 GPU。
3. CPU/GPU 共用 `enhancementInput`，同时验证真实像素工作量并支持 source→prepare→enhance 融合。原 GPU 路径漏了 `pixels` 校验，会使反例能力评测失败，这一缺口一并修复。
4. GPU 质量失败报告新增具体 score、required、设备名、编号及引擎类型，避免再次只看到一个失败代码。
5. 静态链接的新 GPU 引擎不需要旧 CLI 的 vcomp140.dll；正式打包保留 ABI 字段。旧 ABI 保持可读，用于明确复现，不能继续作为当前照片 GPU 推荐包。

本轮不更换 CPU runner，不改变手机单机算法，不更换模型或参考成品，不延长任务预算；不提前装入用户照片。协调中心协议未改变，无须更新本机中心/手机来安装 B 的修正版。

## 复建与交接

已有 CPU 运行库时运行 `node scripts/prepare-photo-vulkan.cjs`；完整准备入口支持 `node scripts/prepare-photo-runtime.cjs --vulkan`。正式照片 GPU 打包使用 `.test/photo-tools/runtime-vulkan.json`。

新包中的 GPU 内核为 `services/pc-agent/dist/photo/vulkan/photo-runner-vulkan.exe`。`runtime.json` 必须同时更新 `vulkan` 和 `vulkanRuntime`，不能只替换 EXE。须一起保留 `photo-installation.ts`、`executors/photo.ts`、`photo-accelerator.ts`、打包与诊断修改。

B 关闭旧节点，将新完整包解压到新目录，再运行 `Check-Photo-GPU.cmd`。检查 READY 后启动设备调度件，沿用当前中心有效配对或生成新的设备码；随后核对调度盘的 VULKAN 能力和手机任务实际回执。B 的 NVIDIA 真机结果必须以返回报告/业务回执为准，不能用本机核显代替。


## 最终验证与交付

- 新内核编译与静态运行依赖检查通过，PE 仅导入 Windows 的 KERNEL32.dll / msvcrt.dll；Vulkan 驱动仍由目标设备提供。已修复 GPU Net 销毁与全局 Vulkan 退出顺序，成功和异常路径都在退出前释放 GPU 管线。
- 最终回归 14/14，CPU 实际运行库回归 3/3；新增打包 ABI 检查通过。
- 实际 Vulkan 推理（本机 Intel Arc）：known-image、fused-prepare、representative-pixels 均评分 1.0，标准仍为 0.99。
- 最终 ZIP 再解压后，清除开发机运行库环境变量，使用包内 Node/模型/引擎再次执行三项 GPU 参考，全部评分 1.0；CPU 检查 READY、评分 1、OpenMP 四线程正常。
- ZIP CRC/唯一条目/文件哈希通过，现用协调中心共享协议与照片参考包哈希未变。没有修改运行中的中心、手机或鸿蒙电脑，没有启动用户照片测试。
- **B 的 NVIDIA 复测仍待用户运行新版诊断**。以上本机核显测试不等于 B 真机通过，亦不等于端到端加速。

新完整包：`dist/调度系统分发-20261112-r2/02-Device-Agent-Windows-x64/02-Device-Agent-Windows-x64.zip`。

大小 255783824 字节；SHA-256 `085cb0d8fef31ff6392d54bbd2e5d287747f98e832bb4e11dcef9f6112273971`。共 511 个条目。先关闭旧节点，解压到新目录，双击 Check-Photo-GPU.cmd，再提交新 PHOTO-DEVICE-CHECK.json。此前 20261112 无 r2 包只解决缺件，B 已证明其 GPU 引擎校验不通过，应改用此 r2 包。

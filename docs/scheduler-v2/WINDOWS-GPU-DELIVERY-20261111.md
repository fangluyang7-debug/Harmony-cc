# 完整照片节点包与本机/手机更新记录

日期：2026-11-11。工作分支：`imageprocessing`。

## 本轮整合

- 已整合 `origin/imageprocessing@e842d41` 的 GPU/显存/打包修复，以及 `origin/main@fc41fe2` 的重新配对、中心断开、共享 App Session、SoleAI 编译修复和调度盘修改。解决 `host-main.ts` 的合并冲突时，同时保留 GPU 探测与 `CoordinatorGoneDetector`。
- 集成代码提交为 `5c9aba2`。随后已合并 `41d2aae`、`1ea573f`、`d3c4fa7` 的状态说明；这些后续提交只修改文档，没有改变本轮构建的程序代码。
- Windows 启动器回归改用临时身份目录、显式未配对目录及 agent 角色，避免在已安装程序的开发机上读取真实用户绑定并误启动实际执行器。功能代码没有因此改变。
- 继续保留 [MERGE-PROTECTION.md](MERGE-PROTECTION.md) 的图片独立可用、仅展示连接、统一页面、手动保存和单设备单空间等要求。

## 分发产物

仓库本地输出目录：`dist/调度系统分发-20261111/`（构建产物不直接纳入 Git）。

| 文件 | 用途 |
| --- | --- |
| `01-Coordinator-Windows-x64/01-Coordinator-Windows-x64.zip` | 新版 Windows 协调中心，包含自动显存额度处理 |
| `02-Device-Agent-Windows-x64/02-Device-Agent-Windows-x64.zip` | **给独显电脑的完整节点包**，解压后直接包含 `ZhiDiaoHongShu.exe` |
| `03-Device-Agent-HarmonyOS/Harmony-Device-Agent-API24-signed.hap` | 已连接手机的调度连接 App |
| `04-SoleAI-HarmonyOS/SoleAI-Cooperative-API24-signed.hap` | 已连接手机的 SoleAI |
| `05-Photo-HarmonyOS/Harmony-Photo-API24-signed.hap` | 已连接手机的独立图片 App |

02 ZIP 大小：**250,311,788 字节**。SHA-256：

```text
e4f1c37d483f1687ad35cef894d87f86ec505745013d57af8f147e4d954f2b7c
```

01 ZIP SHA-256：

```text
e3c8db0f38727bac7cf21cfc039318e4680dc1c942a4c4b0b95f467c0ef88cad
```

完整 HAP/ZIP 校验清单为该输出目录下的 `SHA256SUMS.txt`。手机包使用本机现有 API 24 调试签名，适用于描述文件授权设备，不是面向任意手机的发行签名；不代表 API 22 真机已验收。

## 包内真实计算能力

02 内的 `services/pc-agent/dist/photo/runtime.json` 全部使用包内相对路径，携带：

- Real-ESRGAN x4plus 模型 `.param`、`.bin` 和 manifest；权重哈希与 `prepare-photo-runtime.cjs` 的固定值相符。
- `photo-runner-simd.exe`：运行时检测的 AVX/AVX2/FMA CPU 引擎。
- `vulkan/realesrgan-ncnn-vulkan.exe`，及同目录 `vcomp140.dll` 等依赖。
- GPU 探测、NVIDIA Vulkan 设备选择、显存测量上报及明确失败日志。

GPU 驱动需要由目标电脑自身提供；照片增强无需额外配置 Python、CUDA Toolkit 或 PyTorch。节点页面的 CUDA / Python / 可信套件字段属于另一种图像编码能力，不要为照片增强去填写这些字段。

03/04/05 三个签名 HAP 均重新使用本机真实 ncnn HAR 构建，已检查模型文件、`libharmony_photo.so` 与 `libomp.so` 实际在包内。**没有使用协作者缺模型环境生成的桩实现 HAP 替换本机真实推理包。**

## 独显电脑操作

1. 关闭旧版设备节点，把完整 02 ZIP 解压到新目录；不要只拷贝 EXE，也不要在压缩包内直接运行。旧目录和 `HarmonyRuntime` 数据暂时保留。
2. 确认系统已安装适配该 NVIDIA 显卡的驱动。独显电脑、手机与协调中心电脑接到同一个可互访的局域网。
3. 本机已升级新版中心；启动中心后生成设备配对码。独显电脑双击新目录的 `ZhiDiaoHongShu.exe`，选择中心并输入配对码；如恢复已有有效配对，可直接使用。设备同时只接入一个空间。
4. 使用自动额度，点击“开启设备调度件”。首次会做真实参考推理，等待初始化完成。普通照片增强不需要选择 CUDA 图像编码套件。
5. 查看运行日志：`PHOTO_GPU_READY` 表示 GPU 参考探测通过；`PHOTO_GPU_UNAVAILABLE` 后面的具体代码说明失败原因。探测通过还需等中心同步显存额度、能力评测就绪；“在线”不等于 GPU 业务能力就绪。
6. 手机图片 App 授权当前协作空间，从手机相册选择原图后开始处理。在调度盘核对 `photo.enhance.v1` 的目标为该独显设备，后端为 `VULKAN`、执行器为 `ncnn.photo.vulkan.v1`，并核对实际完成回执。

固定配置且显存为 0 的设备不会自动扩大 GPU 贡献。若旧配对使用固定额度，应通过中心的正规配额/配对流程调整，不手工篡改本地账本或身份文件。没有成功业务回执之前，不宣称 GPU 已加速。

## 已完成验证和安装

- coordinator / pc-agent 全部构建成功；新 API 24 HAR 及三款 App 签名构建成功。
- GPU 选择、打包、Windows 启动器、中心离线检测、照片执行和原生切换回归 **19/19**；中心自动资源、设备归属和控制通道回归 **15/15**；SDK **11/11**。
- 从最终 02 ZIP 解压后，清除开发机照片路径环境变量，使用包内 Node 与包内运行库注册 `photo.enhance.v1` 并实际执行参考推理，评分 **1**。此为 CPU 引擎安装验证，不是用户照片性能对照，也不是 GPU 真机验证。
- 最终 02 ZIP 的 CRC 检查通过，模型哈希通过；未包含设备身份配置、协调中心数据库、签名私钥或用户照片。
- 本机 Windows 两份程序已备份后覆盖更新，关键运行文件哈希与本轮打包目录一致；原协调中心数据和用户身份目录保留。
- 手机调度连接、图片 App 和 SoleAI 均覆盖安装成功，并逐个启动检查；图片 App 仍可直接进入本机独立处理首页。

本轮网络检查时 Windows WLAN 为 `100.79.206.63`，手机 WLAN 为 `172.20.10.3`，不在同一网段；未进行新的双机/三机业务对照。独显电脑不在现场，GPU 驱动加载、真实 GPU 利用率、质量及端到端加速仍待其安装后验证。下一轮必须使用相同手机输入、模型和预算，不提前把用户照片或成品放到执行电脑。

本机日志和备份保存在忽略目录 `.test/gpu-update-*.log`、`.test/local-app-backup-20261111-gpu/`；不要提交其中的运行数据或调试签名材料。

## 后续：鸿蒙电脑安装与接入（同日）

- 已识别 API 24 / `2in1` 鸿蒙电脑。原调度 App 与当前签名不同，覆盖安装报 `9568332`；经用户明确授权卸载旧调度 App，再成功安装本轮 03 签名包。新安装 05 图片 App 也成功，两个 App 均能启动。旧调度 App 的本地配对已清除，协调中心历史保留。
- SoleAI 当前模块仅声明 `phone`，未强行安装到鸿蒙电脑；电脑承担调度节点/图片应用角色，不为安装而修改设备支持声明。
- 用户调整 Wi-Fi 后，鸿蒙电脑为 `172.20.10.2`、Windows 为 `172.20.10.6`。已通过中心真实邀请和 App 原有 bootstrap 配对入口加入“照片协同演示”，新 holder 为 `837c3f92-cefe-4e03-94f3-70090db5aa51`，界面显示“已连接 · 前台贡献”。USB 仅用于安装和调试。
- 中心收到实时心跳（检查时约 1 秒，TTL 15 秒），已登记五项照片阶段执行目标，包括 `photo.enhance.v1` / `harmony.cpu.v1`，真实参考质量评分为 1。此为安装、接入及能力参考验证，未执行新一轮用户照片性能对照，不代表三机加速完成。
- 安装/能力证据摘要：本机忽略目录 `.test/harmony-computer-update-20261111.json`；一次性邀请临时文件已清理。

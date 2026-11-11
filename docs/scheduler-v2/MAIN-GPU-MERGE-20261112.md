# main 合并队友 GPU、Windows 前端与照片调度链路

日期：2026-11-12。来源：`origin/codex/imageprocessing-gpu-20261112`，提交 `9f31cd6`。合并前 main：`1d61f72`。用户明确确认此来源并要求采用队友 Windows HTML、算法与图片 App 链路。

## GPU 原因核验

队友记录指出旧设备 ZIP 缺少照片运行库，无法初始化 GPU 执行器；补齐旧 Vulkan CLI 后又遇到质量校验失败。新实现采用 CPU/鸿蒙共用的 photo-core.h、原始 RGB ABI、float32 与相同分块/裁切，不降低 0.99 阈值。代码、运行库安装入口和打包 ABI 已对应核验。

GPU-BUSINESS-VERIFICATION-20261112.json 共有 36 个节点，全部 SUCCEEDED 且 committed，6 张全部交付，其中 9 个实际目标为 VULKAN。这是队友提交的历史业务证据，本轮没有重新运行用户照片。证据不包含 GPU 利用率曲线；该链路仍将可调度 GPU 资源与执行器初始化绑定，不等于已经完成通用全硬件遥测。

## 合并结果

- GPU 探测/执行、共享原生照片内核、ABI、打包诊断整体合入。
- 算法、规划、反馈、工作流推进、图片 App 输入与结果恢复采用队友版本。
- apps/runtime-desktop/agent.html 与 desktop.js 与来源分支逐文件一致。未带入先前工作区的 ArkTS 转换页面。
- runtime-desktop.cjs 冲突同时保留 main 的配对日志和队友的 coordinatorGone=false；保留 main 每次启动创建全新中心会话的行为。
- STATUS 两边历史记录均保留；同编号章节以标题区分来源。
- 调整桌面集成测试读取实际会话证书目录，增加真实节点连接、退出、重新生成短码配对与再次上线检查。

## 本轮验证

- 协调中心及其依赖构建、PC Agent TypeScript 编译通过。
- 算法核心 59/59；协议 541 + 374 项检查通过。
- 原生图片 App 适配与照片运行库打包测试 22/22。
- PC GPU/照片与桌面运行时测试 18 通过，1 项实际 Vulkan 参考推理因缺少运行库跳过。
- 协调中心定向回归 65 通过，1 项真实神经网络照片图因缺少模型/运行库跳过。
- 独立真实中心与节点集成 1/1，通过两轮退出后新六位码重配与再次上线；未触碰用户运行中的中心。
- 总计 165 项测试通过，2 项跳过；另有 915 项协议检查通过。
- 最初依赖安装尚未结束时运行原生适配测试出现 esbuild EBUSY；安装完成后重跑 22/22 通过。

## 交付范围

本轮提交源码合并，不重打 ZIP/HAP，不推送远端。照片 GPU 包必须在具备完整模型及共享内核 Vulkan 运行库的环境按 runtime-vulkan.json 重建；不能用缺件 ZIP 覆盖队友已实测的包。

main 在独立工作目录 windows-hap/main-merge 上完成。原 E 盘工作区保留其 imageprocessing 分支及原有未提交状态。

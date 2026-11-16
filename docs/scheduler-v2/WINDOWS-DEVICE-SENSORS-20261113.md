# Windows 设备电源与 GPU 温度观测补齐

日期：2026-11-13。与 GPU 真实图块预览一起交付，设备 B 只需更新一次。

## 问题与原因

PC 节点原来已经调用 `/v2/devices/me/telemetry` 上报电池、CPU、GPU 利用率和 GPU 温度，但接收接口只在鸿蒙协调中心实现。Windows 协调中心缺少路由和面向调度盘的投影；网页一直读取设备资源画像中的未知电量/温度。因此在 Windows 做中心时，B 即使能采集，界面也仍显示 UNKNOWN。

## 本次修改

- Windows 协调中心新增设备身份鉴权的遥测接收接口，并在原空间快照中附带对应在线宿主的观测。采集不写数据库、不修改准入、不触发重新规划；只通知展示刷新。
- 仅保留有界的最新观测；15 秒没有新采样则不再展示为当前数据，电源传感器单独按 60 秒判过期。空间、设备和宿主隔离，App 身份不能冒充设备上报。
- 调度盘显示电池/供电、CPU 实测负载、GPU 实测负载、GPU 温度。有电池时显示实际百分比及供电状态；无电池显示“无电池 · 不适用”。Windows 没有统一整机热等级时明确“系统未提供”，不把显卡温度转换成臆造热等级。鸿蒙原有电池和热等级显示保持。
- NVIDIA 查询增加 System32 和 NVSMI 常见路径；传感器读取不依赖照片推理执行器已经就绪。读取失败退避 30 秒。CPU/GPU 遥测约每 3 秒更新，电源采样约每 30 秒更新，均不阻塞任务执行。
- 同时包含上一版真实 GPU 图块预览：复用实际输入/输出，低优先级独立进程、有界队列、只在可见页面有兴趣租约时处理，原推理不等待预览。

## 关键源码

- `services/coordinator/src/device-telemetry.ts`：内存观测、身份与有效期。
- `services/coordinator/src/app.ts`：接收路由与仅展示刷新。
- `services/coordinator/src/telemetry-view.ts`：空间快照投影。
- `services/pc-agent/src/device-telemetry.ts`：后台采样与 NVIDIA 路径。
- `apps/team-space-web/dispatch-view.mjs`、`dispatch.js`：兼容既有静态资源白名单的传感器展示。
- GPU 图块功能与性能边界见 `GPU-TILE-PREVIEW-20261113.md`。

## 验证与限制

- TypeScript：协调中心和 PC 节点编译通过。
- 18 项相关测试通过：HTTPS 鉴权上报到成员调度盘、零值/无电池/过期/鸿蒙热等级、既有调度盘、NVIDIA 字段解析、图块缓存和独立进程、桌面接入控制。
- 采集器本机实测：电量 100%、外接电源，CPU 负载随采样变化。本机无 NVIDIA GPU，未将此结果当作设备 B 的采样。
- 整包 CRC、覆盖文件哈希、模型和 Vulkan 运行库存在性检查通过。用包内 Node/Sharp 执行真实缩略、独立子进程和鉴权 JPEG 接口检查通过。
- 已部署本机协调中心并通过原启动界面重启；就绪接口 200，新遥测接口未经授权返回 401，确认不再缺失。部署没有增加额外静态资源路由。
- B 本轮未安装此新版；未声称 B 温度或整批性能已实测。周期 GPU 利用率可能错过短 GPU 工作，执行回执/真实图块仍是 GPU 执行的直接证据。

## 统一更新包与操作

包：`dist/Harmony-GPU-Tile-Telemetry-20261113/02-Device-Agent-Windows-x64-GPU-Tile-Telemetry.zip`（约 244 MiB）。

SHA-256：`04d6108de975921c838a783e0a97cd762cfd4f4cbce6f207e92ec548f3dbc4d9`。

1. B 退出旧设备调度件，完整解压新包到新目录，运行 `ZhiDiaoHongShu.exe`；不需要先装上一版预览包。
2. 本机协调中心已经重启，按现有规则，在首页“设备配对”生成新码，让 B、手机等设备重新加入。手机 App 无需更新。
3. 打开本机调度盘“设备资源”，查看 B 的电池/供电、GPU 温度和实测负载。刚接入首次电源采样可能稍后到达，不伪造初始百分比。
4. B 打开“执行现场 · GPU 分块”并保持可见，再由手机发起照片处理，即可看到实际完成的区块输入/输出预览。

本机部署根目录：`C:/Users/17321/AppData/Local/Programs/ZhiDiao/01-Coordinator-Windows-x64`。原文件备份位于 `.test/gpu-execution-view-20261113/telemetry-center-backup`。

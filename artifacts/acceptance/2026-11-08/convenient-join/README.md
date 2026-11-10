# 便捷接入实现与验收进度（2026-11-08）

**当前状态：便捷接入实现及本轮三设备真机复验完成。手机实际摄像头扫码、两台电脑完整密钥加入、Windows 应用自动管理代理均通过；两个新空间各 24/24 项任务，共 48/48。另有 17 项两设备预检，单独记录。**

分支 `codex/real-device-acceptance`，协调中心仍运行于 Windows `https://192.168.71.37:7443`。本轮空间名称 `HarmonyQuickJoin`，创建者为鸿蒙电脑上的独立验收账号。

## 已实现

- 邀请页面显示真实二维码、完整接入密钥和复制按钮；完整密钥包含协调中心地址、成员邀请码和局域网证书指纹，有效期 24 小时。公共 HTTPS 不注入内部自签证书指纹。
- 鸿蒙应用使用 ScanKit 系统扫码页识别二维码；无已配置协调中心时，也提供扫码和完整密钥入口。二维码和键盘输入使用同一成员邀请协议。
- 创建或加入空间后，应用自动引导确认设备共享上限，再完成本机配对与代理启动；已绑定当前空间时避免重复登记。
- Windows 新增独立桌面应用，内置 CPU host 与执行器，代理启动、退出、恢复和切换由应用管理。已安装到 `%LOCALAPPDATA%/Programs/Harmony`，桌面快捷方式为 **Harmony 协作空间**。无需使用者运行命令行。
- 原生应用不再展示配对 JSON 和开发命令；网页控制端保留外部代理配置入口。
- 修复 ArkWeb 的异步桥占位返回值造成“尚未完成就显示成功”的问题：需要返回值的 Promise 方法注册于 methodList，等待真实配对响应且核对 groupId 后才显示成功。使用者将手机对准鸿蒙电脑上的二维码，实际光学识别后回到应用，本机配对成功；没有用注入文本代替扫码。参考[官方网页调用应用函数说明](https://developer.huawei.com/consumer/cn/doc/HarmonyOS-Guides/web-in-page-app-function-invoking/)。
- 预检发现同一账号跨空间首次提交会触发 RegisteredInstallation.holderInstanceId 唯一约束。新控制台安装身份改为按空间、账号、逻辑 holder 派生；旧映射继续原样读取，旧空间任务状态仍可访问。

## 已完成验证

| 项目 | 结果 |
| --- | --- |
| API 24 HAP 签名构建、双鸿蒙覆盖安装 | 通过 |
| Windows 自包含应用构建与安装 | 通过 |
| Windows 应用输入完整密钥、登录、入组、确认共享、自动启动代理 | 通过 |
| Windows 应用关闭后重开、恢复原设备身份 | 通过；无重复设备登记 |
| Windows 重复输入同组密钥 | 通过；沿用本机身份 |
| 鸿蒙电脑创建空间、自动引导本机共享 | 通过 |
| 手机系统摄像头扫码、识别回传、入组和本机共享 | 通过；使用者协助对准二维码 |
| 手机建组、鸿蒙电脑输入完整密钥并确认共享 | 通过 |
| Windows 应用输入第二个空间的密钥并切换代理 | 通过 |
| 电脑建组后的三设备任务复验 | 24/24 |
| 手机建组后的三设备任务复验 | 24/24 |
| 软件回归 | 12/12 |
| App 注册与空间集成回归 | 4/4 |
| 架构依赖检查 | 134 文件通过 |
| 修复后 Windows + 鸿蒙电脑多类型预检 | 17/17 |

预检首次为 0/17，保留在 [two-device-preflight/RESULTS.json](two-device-preflight/RESULTS.json)：10 次提交遭遇跨空间唯一约束冲突，Windows 的 7 个目标检查发生在能力尚未就绪时，没有执行。修复后等待两台能力就绪，按相同脚本及 30000 ms 预算复测，结果 [two-device-fixed/RESULTS.json](two-device-fixed/RESULTS.json) 为 17/17。包括各设备 6 项指定任务、3 项自动分配、2 项并发任务；文本、向量和图像输出全部核对。

[PREFLIGHT-AUDIT.json](PREFLIGHT-AUDIT.json) 逐项核对 17 条执行均 SUCCEEDED，每项一条 committed 回执、资源结算、结果接收确认和输出哈希匹配，并记录源码摘要。不是性能加速测试。旧空间任务状态复查返回 SUCCEEDED；先前输出已回收，没有把状态可读描述为永久保存输出。

HAP SHA-256：`0a40e1a0aedbce07809320f54621813dcb7e9b2117edaf1a0788f4a1a25726c6`。邀请、登录、设备配置及扫码屏幕含密钥，保留在忽略目录 `.test/convenient-join`，不放入公共证据。

## 两轮三设备验收

1. **鸿蒙电脑创建 HarmonyQuickJoin**（`84d15873-48a2-468a-b1e3-5c0dce7a38c6`）。Windows 应用输入完整密钥、登录并确认共享；手机从应用打开系统扫码页，使用者对准鸿蒙电脑的真实二维码后完成识别和共享。三名独立成员、一名 OWNER、两名 MEMBER，每人一台设备。第一台鸿蒙电脑名称“我的设备”来自早期桥返回值修复前的默认值，属于实际电脑，不是模拟设备。[24 项结果](pc-created/RESULTS.json)、[逐项回执审计](pc-created/AUDIT.json)。
2. **鸿蒙手机创建 HarmonyPhoneQuickJoin**（`4ffa86ed-1510-4be5-bea8-8d8afb691a24`）。另两台电脑均在应用中输入完整密钥，确认共享后自动切换本机代理。新空间仍为三成员、三设备，OWNER 改为手机账号。Windows 没有运行用户侧 CLI 接入命令。[24 项结果](phone-created/RESULTS.json)、[逐项回执审计](phone-created/AUDIT.json)。

两轮均等待全部能力可用后执行 `scripts/test-wireless-multitask.cjs`：文本统计、向量归一化、图像裁剪各两组输入，固定至三设备得到 18 项，加 3 项自动分配、3 项并发任务。每项持久化预算 30000 ms，首次输出响应即 SUCCEEDED；48 项各一条 committed 回执，结果哈希匹配、资源结算、接收确认均通过。没有以先前一轮的任务替代此次验收。完整输入和预算对照见 [FINAL-VERIFICATION.json](FINAL-VERIFICATION.json)。

本轮业务链路证据见 `network-pc-created-before/after.json` 和 `network-phone-created-before/after.json`：Windows 到两端的路由走 WLAN，双鸿蒙使用 wlan0，控制与数据连接出现对应 WLAN 地址，HDC 转发列表为空。USB 保持用于安装和调试，**未拔线复验**；部分方向允许走 Windows 局域网协调者中继，并不意味着每对设备均可直连。Windows 本机任务不计作跨 Wi-Fi 传输。

两轮并发批次分别约 10.01 秒、6.23 秒，是不同任务同时完成的批次耗时，不能当作单任务拆分或加速比。此前 NO_SPEEDUP 结论不变。协调者始终运行于 Windows，创建者变化不迁移协调进程。

收尾三端在手机创建的空间在线、三类能力可用，双鸿蒙应用内调度盘可查看该空间。Windows 桌面快捷方式 **Harmony 协作空间** 可直接启动应用及本机代理；退出应用停止本机贡献，重开恢复身份。首次接入或新空间切换需要等待能力检查完成，出现“检查中”时尚不能承担对应任务。

应用内实际页面：[Windows 调度盘](windows-app-dashboard.png)、[鸿蒙手机调度盘](phone-app-dashboard.png)。截图不含邀请码或设备凭据。

## 范围与接续

本轮覆盖现有 API 24 物理设备与 WLAN，未做清除所有应用数据后的全新鸿蒙安装验收、API 22 实机、Windows 签名安装器、后台长期运行、物理断网/拔线故障恢复或性能加速验收。冷入口扫码/密钥路径有实现和解析回归，但本次手机扫码使用已配置协调中心的应用；不要描述为全新设备开箱测试。使用者仍须完成正常账号登录、资源共享确认及系统相机交互。

扫码页面是系统单独界面，HDC 页面布局可能仍返回底层 WebView，不能仅凭布局判断扫码是否打开。私有运行状态在 `.test/convenient-join`；协调者 PID 记录在 `.test/real-device-20261107/processes.json`，Windows 代理现在由桌面应用管理，不要恢复旧的 CLI 启动脚本。正式 Windows 身份存储位于 `%APPDATA%/Harmony 协作空间`。

Windows 本地调试配置曾迁移到正式用户目录；两个临时配置副本的删除被自动审批策略阻止，已保留，不影响当前运行。不要把整个用户配置或 `.test` 目录提交。

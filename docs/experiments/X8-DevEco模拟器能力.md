# X8 DevEco 模拟器能力实验

状态：部分（工具、镜像与连接清单核对）；模拟器流程未验证。日期：2026-11-01。

## 已核对环境与日志摘要

- DevEco Studio 6.1.1.290，API 24 SDK，路径见 [X7](X7-跨工程引用HAR.md)。
- 已有镜像：`C:/Users/17321/AppData/Local/Huawei/Sdk/system-image/HarmonyOS-6.1.1/phone_all_x86`。元数据 apiVersion=24，version=6.1.0.125，guestVersion=HarmonyOS 6.1.0.125(SP9)。镜像元数据与实际启动客体版本要分别记录。
- 执行以下命令返回 `[Empty]`，当前没有 hdc 连接目标；未据此声称模拟器不可用，也没有启动或安装 HAP：

```powershell
& 'D:/Users/17321/AppData/DevEco Studio/sdk/default/openharmony/toolchains/hdc.exe' list targets
```

## 最小实验入口与步骤

1. 启动上述 DevEco phone 模拟器，重新获取 hdc 目标和实际系统版本。
2. S2 的最小代理工程连接 `npm run coordinator:lan -- <宿主可达IPv4> <端口>` 启动的协调器，使用同一配对兑换和证书指纹校验流程；模拟器内的 localhost 不能直接当作宿主地址。
3. 正确指纹可连接，错误指纹应拒绝；记录宿主访问地址、端口及是否使用受支持的端口转发。不要关闭 TLS 验证来使连接通过。
4. 用 relationalStore 持久化最小账本/计数，杀进程后重启核对；测试前台/后台变化及前台贡献退路。
5. 记录 HAP 安装、进程启动、日志获取命令和结果，为同一套 agent-conformance 用例提供实际运行入口。

通过条件：宿主网络、TLS 固定、持久化、生命周期和日志获取均有可复现结果。尚无上述结果，不能把镜像存在视为模拟器验收。

退路：先验证模拟器支持的宿主访问/转发；仍无法建立连接时，仅把网络端到端条目标为待真机，继续在模拟器验证本地账本和 fixture。手机后台能力仍须 X1 真机实验，不以模拟器结论替代。

| 客体系统 / 目标 | 宿主连接方式 | TLS 正/反例 | relationalStore 重启 | 前后台 | 安装与日志 | 结果 |
| --- | --- | --- | --- | --- | --- | --- |
| 未启动 | 未执行 | 未执行 | 未执行 | 未执行 | 仅完成连接清单读取 | 待实验 |

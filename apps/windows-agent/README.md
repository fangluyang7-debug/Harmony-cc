# Harmony Windows 应用

Windows 客户端复用团队空间和调度盘，通过受限 preload / IPC 管理已有 PC 代理，不增加任务派发入口。所有任务继续进入协调者的 SchedulerSdk 链路。

## 构建与使用

在仓库根目录安装依赖并构建现有 SDK / 引用能力后运行：

```powershell
npm ci
npm run sdk:build
npm run references:build
npm run desktop:build
```

输出 `.test/windows-app/Harmony/Harmony.exe`。整个 Harmony 文件夹一起分发；这是本地验收用便携包，尚未配置 Windows 代码签名和自动更新。包内包含 Electron、CPU 代理、子执行器及 sharp，使用者无需安装 Node.js 或手动启动命令行。

1. 双击 Harmony.exe。已连接过当前协调中心时，输入负责人提供的 **8 位数字加入码**；首次连接时粘贴**完整邀请链接**，其中包含协调中心地址和局域网证书指纹。
2. 登录 Harmony 账号，点击“加入空间”。
3. 在自动弹出的“共享这台设备”页面确认设备名称和资源上限，点击“确认共享并接入”。
4. 应用调用现有配对程序，启动 CPU host，并等待协调者的能力检查；随后在空间中查看设备、提交任务、打开调度盘。
5. 退出应用会停止本机贡献；重开恢复当前配对身份和账本。菜单提供重新连接、输入新密钥、协作空间和调度盘入口。

已连接同一协调中心时，“加入空间”和应用连接页均接受 8 位加入码，支持 `12345678`、`1234 5678` 或 `1234-5678` 格式。旧的 24 位成员邀请码和完整链接保持兼容。短码不负责自动发现陌生协调中心，首次连接请使用完整链接。普通浏览器不能启动本机代理；必须在本客户端内确认共享。

## 持久化与进程

默认配置保存在 `%APPDATA%/Harmony 协作空间`，设备身份、贡献策略、账本按 holder 分目录保存。`console.json` 只保存协调者公开地址和指纹；`devices/active.json` 指向当前身份。设备凭据不通过网页桥返回。

进程通过 Electron 自带 Node 运行现有 `host-main.js` 和 `cpu-child.js`；窗口关闭通过 IPC 请求 host 正常停止。每个安装实例同一时间只接入一个空间；账号仍可查看多个空间。切换时先检查未结算任务、停止旧 host，再配对新空间。配对失败恢复旧 host；配对成功后旧凭据已撤销，即使新 host 启动失败也只重连新空间，不恢复旧凭据。历史任务保留。

连接页提供局域网协调中心发现，发现结果只作为地址提示，首次连接仍通过完整邀请核对证书。`启动调度系统.cmd` / `npm run runtime:desktop` 打开的是协调中心管理面板，使用“打开协作空间应用”接入本机；不要另起 CLI 代理。现有协调中心正在运行时无需在面板再次启动，面板的默认数据目录也不会自动迁移已有数据。

协调中心仍单独运行；本客户端不启动或搬迁协调者。PC 数据端点沿用已有实现，缺少 OpenSSL 或入站不可达时允许通过协调中心中继，不要求用户为接入手动填写数据端口。

Electron 的主进程、preload 与子进程边界依据[进程模型](https://www.electronjs.org/docs/latest/tutorial/process-model)；证书校验使用[Session 接口](https://www.electronjs.org/docs/latest/api/session)，只信任完整邀请给定的协调中心指纹，公共 HTTPS 沿用系统校验。

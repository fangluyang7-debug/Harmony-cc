# 二维码与加入码接入机制：协作者复用说明

核对日期：2026-11-10。代码基线：`codex/real-device-acceptance` 的 `f67bb517d88fe762a49fd60dc8883fd21a93efdd`；接入机制已随此前集成提交入库，本文补充复用入口。请基于本分支合并，避免只复制页面遗漏原生桥、配对和安装身份管理。协作者分支本次 fetch 到 `7932437`，本轮未合并或覆盖该分支。

## 1. 两种输入方式，共用成员加入链路

空间所有者生成邀请时，服务端返回：

```ts
{ code, shortCode, expiresAt, fingerprint }
```

- `code`：18 个随机字节编码成的 24 字符 Base64URL 邀请码。
- `shortCode`：随机生成的 8 位数字，界面显示为 `1234 5678`；允许输入空格或连字符。
- 两者分别以 SHA-256 为键保存在 `SpaceInvite`，指向同一空间、角色和到期时间。它们是两条邀请记录，不是一个令牌的两种编码；若后续增加撤销 UI，须考虑两条记录的关联撤销，当前不能假设撤销一条自动撤销另一条。
- 成员邀请有效期 24 小时，可供多位成员加入；加入不会消费为“一次性”。只有 OWNER 能生成，角色可选 MEMBER / VIEWER。已存在成员再次加入不会改写其原角色。

普通成员二维码编码的是完整链接，**不是设备配对 JSON**：

```text
https://<协调中心地址>:<端口>/#join=<24字符邀请码>&pin=<64字符证书SHA-256指纹>
```

`pin` 为当前 pinned TLS 部署的证书指纹；公开 TLS/代理模式可以不提供该字段。二维码不包含账号密码或设备长期凭据。

手机扫码解析出中心地址、邀请码和指纹，再进入该协调中心的 Web 页面。原生 App 保存连接信息，用指纹核对中心证书。账号登录后，将邀请码提交给同一个 `/v2/spaces/join` 接口。

电脑输入 8 位码时，本机必须已经知道正确的协调中心地址。**8 位码不是全球可解析的中心地址，也不会自动跨网络发现服务器。** 首次连接应使用完整链接或先完成中心连接配置；局域网发现只提供候选中心，不替代邀请码或证书确认。旧的 24 字符裸邀请码仍兼容，但同样需要已知中心。

## 2. 加入空间不等于贡献设备

完整产品流程：

```text
电脑登录并创建空间
  → 生成成员邀请二维码 / 8 位码
  → 手机扫码，或电脑输入加入码
  → 登录并加入空间（成员资格）
  → 确认共享设备名称、CPU / 内存 / 显存上限
  → 服务端生成设备配对邀请
  → 原生桥执行本机配对、保存身份并启动代理
  → 建立连接、发布画像、完成能力验证
  → 调度盘显示设备在线及可执行能力
```

Web 的 `offerLocalDevice()` 在创建/加入空间后检查原生桥，自动引导“共享这台设备”；VIEWER 不会启动共享。已有相同设备绑定时不重复配对。当前界面确认共享参数后，还有“将本机加入当前空间”的配对按钮，不能仅以进入空间页面判断设备已在线。

设备配对邀请是另一个对象：

```ts
{ invitation, holderInstanceId, domain, contribution }
```

`invitation` 含版本、inviteId、一次性 code、中心地址/证书/指纹、groupId 与 expiresAt。由空间设备接口生成时有效期 10 分钟；交换成功后标记已使用，产生设备凭据。前端“扫描设备邀请（高级）”接受这种 JSON，与普通成员二维码入口分开。

账号可以属于多个空间；设备只能有一个活跃空间。实现依赖持久 `installationId`、当前/历史 deviceId、服务端成员激活及旧凭据退役。切换前要停止旧宿主并等待未结算任务结束，否则返回 `SPACE_SWITCH_BUSY`，历史不删除。这个约束是安装身份级别，不是靠二维码限制或不可重置的硬件身份证明；复用时不要每次启动生成新 installationId。

## 3. 可复用代码位置（仓库相对路径）

| 作用 | 文件与入口 |
|---|---|
| 正式协作空间 UI、创建、邀请 QR、短码、加入及共享设备 | `apps/team-space-web/app.js`：`createSpace`、`invite`、`joinSpace`、`offerLocalDevice`、`addDevice`；页面 `index.html`，样式 `style.css` |
| Web / Windows 加入码解析 | `apps/team-space-web/join-key.mjs`：`parseJoinKey` |
| 成员、短码、空间、设备邀请 API | `services/coordinator/src/spaces.ts`：`POST /`、`/join`、`/:spaceId/invites`、`/:spaceId/devices`（统一前缀 `/v2/spaces`） |
| 一次性设备邀请与凭据交换 | `services/coordinator/src/auth.ts`：`invite`、`exchange` |
| 单设备单空间、旧身份退役 | `services/coordinator/src/device-membership.ts`：`registerDeviceMembership`、`activateDeviceMembership` |
| 鸿蒙相机扫码及完整成员链接解析 | `apps/harmony-agent/entry/src/main/ets/JoinInvitation.ets`：`scanJoinInvitation`、`parseJoinInvitation` |
| 鸿蒙正式启动页面、首次连接、应用内 Web 控制台 | `apps/harmony-agent/entry/src/main/ets/pages/Index.ets`；当前 `EntryAbility.ets` 实际加载 `pages/Index` |
| 鸿蒙连接持久化与证书指纹校验 | `apps/harmony-agent/entry/src/main/ets/ConsoleConnection.ets` |
| 鸿蒙 Web 原生桥 | `apps/harmony-agent/entry/src/main/ets/ConsoleDeviceBridge.ets`：`info`、`scanInvite`、`joinDevice` |
| 鸿蒙代理启动与空间切换 | `apps/harmony-agent/entry/src/main/ets/AgentRuntime.ets`；底层 `apps/harmony/scheduler/src/main/ets/v2/host/NativeAgent.ets` |
| 鸿蒙高级设备 JSON 扫码 | `apps/harmony-agent/entry/src/main/ets/pages/DevicePanel.ets`；`ConnectionLauncher.ets` 是另一套设备 bootstrap 启动 UI，不要与成员链接解析混用 |
| Windows 输入加入码的启动页 | `apps/windows-agent/launcher.html`、`launcher.cjs` |
| Windows 原生桥与中心连接 | `apps/windows-agent/preload.cjs`、`main.cjs`：`harmonyDevice`、`console:connect`、`device:join` |
| Windows 自动配对/启动代理/退出旧空间 | `apps/windows-agent/host-manager.cjs`：`HostManager.join/start/stop/status` |
| Windows 打包 | `scripts/build-windows-agent.cjs`，配套说明 `apps/windows-agent/README.md` |

## 4. 接口与桥接约定

接口使用已有账号会话；不要用二维码直接伪造设备身份。

| 请求 | 作用 |
|---|---|
| `POST /v2/spaces/`，`{name}` | 创建空间，返回 `{id}`（不是完整空间对象） |
| `POST /v2/spaces/:id/invites`，`{role:'MEMBER'}` | 生成完整码、8 位码及指纹 |
| `POST /v2/spaces/join`，`{code}` | 接受完整链接中提取的 code 或短码；不是直接传 URL |
| `POST /v2/spaces/:id/devices` | 确认设备与额度；传 `installationId/previousDeviceId/knownDeviceIds` 保持单空间切换语义，返回设备 bootstrap |
| `GET /v2/spaces/:id` | 检查设备是否已登记和在线 |
| `GET /v2/spaces/:id/events` | SSE 状态刷新，前端另有轮询兜底 |

原生桥对 Web 提供 `info(): Promise<string>` 与 `joinDevice(encodedBootstrap): Promise<string>`，返回 JSON 字符串，沿用现有序列化约定。手机额外提供 `scanInvite()`，只读扫码结果；真正加入仍经过服务端接口。Windows 提供 `connectInvite()` 处理中心连接及页面导航。

当前鸿蒙 WebView 代理方法列表没有导出 Windows 的 `connectInvite`。鸿蒙首次连接用原生 `Index.joinInvitation`；不要误以为已连接后的 Web 加入对话框能像 Windows 一样自动切换到另一个中心。跨中心产品入口若要统一，需显式补齐该桥接并测试。

普通浏览器没有 `harmonyDevice` 原生桥，可以创建空间/邀请和查看调度盘，但不能直接启动本机资源代理。电脑“一键接入”的复用对象是 Windows Electron 应用及 HostManager，不能只复用 HTML。

## 5. 已验证与复用边界

本次用户已确认手机扫描二维码、进入新空间成功。但服务端在后续核对时该空间 `devices` 仍为空，因此本次扫码操作不能当作“设备在线/已贡献算力”通过记录。联调须继续确认共享参数、配对、在线状态和执行能力。

刚才电脑展示二维码的 `http://127.0.0.1:54119/` 是忽略目录 `.test/qr-join-20261110/` 中的临时展示工具：调用正式 API 创建空间、生成邀请并展示二维码，不是正式产品入口。它含本机邀请与会话依赖，未推送；协作者应复用上述正式 `app.js` 和原生桥，不依赖该临时页面或复制旧邀请。此次只新增说明，不更改协议或运行机制。

复用检查：同一可互访局域网 → 中心地址正确 → 完整邀请保留指纹 → 登录加入 → 确认设备配额 → 原生配对启动 → 在线与能力验证。二维码不负责提供网络连通性，不能解决不同 Wi-Fi、访客网络隔离或中心地址变化。

回归入口：

```powershell
node --test tests/sdk/join-key.test.cjs tests/sdk/native-join-key.test.cjs
cd services/coordinator
node --test test/space-short-code.test.cjs test/device-membership.test.cjs
```

2026-11-10 本轮复跑以上两组测试，合计 4 项通过。原生解析一致性测试不替代 ArkTS 编译或真机相机测试。完整构建、API 24 真机与交接基线见 [照片联调交接](HANDOFF-PHOTO-DEMO-20261110.md)。

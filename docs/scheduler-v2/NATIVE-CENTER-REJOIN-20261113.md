# 鸿蒙协调中心首页与设备重入修复

## 基线与交付状态

**安装状态更新（2026-11-13）：用户随后明确允许使用本机个人签名，并授权卸载鸿蒙电脑旧协调中心后安装新版。已完成卸载、安装和启动，旧版协调中心本地空间/配对/历史数据随卸载清除，其他 App 未卸载。下文“保留旧版、等待原签名”是此前排查过程，已被本次授权和安装结果替代。**

- 最新协调中心 signed HAP 已安装到鸿蒙电脑 `5XQ0226206001861`，包含前台亮屏改动。
- 实机首页圆形按钮启动成功，自动识别 `https://172.20.10.2:7443`，无需填写 IP；进入原调度盘成功。
- Windows 连续三轮 LAN UDP 探测均收到鸿蒙电脑中心的正确响应（3/3）。中心目前保持运行，设备需使用新邀请重新配对。
- 证据位于 `.test/native-join-20261113/laptop-new-home.json`、`laptop-new-running.json`、`laptop-new-dashboard.json`、`laptop-discovery-responses.json`。

- 基于 `origin/main` 的 `d9e3e50`，工作分支 `codex/main-gpu-integration-20261112`。
- 本轮源码尚未提交或推送。现有图片处理、GPU 调度和照片展示逻辑未改动。
- 用户要求最终 HAP 沿用协作者原签名，不卸载旧协调中心以绕过签名校验。

## 修复内容

1. **协调中心首页**：新增圆形启动/停止按钮；启动时自动枚举 Wi-Fi、以太网 IPv4，不再手填 IP；点击“进入调度盘”进入原有页面，可返回首页。中心设置只显示状态、地址与指纹。前台保持亮屏，降低自动锁屏打断演示的概率。
2. **设备发现**：鸿蒙节点每轮向全局及实际网段广播地址探测三次；鸿蒙与 Windows 中心发现 socket 出错后自动重建。响应限流区分 IP 和源端口，不再让同一设备不同扫描会话互相抑制。Windows 节点同样补充三轮探测。
3. **有效邀请重入**：六位码读取不再立即消耗；设备第一次兑换后将邀请绑定到安装身份和 holder。原设备明确退出后，可在原有效期内使用同一二维码或配对码重新加入。其他安装身份不能复用，旧式不带安装身份的兑换仍保持一次性。不会延长原有效期。
4. **退出闭环**：补齐鸿蒙中心 `/v2/devices/leave`；检查未结算工作，撤销设备及应用凭据、释放活动空间绑定。客户端标记已退出身份，再次加入时重新兑换，不恢复已撤销凭据。历史账本保留，单设备单空间约束不变。
5. **停止闭环**：停止中心同时停止任务推进、发现服务、控制连接和 TLS 服务。

## 关键文件

| 职责 | 仓库相对路径 |
|---|---|
| 协调中心首页、调度盘入口 | `apps/harmony-coordinator/entry/src/main/ets/pages/Index.ets` |
| 前台亮屏 | `apps/harmony-coordinator/entry/src/main/ets/entryability/EntryAbility.ets` |
| LAN 地址识别 | `apps/harmony/scheduler/src/main/ets/v2/coordinator/CoordinatorNetwork.ets` |
| 鸿蒙发现服务 | `apps/harmony/scheduler/src/main/ets/v2/coordinator/CoordinatorDiscovery.ets` |
| 鸿蒙邀请、退出接口 | `apps/harmony/scheduler/src/main/ets/v2/coordinator/CoordinatorPairing.ets`、`CoordinatorRoutes.ets` |
| 客户端退出后重新配对 | `apps/harmony/scheduler/src/main/ets/v2/host/NativeAgent.ets` |
| 鸿蒙设备搜索和页面 | `apps/harmony-agent/entry/src/main/ets/Discovery.ets`、`pages/ConnectionLauncher.ets` |
| Windows 协议对齐 | `services/coordinator/src/auth.ts`、`discovery.ts`、`apps/windows-agent/discovery.cjs` |

## 已验证

- `npm run conformance:build` 通过；API 24 HAR、协调中心 HAP、设备节点 HAP 构建通过。
- 28 项不同的定向回归通过：鸿蒙网络选择、发现恢复、配对、退出路由、重入、单设备单空间、Windows 配对与发现。
- 手机实机验证：打开即为首页，没有 IP 输入框；点击圆形按钮自动识别 `172.20.10.3` 并启动；点击进入调度盘，返回首页；停止按钮可停止服务。
- Windows 向手机中心发送三次 UDP 发现探测，三次均收到正确地址响应。
- 鸿蒙电脑新版节点界面实际搜索到手机协调中心 `https://172.20.10.3:7443`。业务探测走局域网；USB 用于安装和 UI 检查，无端口转发。
- 同码退出/重入、过期拒绝及不同安装身份拒绝由自动化协议回归验证；尚未完成两台实机扫码退出再扫码的整轮验收。未进行照片性能复测。

## 签名与安装边界（务必保留）

- 手机协调中心已使用此前本机调试签名覆盖安装，并完成上述界面与自动地址实测。设备节点已成功覆盖安装到手机、鸿蒙电脑。之后补充的协调中心前台亮屏改动已构建，按用户原签名要求没有再次部署。
- 鸿蒙电脑协调中心覆盖失败：`9568332 install sign info inconsistent`。没有卸载，没有清除旧空间、配对和任务数据。
- 鸿蒙电脑旧协调中心证书指纹：`4E006A6D5A977DD6EFEFBE2A9A883137FCFCF81B05C8EE9EA6F86250484EFCC4`；App identifier：`6918747458711229470`。
- 本机 `.ohos/config` 未发现匹配该指纹的证书。main 的已跟踪文件没有协调中心签名材料，GitHub Release 也没有协调中心签名 HAP。main 唯一入库的 `提交文件/构建产物/entry-default-unsigned.hap` 是 `Micro.12.myapplication`，不能当作协调中心签名来源。
- **请协作者使用原协调中心工程对应的证书、私钥、profile 对新版 unsigned HAP 签名，再覆盖安装鸿蒙电脑。不要将私钥或签名密码提交到 GitHub。** 复制旧包的签名数据无法对修改后的 HAP 形成有效签名。
- 本轮 Windows 服务端修改尚未部署到正在运行的 Windows 协调中心，因此该中心仍是上一轮运行版本。若以 Windows 为中心验收“同码退出重入”，需一起更新该服务端。

## 验收顺序

1. 原签名覆盖安装协调中心，确认保留旧数据；首页点击圆形按钮，确认自动显示本机 LAN 地址。
2. 进入调度盘 → 设备接入 → 生成二维码/六位码；节点搜索并配对。
3. 无任务时从节点退出空间，在邀请剩余有效期内使用同一邀请重新加入，检查只有一个活动设备身份。
4. 再次搜索、暂时断网恢复后搜索，确认中心持续运行时能重新发现；停止中心后不得继续显示为可连接。
5. 邀请过期后应明确拒绝；在中心生成新邀请即可接入。

设备必须能在局域网相互访问。AP 隔离、防火墙阻断或系统暂停后台应用不能靠重复广播绕过；此时应检查网络和应用运行状态，不能承诺任何环境下都必然发现。建议演示时协调中心保持前台。

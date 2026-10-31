> 当前主部署：局域网 PC 协调者，按 [局域网指南](../../docs/scheduler-v2/LOCAL-COORDINATOR-20261031.md) 启动。开发顺序和进度以 [v2 文档入口](../../docs/scheduler-v2/README.md) 与 [STATUS](../../docs/scheduler-v2/STATUS.md) 为准。下方旧组件接续记录保留历史说明。

# PC agent v2：执行整合、账本与恢复通信

2026-11-01，S1：常驻 `host-main`、配对和任务 CLI 已可运行。正式网页/CLI 任务统一经过协调者 PlanningService；代理从认证的派发授权响应取得真实快照版本，产生 QUEUE/ADMIT/LOAD/EXECUTE/PUBLISH 追踪，并上报已有 B5 模块拟合的中继链路观测。无观测时 links 为空且状态 UNKNOWN，不能补造带宽。接口与范围见 [CPU Host API](../../contracts/scheduling/v2/CPU-HOST-API.md)。更早的“尚无 CLI / 未装配采样”等描述不代表当前状态。

`src/agent.ts` 将认证连接、恢复屏障、设备内队列、能力准入检查、真实 CPU 执行、持久化回执与追踪组装为 `PcAgent`。`src/artifact-client.ts` 将受信路由服务提供的短期票据接到执行输入/输出，`artifact-endpoint.ts` 提供 PC HTTPS 制品端点。CPU 支持裁剪和向量归一化；没有 GPU 执行器。

目前 `PcAgent` 是可嵌入的宿主类，尚无完整业务 agent 安装/启动 CLI。受信配对、物理预算确认、额度续期、OS 画像采集、路由/权限服务及校准证据获取仍由宿主装配。现有独立命令包括配对初始化和恢复客户端；恢复客户端默认不执行业务。最新交接见 `docs/scheduler-v2/HANDOFF-B-INTEGRATION-20261030.md`；早期 B3/B4 文档是历史记录。

`src/profile-publisher.ts` 接受宿主注入的画像采集源、持久化序号和认证发送通道：启动上报、变化事件立即上报、心跳兜底；同时只允许一次发送，等待 ACK 时合并变化。发送前等待序号持久化，失败不发出；心跳不修改采样时间或伪造新测量。`start/changed/stop` 均应等待完成，停止会取消订阅和定时器。当前用模拟源以及真实 TLS/WS 集成测试验证，尚未装配 OS 采集器、持久化通道 outbox、独立 agent 进程。生产宿主须保证 `publish` 有界失败/超时，否则停止会等待未结束的发送。

在仓库根目录执行 `npm run pc-agent:test`。测试包含真实 CPU 子进程裁剪/归一化、取消、队列与账本恢复。资源额度及设备画像使用测试输入，不代表已测物理设备贡献能力。`npm run coordinator:test` 包含完整整合用例 `test/agent-integration.test.cjs`：真实 TLS/WS + 真实 CPU + 模拟资源域，先校准再派发、制品读写、回执 ACK 丢失、重连及重启不重复执行。

使用顺序：

1. `DurableLedger.open(directory, identity, trustedCertificate)`：取得目录单写者锁并恢复。不要复用不同持有者的数据目录。
2. `requestGrant(requestId)`：在本地单调时钟上记录请求起点；通过认证通道申请额度。
3. `installGrant(grant)`：使用受信协调者证书验签，并校验持有者、安装实例、ledgerEpoch、版本、nonce、租期。网络等待计入租期。
4. `admit(offer, context)`：在一个持久化快照中写 ACCEPTED、额度、lease、fence 和资源预留。context 必须来自本地策略与认证连接，不可直接照抄远端请求。
5. `begin(attemptId)` 成功后才能调用引擎。即使在 begin 后、引擎调用前崩溃，也不自动重放旧 attempt。
6. `cancel/expire` 只发起停止意图。只有本地适配器确认引擎实际结束，才能调用 `settle`。网络断开、请求超时不构成停止证明。
7. `status/receipts/acknowledgement` 导出持久化记录、待重传回执和带 HMAC 的额度确认。`PcAgent` 的新任务执行循环与恢复 transport 已装配；额度自动续期/签名 ACK 尚需宿主接入。

额度、attempt、资源、fence、恢复通道序号、去重记录与 outbox 同存 `ledger.json`，以校验和检测损坏，通过 write + fsync + rename 提交。封装 format 2 自动校验并升级旧账本文件。`ledger.initialized` 只标记目录曾初始化：快照遗失时拒绝创建空账本。任何写失败都会使实例停止服务。重启时 ACCEPTED 根据“先持久化 RUNNING 再调用引擎”的不变量结算取消；其他未结算记录保留资源，标记 SIDE_EFFECT_UNKNOWN，在线租期归零。基础额度仍绑定原安装，原占用仍计入新准入。

Windows 当前只验证本地文件系统及进程崩溃恢复，没有验证断电持久性或网络文件系统。Windows 锁使用规范目录散列对应的命名管道，避免临时 TCP 端口冲突；其他平台保留 loopback 端口锁。真实 CPU 子进程退出可确认结算，崩溃后的未知引擎仍需对账。禁止靠清空目录恢复“空闲容量”。

## 装配业务宿主

完整可运行调用示例见 `services/coordinator/test/agent-integration.test.cjs`，不要把其中的 SIMULATED 画像、虚拟时钟或测试用户授权当作生产实现。

1. 通过受信管理流配对并确认整机预算。打开账本，申请并安装签名额度。
2. 构造 `PcAgent(ledger, options)`。`qualification` 必须从受认证协调者读取当前执行器及准入证据；agent 自行验证身份、域、TTL、CANARY/ACTIVE 和完整配置。`ports.authorize` 另执行当前任务/App/数据权限和贡献策略检查，不能直接照抄 offer。
3. `ports.read/publish` 可使用 `artifactPorts`。其路由提供方检查任务及数据所有者权限后签发短期票据；不要直接使用任务里的任意 URL。
4. 通过 `updateResources(limits, owner)` 注入新鲜的贡献上限和所有者状态，再 `start()`；连接恢复 ACK 前不接受新业务。资源或所有者状态改变后继续调用 `updateResources`，UNKNOWN 停止新准入。
5. `snapshotVersion` 无法确认时返回 null，省略执行 trace，不能用计划版本冒充快照版本。已产生的执行 span 只有本地 LOAD/EXECUTE/PUBLISH；缺少 SDK 根 span 时查询明确返回计量不完整。
6. `close()` 关闭连接、取消可取消工作并等待实际结算。之后再关闭账本。尚未确认的回执留在 outbox。

`onYield` 目前交给宿主转发；画像采集与 `ProfilePublisher` 仍需宿主装配。没有可用 CUDA/已加载模型时不能注册 GPU。当前业务 agent 仅接受 CPU、PURE、CANCEL_RESTART 路径。

## 运行恢复客户端

先 `npm --workspace @harmony/pc-agent run build`，再运行：

```powershell
npm --workspace @harmony/pc-agent run recovery -- C:/path/to/recovery-config.json
```

配置文件为以下结构，使用已有配对结果和已有账本目录；示例值不能直接使用：

```json
{
  "directory": "C:/path/to/existing-ledger",
  "identity": { "groupId": "group-id", "deviceId": "device-id", "holderInstanceId": "holder-id", "appInstanceId": null },
  "connection": {
    "address": "https://coordinator-host:port/",
    "certificate": "<配对时固定的 PEM 证书>",
    "fingerprint": "<证书 SHA-256，小写、无冒号>",
    "credential": "<该持有者当前有效的 bearer token>",
    "domain": "REAL"
  }
}
```

配置包含凭证，仅本机保存，不纳入版本库。命令不会创建新的空账本。TLS 校验覆盖 CA、主机名、证书固定值；握手后的消息另校验组、协调者身份/代次及运行域。断线后按 250ms 至 10s 上限退避重连；这是连接恢复，不是任务领取轮询。Ctrl+C 关闭通道并释放单写者锁。

`RecoveryClient.connect()` 用于一次连接；`start()/close()` 管理重连生命周期。查询回复与去重、outbox 同快照持久化，回复须 ACK 才移出；Hello 不推进业务序号游标，以便先重连再发送旧 outbox。重启/换协调者代次后重新查询状态，旧结果仅对账、不自动提交当前计划。

`reconcileEngine(ledger, attemptId, localProbe)` 是本地受信引擎适配入口，不含启动或重试方法。UNKNOWN、仍运行和探测失败保留占用；只有匹配 fence/目标/配置且明确结算的回执能调用 settle。结算与新的恢复通知在同一快照写入；在线宿主随后调用 `client.flush()` 触发发送。CLI 未配置任何真实引擎 probe，故不能自行释放未知引擎资源。恢复回报不会代替签名额度 ACK，协调者预留继续保守保留。

outbox 上限 64 条/1 MiB，inbox 上限 4096 条。超限停止新写入，不丢消息或清空账本；历史压缩/长期运行维护尚未实现。本阶段适用于接续集成与受控验收，不能标为完整设备代理已交付。

## 可运行 CPU 宿主与提交命令（2026-10-31）

已新增 `host-main.ts` 和 `submit-main.ts`，可从配对配置启动真实 PC CPU 宿主、自动采集/校准并执行文本或向量任务。构建后从仓库根目录运行 `node services/pc-agent/dist/host-main.js <agent.json> <contribution.json>`；提交命令为 `node services/pc-agent/dist/submit-main.js <agent.json> <capability> <input.json> <new-output.json> [targetId]`。完整例子见 [设计差距与运行说明](../../docs/scheduler-v2/DESIGN-GAP-AND-CPU-HOST-20261031.md)。

校准 worker 已改为 WS `EvaluationChanged` 事件唤醒和重连对账，空闲时不定时领取；失败的投递仍可定时重试。下面保留上一轮组件描述，关于“周期领取”和“无业务 CLI”的状态以本节为准。

## P0 接续：远程校准（2026-10-31）

`PcAgent` 可配置 `calibration: { executor, intervalMs }`；executor 是使用同一 DurableLedger 的 `CalibrationExecutor`。恢复完成且所有者空闲后，worker 通过配对固定证书 HTTPS 领取评测，使用本地已安装的输入和参数执行，并提交真实结算后的输出。协调者负责参考判定和能力状态更新。结果丢失可从持久化记录补报；不重跑未知状态的 attempt。关闭时先取消并等待评测结束。

网络参考输出上限 64 KiB，worker 默认每 500 ms 查询一次；没有改变普通业务 WS 派发。`remote-evaluation.test.cjs` 覆盖独立 PC 进程、自动校准循环与结果丢失重试。完整装配与剩余工作见 `docs/scheduler-v2/HANDOFF-REMOTE-CALIBRATION-20261031.md`；完整业务安装/启动 CLI 仍待接续。

## P0 接续：自动额度维护

`PcAgent` 现在可配置 `allotments: { policy, renewEveryMs }`。宿主提供经过所有者授权的资源策略；协调者仍须预先确认整机预算与持有者绑定。续期周期必须小于租期，建议预留网络延迟余量。

`AllotmentClient` 使用配对固定证书的 HTTPS 调用额度申请与 ACK 接口，同一实例最多一个续期请求。先持久化单调时钟请求起点，再发请求；收到签名额度后通过 DurableLedger 校验并落盘，随后发送带当前占用与结算序号的签名 ACK。网络失败不延长本地租约，不释放未知占用；下次周期重新申请，协调者继续保留未结算资源。缩额策略在下次续期读取，资源实际停止与结算仍由执行器负责。

`close()` 停止自动续期并等待有界请求结束，再关闭 agent。该接口补齐 P0 的额度维护环节；配对管理、系统画像采集、可信校准证据服务与完整业务 CLI 仍需接续装配，不能标记 P0 全部完成。

## P0 接续：配对、画像与系统资源

构建后运行 `npm --workspace @harmony/pc-agent run pair -- <invitation.json> <absolute-new-installation-directory>`。邀请文件由协调者 provision 命令生成，须通过用户信任的方式传入。命令校验证书固定值、主机名、域和邀请有效期，兑换凭证并初始化账本，写入私有 `agent.json`；已有安装目录拒绝覆盖。若留下 `pairing.pending`，先对账注册状态，不删除目录后盲目重试。Windows 文件访问仍受当前目录 ACL 控制，应使用当前用户的受保护目录。

`PcAgent` 未注入 `qualification` 时默认通过认证 HTTPS 获取当前目标证据。`publishProfile(profileWithoutSequence)` 在同一账本快照内分配单调消息/画像序号并写入 outbox，等待实际 ACK 后完成；断线或超时保留待发记录，同一时间仅允许一份未确认画像。重连恢复期间不能发布新画像。

可选 `resources: { policy, owner }` 启用真实 Node OS CPU/内存采样和周期性本地准入更新。policy 定义 CPU/RAM 池、贡献上限与保留内存；可用 RAM 按“自己的已占用 + 系统空闲 - 保留量”计算并受贡献上限约束，不能把剩余空闲误作包含在途任务的总上限。采集异常、过期或超时按 UNKNOWN 停止新准入。

提供 `windowsOwnerActivity(idleThresholdMs)`，只观测当前 Windows 会话的键盘/鼠标空闲时间；不读取应用名称。服务会话、多用户机器及其他平台需提供适用的活动源，不能把此信号推广为全机无人使用。电池、温度与 GPU 状态仍需平台适配，未用虚构值补齐。资源采样和画像提交接口已可用，完整画像构造与定期上报装配仍待接续。

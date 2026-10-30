# PC agent v2：执行整合、账本与恢复通信

`src/agent.ts` 将认证连接、恢复屏障、设备内队列、能力准入检查、真实 CPU 执行、持久化回执与追踪组装为 `PcAgent`。`src/artifact-client.ts` 将受信路由服务提供的短期票据接到执行输入/输出，`artifact-endpoint.ts` 提供 PC HTTPS 制品端点。CPU 支持裁剪和向量归一化；没有 GPU 执行器。

目前 `PcAgent` 是可嵌入的宿主类，尚无完整业务 agent 安装/启动 CLI。受信配对、物理预算确认、额度续期、OS 画像采集、路由/权限服务及校准证据获取仍由宿主装配。唯一现成独立命令是下文的恢复客户端，默认不执行业务。最新交接见 `docs/scheduler-v2/HANDOFF-B-INTEGRATION-20261030.md`；早期 B3/B4 文档是历史记录。

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

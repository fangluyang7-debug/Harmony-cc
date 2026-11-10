# 局域网协调者运行与验收

> **现行文档**：局域网 PC 协调者是本项目的主部署方式（规格修订 6 §00.2）。总体方向与进度见 [specification-r6.md](specification-r6.md) 和 [STATUS.md](STATUS.md)。

演示采用一台稳定接电的 PC 作为空间的唯一协调者，其他设备与它连接同一局域网。云端保留用于异地协作。每个实例使用自己的数据库、邀请与设备凭据；当前没有云端与本地状态同步或自动接管。

## 启动

2026-11-08 合并接入封装：根目录 `启动调度系统.cmd` 或 `npm run runtime:desktop` 可打开本机协调中心管理面板，负责启动、停止服务及查看日志。设备接入使用面板中的“打开协作空间应用”，沿用 Windows 应用的短码、共享确认与单空间代理管理；面板不再提供另一套手动配对/启动代理入口。鸿蒙应用保留空间页面、调度盘和扫码，同时提供高级设备邀请扫描与独立的跨 App 授权页。

管理面板默认使用 `services/coordinator/data/desktop-<IP>`，不会自动接管命令行启动的中心，也不会迁移已有数据库、身份和证书。本轮真机中心继续使用 `.test/real-device-20261107/coordinator`，地址与证书保持原值；已经运行时不要再占用同一端口启动第二个中心。发现协议使用 UDP 7444，只提供地址提示；完整邀请仍用于建立证书信任。

S1 已将现有控制台/CLI 的文本与向量入口接入正式规划器。示例地址（含 `examples/cpu-host/device.json`）必须替换为实际本机 IPv4；启动脚本会校验该地址属于本机网卡。新控制库自动迁移 ConsoleApp 表，不要用不同设备或实例的账本目录互换配置。

在仓库根目录使用 Node.js 22、npm 和 OpenSSL。先安装并构建：

```powershell
npm ci
npm --workspace @harmony/coordinator run build
npm --workspace @harmony/pc-agent run build
```

运行 `ipconfig`，确认电脑连接演示网络的 IPv4 地址。以下示例地址应替换为实际地址：

```powershell
npm run coordinator:lan -- 192.168.1.20 7443
```

启动器验证地址属于本机网卡，监听 `0.0.0.0`，以该 IPv4 作为证书 SAN 和邀请地址，装配 CPU 宿主支持与协作空间网页，并执行数据库迁移。默认持久目录为 `services/coordinator/data/lan`。第三个参数可指定独立的绝对数据目录。

需要显式指定 OpenSSL 时，在启动窗口设置 `COORDINATOR_OPENSSL` 为其可执行文件路径。启动器不会修改系统 PATH、防火墙、证书信任库或现有云服务。

首次启动生成的公开证书位于持久目录下的 `coordinator-public.crt`，控制台显示 SHA-256 指纹。通过可信渠道核对指纹后，在访问网页的设备上信任该证书。仅分发这个公开证书，不分发 `identity.json`、数据库或代理安装目录。代理通过邀请固定证书，并继续检查主机名。

浏览器访问 `https://192.168.1.20:7443`，注册本地账号、创建空间，在目标设备所有者的账号下生成设备邀请与贡献设置。按页面命令配对并启动代理。网页显示当前协调中心地址；页面关闭不会停止协调者或代理。协调者进程须持续运行。

建议为演示网络保留固定 DHCP 地址。已有身份绑定证书主机地址；地址变动时启动会拒绝复用不匹配身份，不会自动重签或清空数据库。重新建独立目录会建立新空间体系，原设备需重新配对。

## 页面状态与诊断

### 三设备网络配置（2026-11-07）

本轮拓扑为 Windows 协调中心及 PC 代理、鸿蒙电脑代理、鸿蒙手机代理。三台设备使用同一可互通的局域网。USB 用于安装及调试，业务地址填写 Windows 的局域网 IPv4。网卡选择应对应实际 Wi-Fi/以太网，不选 VMware、WSL 或 169.254 开头的地址。运行下列命令列出候选网卡；多网卡时按实际连接选择。

```powershell
node scripts/check-lan-connection.cjs
npm run coordinator:lan -- <Windows局域网IPv4> 7443
```

Windows 开放协调中心入站 TCP 7443。若启用 Windows 代理的数据直连，另为它设置固定端口 7444；两者都限制在现场可信网络与本地子网。Windows 防火墙规则可在管理员 PowerShell 中配置，使用前核对当前网络确实是受信任的 Private 网络。

```powershell
New-NetFirewallRule -DisplayName 'Harmony LAN coordinator' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 7443 -Profile Private -RemoteAddress LocalSubnet
New-NetFirewallRule -DisplayName 'Harmony LAN agent data' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 7444 -Profile Private -RemoteAddress LocalSubnet
```

创建 network.json，两个地址均替换为 Windows 实际局域网地址。文件包含网络设置，可与私有 agent.json 分开管理。固定端口只供一个代理进程使用；同机多个安装需分别指定不同端口。省略第三个参数时沿用现有配置，自动选取到协调中心的路由接口与动态数据端口。

```json
{"listenHost":"192.168.1.20","advertisedHost":"192.168.1.20","port":7444}
```

```powershell
node services/pc-agent/dist/host-main.js <agent.json> <contribution.json> network.json
```

控制台为三台设备分别生成邀请，Windows 按配对命令生成 agent.json；两台鸿蒙设备将包含 contribution 的完整邀请 JSON 粘贴到代理。保持鸿蒙代理前台。协调中心地址、证书和域来自邀请，两台鸿蒙设备无需手填本机 IP，也无需开放一个入站数据服务端口。

当前鸿蒙数据实现主动请求可用端点。Windows 数据端点可达时可提供直连读写；没有入站端点的鸿蒙目标或不可达的设备方向，使用协调中心中继。数据和控制流量仍在现场局域网内。调度盘上的 L0–L3、每方向探测结果和实际传输回执用于核对路径，禁止将在线状态当作设备间直连证据。

连接检查可以先使用邀请，配对后使用 agent.json。检查只读取健康状态、身份和端点目录，并探测公开的有限大小数据端点；不会消费邀请或创建任务。

```powershell
node scripts/check-lan-connection.cjs <invitation.json>
node scripts/check-lan-connection.cjs <agent.json>
```

输出 ready 表示协调中心 TLS、健康和域核对成功；使用已配对配置时还要求凭据可以读取端点目录。NOT_PAIRED 表示尚未检查设备凭据。READ_PROBE_PASS 仅证明运行诊断的这台电脑到该数据端点的 1 KiB 读取成功，双向写入、其他物理设备的网络和 WSS 控制恢复须由实际代理及任务继续确认。证书或主机名错误时检查邀请地址、证书及当前 DHCP 地址；HTTP_401 表示检查凭据与配对；超时/拒绝连接时依次检查进程、绑定地址、入站端口和 AP 客户端隔离。诊断结果不包含邀请码、认证令牌或证书私钥。

本机完整网络回归从 services/coordinator 目录运行，明确选定本机网卡。它创建独立临时 SIMULATED 空间与三个代理进程，使用真实局域网地址、TLS、公开配对入口和 SDK；其中两个关闭入站数据端点以复现鸿蒙当前拓扑。每个目标执行实际 CPU 任务、检查输出和提交回执，再验证数据端点读取及错误指纹拒绝。本机运行不能替代跨物理设备 Wi-Fi 验收。

```powershell
$env:HARMONY_TEST_LAN_ADDRESS = '<本机实际局域网IPv4>'
node --test --test-concurrency=1 test/lan-config.test.cjs test/lan-three-hosts.test.cjs
Remove-Item Env:HARMONY_TEST_LAN_ADDRESS
```

页面通过同源 HTTPS SSE 接收空间变化提示，再读取带权限检查的快照。任务派发与设备回执仍使用 WSS。断线后浏览器自动重连并重新获取快照；30 秒低频校对用于过期状态和通知遗漏，不作为任务派发机制。

事件订阅校验登录和空间成员身份，每次通知及心跳重新检查权限；慢客户端被断开后重连。事件只传变化提示，不传任务输入或结果。

设备拒绝任务时，协调者保存原始 AdmissionReply、收到时间、消息 ID 和 traceId。任务详情返回 attemptId、目标、协调者代次、计划版本与额度版本；任务页显示拒绝码。原有未记录详情的失败不能补推根因。没有可用目标时接口返回 409 / NO_AVAILABLE_TARGET。网页与 CLI 显示“任务尚未提交”，使用同一个 requestId 最多等待资源 15 秒；网页关闭提交窗口可停止后续等待。只对这个明确未创建任务的错误重试；超时、未知交付和已拒绝任务均不自动重投。这是客户端有界等待，不是协调者的持久任务队列。

代理执行结束后主动发布资源画像，仍以本地账本和有效画像为准，不因为收到结果而推测设备已经释放全部资源。

### 业务服务宿主：把服务自己的能力登记为普通执行目标（2026-11-09）

业务服务（例如 SoleAI 的商品向量检索）不再是"固定节点"。它通过一个独立宿主进程以普通目标身份登记能力，规划器在所有登记了该能力的目标里按成本选择（STATUS §87）。

1. 准备共享声明文件：复制 `examples/service-host/service-packs.json`，把 `indexSpaceId`、`indexVersion`、`model` 改成业务服务当前激活索引的元数据（`GET /api/v2/image-search/spaces/<space>` 的返回）。协调者与宿主必须使用**同一份文件**，否则评测套件摘要不一致。
2. 协调者启动时设置 `COORDINATOR_SERVICE_PACKS=<该文件绝对路径>`（与 `COORDINATOR_CPU_HOST=1` 同用）。
3. 像 PC 执行设备一样为服务宿主生成设备邀请并配对（`npm --workspace @harmony/pc-agent run pair -- <invitation.json> <目录>`），准备 `contribution.json`。
4. 复制 `examples/service-host/service.json`，填入 `packs`（同一声明文件）、`baseUrl`（业务服务地址）、`tokenEnv`（存放业务服务访问令牌的环境变量名）。令牌只从环境变量读取，不写入账本、追踪或任务元数据。
5. 启动：`npm --workspace @harmony/pc-agent run service-host -- <目录>/agent.json <contribution.json> <service.json>`。宿主先核对线上索引与声明一致（不一致报 `SERVICE_INDEX_MISMATCH`），再登记声明文件中的能力（向量检索 `vector.search.v1`，以及 `stages` 段里的 `catalog.price-stock.v1`、`rank.v1`），协调者自动用参考用例评测，通过后进入候选集。
6. 在调度盘查看任务详情的"候选目标数（资格过滤后）"与"数据范围"（`LOCAL_ONLY / OWNER_SERVICE / SHARED`，由 App 声明决定该节点的数据能去哪，被排除的目标以 `DATA_SCOPE_FORBIDDEN` 出现在拒绝列表）：只有服务宿主登记该能力时为 1，这是登记事实而非固定；再有一台设备登记同一 `serviceId` 的能力后会变为 2 并按成本比较。

调度盘资源视图的"能力缺口与补齐提示"会列出所有应用声明过、但当前没有合格目标的能力，以及缺少它的设备和补齐方式（见 `capabilities/capability-hints.json`）；调度器不会替设备安装任何东西。

当前提供三项只读能力：`vector.search.v1`、`catalog.price-stock.v1`（对应业务服务 `POST /api/v2/stages/price-stock`）、`rank.v1`（`POST /api/v2/stages/rank`），以及唯一的写能力 `shopping.commit.v1`（`POST /api/v2/stages/commit`，幂等键必填，评测走 `X-Dry-Run`，用户授权由 `POST /api/v2/tickets` 签发的任务票据随任务携带）。视觉分类与文字理解能力的服务登记尚未实现，见 STATUS §87 §16–§17。

## 双设备验收步骤

1. A 运行协调者，B 运行代理。B 用 HTTPS 访问 A 的就绪接口与网页；若无法连接，检查地址、Windows 入站端口规则和 AP 客户端隔离。不要用关闭 TLS 验证代替证书配置。
2. 在 B 完成配对、校准，执行文本和向量任务，核对完整结果；记录任务 ID 和失败详情。
3. 连续提交任务，分别记录提交至完整结果、等待可用资源和失败。不要剔除拒绝样本。
4. 中断 B 网络后恢复，确认原安装与账本重连；已有 attempt 不因重连重新执行。
5. A 停止后界面应显示连接异常，重启同一持久目录后恢复；这不是自动主节点切换。
6. 相同 A/B 设备连接云端独立空间，保持资源上限、工作负载、预热、观测方式一致，比较完整结果延迟及失败。

本机软件测试与双设备无线网络验收分别记录。现有时延实验仍是同一 PC 的回环对照，不能据此填写本验收的结果。

## 协作者的可选 App 接入

协作者的购物示例通过独立 EnrollmentAbility 请求设备所有者授权，再登记工作流声明并由 SDK 提交任务，仍经规划器选择执行目标。该示例不替代团队协作主入口；涉及图像编码时另需匹配的评测套件、模型及执行环境。

协作者原始 API 22 未签名构建记录见 COLLABORATOR-ENROLLMENT-20261108.md。本轮 API 24 调度件签名构建与空间切换真机记录见 STATUS 最新节。跨 App 真机授权尚未验收；切到其他 App 后也不能据此前台代理实现承诺手机持续后台贡献。

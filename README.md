> 2026-10-31：协作空间首页、成员/设备管理与 Railway 云端协调已落地。访问 https://harmony-space-production.up.railway.app ，接入和验证记录见 [协作空间云端交接说明](docs/scheduler-v2/TEAM-SPACE-CLOUD-20261031.md).

# Harmony-cc · 智调鸿枢鸿蒙调度项目

最新接手入口：[协作空间、云端部署与时延实验综合交接（2026-10-31）](docs/scheduler-v2/HANDOFF-TEAM-SPACE-AND-LATENCY-20261031.md)，包含开发/实验分支基线、已完成能力、实测结果和后续优先级。

当前 v2 开发面向团队共享资源空间及跨设备协同。2026-10-31 已接通独立 CPU 代理、自动校准、任务提交与结果读取，见 [设计差距核对与运行说明](docs/scheduler-v2/DESIGN-GAP-AND-CPU-HOST-20261031.md)。下方购物链路是既有 v1 实现，不是 v2 新功能的限定场景。

Harmony-cc 是独立的鸿蒙参赛项目仓库，包含手机购物应用、调度 HAR、云端 Runtime、可信 CPU Worker、双手机派发、PC 监控、模型与商品样本、测试及参赛材料。

该仓库于 2026-10-21 从原工作区 `harmony-agent` 的当前文件迁出，包含当时尚未提交的鸿蒙修改。历史提交出处保存在迁移清单中。应用包名、业务接口和运行中的云服务地址沿用原配置，以保持当前链路；源码和构建不依赖相邻 Cixin 工程。

## 完整链路

```text
鸿蒙 entry → SchedulerClient / SchedulerService HAR
          → CloudShoppingExecutor → 云端购物 API
          → Runtime 12 阶段 → 云裁剪 / 可信 Worker / 配对手机裁剪
          → 模型与检索 → 会话、候选与 ShoppingResult → 手机

本机诊断 → HAR → MindSpore Lite CPU / TaskPool → 执行遥测
手机调度日志 → PC monitor
```

正式购物使用云执行器；端侧模型和向量样本用于本地诊断。配对手机裁剪与可信 Worker 的成本派发是不同路径，启用条件见各模块说明。[系统审查与算法详解](docs/24-复赛项目系统审查与调度架构详解-20261020.md)记录实现边界。

## 目录

| 位置 | 内容 |
|---|---|
| `apps/harmony/entry` | 鸿蒙 ArkUI 应用、购物客户端、手机派发页面、本地模型与样本 |
| `apps/harmony/scheduler` | 可复用调度 HAR：状态、策略、队列、执行器、反馈、协议 |
| `apps/harmony/monitor` | PC 遥测监控及独立双机实验服务 |
| `apps/test-entry-web` | Web 业务联调、商品池管理、Runtime 监控 |
| `services/api-server` | NestJS API、购物业务、宏观调度、Prisma 迁移 |
| `services/device-worker` | 独立可信 CPU Worker，裁剪与向量计算 |
| `services/image-worker` | 可选 Python 图像服务 |
| `contracts` | 调度与购物契约和样例 |
| `docs` | 架构、算法、运行、实验、验收与迁移说明 |
| `提交文件/复赛` | 复赛说明、测试报告、模板版本、演示视频 |
| `提交文件/构建产物` | 迁移时保留的 HAP/HAR；与当前源码重新构建的结果区别对待 |
| `archive/legacy-submission-packages` | 本机完整保留的旧提交快照；重复源码和压缩包不进入主线 Git |

## Node 服务与 Web

要求 Node.js 22+。进入本仓库根目录执行：

```powershell
npm ci --include=dev
```

首次克隆时从 `.env.example` 建立 `.env` 并填写配置；迁移后的本机副本已保留原 `.env`，请勿覆盖。数据库初始化和启动：

```powershell
npm --workspace services/api-server run prisma:generate
npm --workspace services/api-server run db:init
npm run api:dev
```

另开终端运行 `npm run web:dev`。默认 API 为 `http://localhost:3100`，Web 为 `http://localhost:5180`。真实图片购物依赖已配置的数据库、COS、模型与联网服务，健康入口为 `/api/v1/health/readiness`。

Zeabur 使用根目录 `zbpack.json`，环境项见 `.env.zeabur.example`。现有线上服务和商品数据仍通过原环境配置访问；迁移文件夹不会自动重新部署云端。

## 鸿蒙 App

```powershell
npm run native:prepare
```

然后用 DevEco Studio 打开 `apps/harmony`，安装 ohpm 依赖并为自己的手机配置签名。工程目标为 HarmonyOS 6.0.2(22)。当前使用无私钥的便携配置；迁入的原签名备份位于本机 `.migration-local`，原调试证书已于 2026-10-11 过期，安装手机前需重新签名。详细运行步骤见 [原生运行指南](apps/harmony/DEV_RUN_GUIDE.md)。

使用已安装的 DevEco 工具链构建与运行原生单测：

```powershell
.\scripts\native-check.ps1 -StudioHome '你的 DevEco Studio 安装目录' -Task all
```

## PC、Worker 与双手机

```powershell
npm run monitor:dev
```

监控服务默认端口 8765，按配对码接收手机遥测，见 [手机连接电脑指南](docs/手机连接电脑调度件演示指南.md)。

独立 Worker 的凭据、端口和跨机入口配置见 [Worker 说明](services/device-worker/README.md)。云配对手机需两个 `PHONE_DISPATCH_*` 演示开关；具体流程见 [多设备演示脚本](docs/23-多设备协同调度演示流程与录制脚本.md)。本地 USB 合成任务实验入口为 `apps/harmony/monitor/dual-phone-lab.mjs`，与正式购物演示分别使用。

## 完整性和回归

```powershell
npm run standalone:verify
npm run migration:verify
npm run api:build
npm run web:build
npm run architecture:test
npm run algorithm:test
npm run concurrency:test
npm run scheduler:typecheck
npm run cloud-shopping:typecheck
```

`standalone:verify` 检查独立 Git 根目录、工作区、关键链路文件及迁移清单。`migration:verify` 保留早期迁入记录的核验，不要求历史来源目录存在。主机回归通过不代表已重新进行真机或线上验收。

## 提交资料与迁移记录

- [提交材料索引](提交文件/README.md)
- [独立仓库迁移说明与验收](docs/25-Harmony-cc独立仓库迁移与完整链路验收-20261021.md)
- [原始复制哈希清单](docs/migration/Harmony-cc-copy-manifest.json)
- [仓库文件基线清单](docs/migration/Harmony-cc-repository-manifest.json)

环境凭据、本机签名、数据库、运行日志和缓存仅在本机保留。模型 `.ms`、模型描述、商品样本、原生工程、服务端迁移、契约与参赛文档纳入 Git。旧目录与原 Cixin 仓库保留原状，迁移后请以此目录作为新的鸿蒙开发入口。

## 跨设备资源协同：调度 v2

架构以跨设备资源协同运行时为主线，协作空间作为应用入口。局域网运行见 [本地协调者指南](docs/scheduler-v2/LOCAL-COORDINATOR-20261031.md)。最新进展见 [B 阶段软件整合交接](docs/scheduler-v2/HANDOFF-B-INTEGRATION-20261030.md)，历史基础见 [阶段 A 交接](docs/scheduler-v2/HANDOFF-20261030.md)，运行方式见 [协调者说明](services/coordinator/README.md) 与 [PC agent 说明](services/pc-agent/README.md)。已整合可信校准、真实 CPU、HTTPS 制品、WS 派发与持久化回执；业务宿主产品化和完整场景验收仍待接续，真机验收按用户要求暂缓。

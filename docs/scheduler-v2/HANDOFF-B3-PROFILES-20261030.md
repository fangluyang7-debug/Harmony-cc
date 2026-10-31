# B3 接续：画像事件、能力证据和快照发布

> **历史记录（2026-10-31 标注）**：本文是当时的实现过程记录。现行方向、规则与执行顺序以 [规格修订 6](specification-r6.md) 和 [STATUS.md](STATUS.md) 为准；本文中的“下一步”、优先级以及云端相关建议已不再适用。

日期：2026-10-30。接续 [阶段 B 交接](HANDOFF-STAGE-B-20261030.md)，实施依据为 [specification-r5.md](specification-r5.md)。用户附带的微信目录文档与该规格 SHA-256 一致，不存在两份不同修订。本记录不覆盖历史交接，也不修改原有两份团队功能设计文档。

## 本轮交付范围

WP：B3。

完成级别：**本轮画像发布增量通过替身验收；B3 整包仍为部分完成，T2 未冻结。** B4/B6 的恢复网络闭环没有在本轮实现。累计完整工作包完成数仍按上轮 A1–A6、B1/B2 统计，不因新增协议或测试增加完成数量。

分支仍为 `codex/scheduler-v2-foundation`，HEAD 为 `5c63ee3a713f50076d6029059476c15e69afb333`。本轮直接接续工作区中的协作者修改，没有重复应用补丁、重置目录、提交或推送。

### 已实现

1. **画像事件与快照同事务发布。** `ProfileProjection` 将已认证的画像写入与快照更新放在一个事务中，提交成功后 WS 才 ACK。发布失败时画像与快照同时回滚。内容完全相同的画像重传不会抬高快照版本。
2. **贡献策略显式配置。** `runtime.profiles.configure(groupId, planningPolicy, contributionPolicy)` 为受信本地调用入口，持久化目标允许集合及电量、温度、前台、计费网络、优先级策略。没有策略时仅收录画像，不推断用户授权；A 阶段手工快照不自动切换为画像驱动。
3. **修正多持有者快照。** 快照设备键包含物理设备和持有者，避免同机 SDK 与 agent 相互覆盖；读取快照时排除原始画像行。共享 RAM 等物理池汇总所有持有者占用；非零/未知占用的池不能从画像中直接消失。
4. **结构化能力证据。** 新增 T2 `CapabilityAdmission` 的 JSON Schema、TS/ETS 类型和校验、合法/非法 fixture。候选要求证据匹配组、持有者、目标、执行身份、运行域、修订号，且处于 CANARY/ACTIVE、质量证据未过期。旧 `{state, identity, domain, quality:number}` 数据不再视为有效审批，不自动升级。
5. **失效与过期边界。** 执行器版本/模型/配置变化只使对应目标资格失效；账本升代要求重新建立证据；移除再添加执行器不能复活审批。候选有效期包含安全信号、额度占用与质量证据，已发布快照也不能越过这些证据期限继续规划。
6. **画像发布适配器。** `ProfilePublisher` 支持启动发送、变化事件、心跳、停止订阅与合并背压。先等待宿主持久化序号，再发送；心跳不重写采样时间。输入源、持久化序号和认证发送端由宿主注入，尚无独立 PC agent 进程。
7. **链路保守处理。** 同一方向出现冲突 networkEpoch 时不发布可用链路；中继声明继续不进入当前直连规划。生产链路拟合和中继留给 B5。

### 本轮文件

| 范围 | 新增或修改 |
| --- | --- |
| 核心与端侧协议镜像 | `packages/scheduler-core/src/resources-v2.ts`；`apps/harmony/scheduler/src/main/ets/v2/protocol/ResourcesV2.ets` |
| T2 schema/fixture | `contracts/scheduling/v2/schema/resources.schema.json`；`fixtures/t2/valid/CapabilityAdmission.json`；对应 missing/unknown 两份非法 fixture |
| 协调者 | `services/coordinator/src/profile-projection.ts`（新增）；`directory.ts`、`planning.ts`、`app.ts` |
| PC 画像适配器 | `services/pc-agent/src/profile-publisher.ts`（新增） |
| 测试 | `scripts/test-resources-protocol-v2.mjs`；协调者 `profile-projection.test.cjs`（新增）、`fixtures.cjs`、`directory.test.cjs`、`channel.test.cjs`；PC `profile-publisher.test.cjs`（新增） |
| 文档 | 两个服务 README；本交接；[T2 字段消费者核对表](T2-FIELD-CONSUMERS.md) |

无新增依赖，无数据库 schema 或迁移变更。没有修改 v1 业务代码；核心新增导出仍执行 v1 回归。

## 测试边界

新增替身用例：

- 画像与快照原子提交、失败回滚、重复幂等、未配置策略及错误身份拒绝。
- 同机两个持有者的实例保留、RAM 占用汇总、目标碰撞拒绝。
- 安全信号过期使保留的旧快照不可规划；跨组/持有者/目标/域/修订号证据拒绝。
- 删除再注册不复活审批；未结算池删除拒绝；冲突 networkEpoch 与中继候选拒绝。
- 执行器版本变化只失效对应目标；账本升代要求新证据。
- 发布器启动/变化/心跳、序号先持久化、背压合并、非法采样拒绝、停止取消订阅。
- **真实 TLS/WS 连接 + 模拟画像**：发送、ACK、目录、快照、所有者活动撤候选、心跳及冒充持有者拒绝。不是手机/PC 实际计算验收。

最终命令与数量以文末记录为准。开发过程中第一次协调者测试暴露旧测试直接写入无结构 ACTIVE 证据，已将测试替身改为严格的 SIMULATED 结构化证据。单独测试曾从仓库根目录运行，因原有测试依赖服务工作目录而找不到迁移脚本；改在 `services/coordinator` 下运行通过。没有放宽校验去兼容旧审批，也没有更改测试预期以掩盖失败。

## 接续注意事项

1. **B3 全包尚未完成。** [字段表](T2-FIELD-CONSUMERS.md) 明确列出每类字段的消费者和缺口。`actualModel/timings`、`YieldNotice`、能力包评测等仍不能只凭 schema 宣称可用；完整状态机属于 B11。本轮只建立证据格式及候选门控，没有自动晋级服务。
2. 接续仍优先补交接中的 **B4/B6 恢复通信**：独立客户端、持久化信封序号和 outbox、`AttemptStatusQuery/Reply`、账本/外部引擎恢复对账。`ProfilePublisher.nextSequence/publish` 只是注入端口，不能代替这套持久化实现。
3. 保持“先预留、后授权；取消不释放；UNKNOWN 持续占用”。画像与快照不会调用额度释放，也不代替缩额 ACK。
4. 生产能力资格应由受信评测服务产生，再更新投影。`qualifySimulated` 仅在测试文件中，且拒绝 REAL 域；没有允许远端自报 ACTIVE 的接口。生产派发仍需把认证、最新资格/策略检查、调度与账本接成完整闭环。
5. 分阶段补齐制品、真实 CPU 执行器、队列、自动评测后，再核对 T2 冻结出口。手机/GPU、原生 HAR、断电恢复、实际性能均未验证，不能据此宣称手机与 PC 已协同执行。
6. 原 A+B 补丁仍是旧交付快照，本轮没有覆盖它；不能将旧补丁误认为包含此增量。当前工作区为接续成果来源。

自行决定事项：配置入口保持受信本地 API，暂不新增管理 UI/公开接口；没有策略默认不发布可派发授权。能力证据不兼容迁为 ACTIVE，采用保守失效。原始画像与快照投影共用表但使用不同键命名空间，无需破坏性迁移。

与规格的差异：T2 尚未冻结、逐字段消费者尚不完整；部分消费者依赖后续 B5/B6/B7/B11，因此不将当前增量标为 B3 全包完成。字段表是接续清单，不是对 R14 的豁免。

## 最终验证记录

| 命令 | 最终结果 |
| --- | --- |
| `npm run scheduler:v2:test` | 退出码 0；核心 4 套件/18 测试；PC 9 测试；协调者 28 测试；架构边界 18 测试 |
| T1/T2 协议（包含在上项） | T1 495 断言；T2 352 fixture/非法输入检查；TS/ETS 转译一致，不等于原生 HAR 构建 |
| `npm run architecture:test` | 退出码 0；v1 worker/protocol/迁移/cloud-shopping/placement 通过；API 41 套件、326 单测通过 |
| `npm run api:build` | 退出码 0；核心、Prisma 生成、Nest 构建通过 |
| `git diff --check` | 退出码 0；该命令仅覆盖 Git 已跟踪差异，不代替新增文件的类型检查和测试 |

本地日志：`.test/v2-b3-final.log`、`.test/v2-b3-regression.log`、`.test/v2-b3-api-build.log`。未运行真实 GPU/手机测试、未部署服务、未执行数据库破坏性操作；无新增依赖。构建提示的工具升级建议没有自动执行。

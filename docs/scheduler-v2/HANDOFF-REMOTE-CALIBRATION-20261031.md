# 远程校准与 PC 宿主接续记录

> 同日后续进展：独立 PC 启动入口、任务公共接口、文本能力以及事件唤醒已接通。本文保留上一轮过程记录；最新状态、设计差距与运行命令见 [设计落地核对](DESIGN-GAP-AND-CPU-HOST-20261031.md)。下文的“周期领取”“默认 main 未装配”和“无业务启动 CLI”已被后续增量替代。

日期：2026-10-31（北京时间）。本轮只推进软件搭建与本地验证，不做真机验收。

## 接手基线与开发优先级

已从 GitHub 快进拉取 `origin/codex/scheduler-v2-foundation`，接手提交为 **`29fa2e435474104be62b32f6d591128f298fb69c`**，标题为 `Advance scheduler v2 provisioning, quota maintenance and qualification lifecycle`。本文件记录在该提交上继续实现的工作；这个哈希是拉取基线，不是本轮新增代码的发布提交。

协作者已经提供设备注册/配对命令、自动额度维护、系统资源监测、持久化画像发送、能力证据查询和协调者校准循环。本轮补齐其中的跨进程评测执行链路，不改回旧购物应用专用方向。团队共享资源空间仍是要落地的应用场景，通用协同能力为它提供支撑。

用户本轮明确要求：**以功能落地为最高优先级，降低或弱化妨碍推进的安全围栏。** 接续时应先打通可启动、可执行、可观察的功能流程，减少重复检查、前置审批和过度抽象；生产加固可以后置。资源账本、任务去重和组/持有者隔离作为运行正确性的一部分继续保留。不要把完成所有 R5 扩展项当作先展示基本功能的前提。

## 本轮实现的效果

协调者安装可信能力包后，校准循环可以自动发现设备目标，持久化评测许可；PC 宿主通过配对后的 HTTPS 连接领取许可，用本机已安装的样例执行真实 CPU 运算，再回传参考输出。协调者使用自己的参考判定函数更新 CANARY/ACTIVE，并刷新规划画像。

设备不需要获得协调者数据库，也不需要由协调者直接调用同进程中的执行器。业务任务和校准仍使用同一个 `DurableLedger`。现有业务整合测试已从直接调用校准执行器改为经过网络校准，再执行制品下载、CPU 运算、制品上传和持久化回执。

| 代码入口 | 已实现的职责 |
| --- | --- |
| `packages/resource-transport/src/evaluation-wire.ts` | 共享许可、领取响应、结算结果类型及网络格式校验 |
| `services/coordinator/src/remote-evaluation.ts` | 持久化许可队列、领取、取消、结果去重和重启查询；实现 `EvaluationRunner` |
| `services/coordinator/src/app.ts` | 配对凭证认证的领取/状态/结果接口；`startCalibration` 不传 runner 时使用远程执行 |
| `services/pc-agent/src/calibration-worker.ts` | 单任务领取、调用本机可信样例、状态监测、取消与结果补报 |
| `services/pc-agent/src/calibration-executor.ts` | 新增 `runInstalled`，只使用已安装样例的输入和参数 |
| `services/pc-agent/src/agent.ts` | 可选校准 worker 与 agent 启停、恢复屏障及所有者状态一起运行 |
| `services/coordinator/prisma/migrations/202610310001_remote_evaluation/` | 新增 `EvaluationDispatch` 表；不改写旧业务数据库 |

新增接口：

| 请求 | 用途 |
| --- | --- |
| `POST /v2/evaluations/claim`，正文 `{}` | 返回当前持有者的一项工作或 `work: null` |
| `GET /v2/evaluations/:id` | 返回取消意图及协调者是否已收到结算结果 |
| `POST /v2/evaluations/:id/report` | 提交真实结算后的参考输出；重复相同结果可再次确认 |

本轮采用短周期 HTTPS 领取，默认 500 ms，可由宿主配置。业务派发仍使用原 WS 通道。每个 worker 同时只处理一个评测；每个持有者最多有 8 项未结算评测。网络参考输出上限为 64 KiB，适合当前小型参考样例；普通业务制品仍走既有制品通道。

## 如何装配

协调者完成启动和恢复后：

```typescript
runtime.startCalibration({
  packs: installedTrustedPacks,
  policy: evaluationPolicy,
  gate: currentAuthorizationAndResourceGate,
  onError: reportError,
  intervalMs: 1000
}); // runner 省略，即使用持久化远程执行器
```

在现有 `PcAgent` 配置中添加：

```typescript
calibration: {
  executor: installedCalibrationExecutor,
  intervalMs: 500
}
```

`installedCalibrationExecutor` 使用与该 agent 相同的账本；`offerFor` 与 `authorize` 仍由本机宿主负责构造正确的当前额度、目标、资源与授权上下文。`PcAgent` 只有在恢复完成且所有者空闲时才领取评测；执行期间周期检查所有者和取消状态。关闭宿主先取消/等待评测结束，再关闭网络和账本。

完整网络与业务装配示例：`services/coordinator/test/agent-integration.test.cjs`。独立进程及自动校准循环示例：`services/coordinator/test/remote-evaluation.test.cjs` 与测试专用子进程 `remote-evaluation-worker.cjs`。子进程收到的是测试配置，不能作为生产配置直接复制使用。

默认 `services/coordinator/src/main.ts` 尚未加载可信包与启动校准循环；本轮也没有把完整业务 agent 包装成可供最终用户直接安装的 CLI。不要把上述可用宿主接口描述成已部署的完整产品。

## 故障处理与验证

已经领取的许可再次出现时，worker 只查询本地结算记录；已有结果可补报，未知引擎状态不会重新执行。协调者重启后，旧代次的已领取许可只能对账；未领取许可可以凭未执行证据结束。取消指令不是资源已经释放的证明。

“协调者确认领取、设备却未收到响应”仍属于不确定投递：当前保守保留，不会自动重新执行。后续可增加持久化领取确认协议，改善这一少见故障的自动恢复体验。完成历史也暂未压缩；这是接续事项，不阻挡当前软件演示链路。

本轮新增验证覆盖：

- 独立 PC 进程 + 真实 TLS + 真实 CPU + 自动校准循环，未手工设置 ACTIVE。
- 故意丢失结果发送后，复用本地结果补报；执行次数保持一次。
- 相同结果重复提交、冲突结果拒绝，其他持有者无法读取或提交该许可。
- 取消、协调者代次变化、已领取状态重开后对账、未领取任务的非执行证明。
- 所有者转为忙碌时取消评测，关闭等待本地执行结束，陈旧安装不启动。
- 原有端到端业务链路继续经过资格门控、制品通道和 WS 回执。

复现命令（仓库根目录）：

```powershell
npm run scheduler:v2:test
npm run lab:test
```

已有安装升级时，先构建协调者，再执行 `npm --workspace @harmony/coordinator run db:init` 应用新增表。`coordinator:dev` 和测试辅助程序已包含迁移步骤。不删除或重建已有账本来升级。

本轮实际验证结果：

| 检查 | 结果 |
| --- | --- |
| `npm run scheduler:v2:test` | 退出码 0；核心 6 套件/24 项、传输 1 项、PC 30 项、协调者 49 项、架构依赖 18 项全部通过 |
| 协议检查（包含在上一项） | T1 495 断言、T2 352 检查通过；不代表 HAR 原生编译通过 |
| `npm run lab:test` | 退出码 0；确定性 2 项、额度/制品/校准/恢复/端到端整合 16 项通过 |
| `git diff --check` | 通过 |

日志：`.test/continuation-v2-20261031.log`、`.test/continuation-lab-20261031-retry.log`。第一次实验室构建与正在运行的协调者回归重叠，Windows 拒绝替换被占用的 Prisma DLL；等待前一轮结束后串行重跑通过，无需改变功能代码。Windows 下不要同时执行两个会重新生成该客户端的构建/测试入口。

日志及测试凭据位于被忽略的 `.test/`，不纳入 Git。本轮未修改旧购物 API 实现，也未重跑旧 API 全量回归；未做鸿蒙 SDK 编译、手机、CUDA 或真机验收。本轮新增修改仍在本地工作区，尚未提交或推送 GitHub。

## 下一步按功能闭环推进

1. 将已具备的配对、额度维护、系统采集、画像构造、可信包安装、远程校准装配成一个业务启动入口。重点是使用配对配置就能持续运行，不再要求人工编写宿主。
2. 将任务授权、输入/输出制品签票及数据访问接到协调者接口，替换整合用例中的本机函数注入；完成“提交任务—选设备—运行—看结果”的日常入口。
3. 接团队空间的邀请、设备列表、状态与任务反馈界面，形成可操作演示；逐步加入手动优先级、让出反馈、链路/数据位置决策。
4. 再补多设备并发、SDK 来源端、协同会话/展示端和其余实验矩阵。鸿蒙、GPU、真机验收继续暂缓；软件测试不填作真机通过。

本轮推进了 P0 的远程评测和宿主接入部分，**P0、B 阶段及完整国赛演示仍未全部完成**。

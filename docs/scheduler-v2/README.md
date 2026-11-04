# 调度 v2 文档入口

所有提交者开工前按以下顺序阅读：

1. [specification-r6.md](specification-r6.md) （修订 6.1，沿用原文件名）的 §00 方向声明与 §1 全局规则；
2. [STATUS.md](STATUS.md)：当前切片、工作包状态、待真机清单；
3. 规格 §10.0 中当前切片涉及的工作包，以及这些工作包引用的章节。

**方向摘要**：协调者（宏观调度器）部署在局域网内指定的一台 PC 上；手机、平板、PC 是等价终端；所有任务只经过一条派发路径（`PlanningService`）；按切片 S1 → S8 推进；云端协调者是 S1—S8 完成后的可选尝试链路，不是当前主要工作。

## 统一开发基线（2026-11-01）

所有提交者统一使用 **HarmonyOS 6.0.2 / API 22** SDK 编译 SoleAI、调度件、探针及 scheduler HAR，目标系统基线同为 HarmonyOS 6.0.2。targetSdkVersion 与 compatibleSdkVersion 均为 `6.0.2(22)`。安装路径允许不同，通过 `DEVECO_STUDIO_HOME` 和 `DEVECO_SDK_HOME` 指定；v2 构建脚本拒绝其他 SDK。历史 API 24 结果不代表 API 22 验证通过，原生构建、模拟器和真机须分别验收。

优先完成 S3 鸿蒙来源 App 宿主、本机/PC 统一选择与输入无外传，再推进断线交回原有本地调度、旧任务恢复和取消。按用户后续授权，先连续完成各切片实现、构建和可运行测试；无模拟器或真机时设备验收单独登记待验，不阻塞后续实现，也不将切片标成已验收。2026-11-04 用户进一步授权：实现中出现问题或矛盾时，先按主线提出建议方案并继续修复、推进；涉及改变部署方向、单一派发路径或切片范围的决定仍先确认。

SDK 的 TS/ArkTS 源码一致性测试只验证同步，不验证 ArkTS 语法。修改共享 SDK 后必须运行 `npm run sdk:test` 和 `npm run harmony:v2:har`；涉及原生宿主时还需构建 agent/probe 并运行模拟器验收，分别记录结果。

## 文档状态

| 文档 | 状态 | 用途 |
| --- | --- | --- |
| [specification-r6.md](specification-r6.md) | 现行 | 实施规格修订 6.1；联网边界见 §00.0，失联检测与受限对冲见 §6.5 |
| [STATUS.md](STATUS.md) | 现行 | 唯一的进度记录，每次提交后更新 |
| [HANDOFF-S3-20261101.md](HANDOFF-S3-20261101.md) | 交接快照 | 应用户明确要求整理，记录 `447904f` 代码基线、复现与接手步骤；后续状态仍查 STATUS |
| [LOCAL-COORDINATOR-20261031.md](LOCAL-COORDINATOR-20261031.md) | 现行 | 局域网协调者的启动与验收操作说明 |
| [TELEMETRY-DASHBOARD.md](TELEMETRY-DASHBOARD.md) | 现行 | E2 最小只读调度盘入口、数据来源、部署方式与 PC-A/PC-B 计划拓扑；不代表 E2 完整验收 |
| [T2-FIELD-CONSUMERS.md](T2-FIELD-CONSUMERS.md) | 参考 | T2 字段与消费者对照；与规格冲突时以规格为准 |
| [specification-r5.md](specification-r5.md) | 已被取代 | 修订 5，仅供对照 |
| 除上述 S3 快照外的 `HANDOFF-*.md`、[DESIGN-GAP-AND-CPU-HOST-20261031.md](DESIGN-GAP-AND-CPU-HOST-20261031.md) | 历史记录 | 各轮实现过程记录；其中的“下一步”与优先级已由规格 §10.0 和 `STATUS.md` 取代 |
| [TEAM-SPACE-CLOUD-20261031.md](TEAM-SPACE-CLOUD-20261031.md) | 历史记录（非主线） | 协作空间与云端部署说明；云端协调者已冻结 |
| [../Harmony团队共享算力空间功能设计方案.md](../Harmony团队共享算力空间功能设计方案.md)、[../Harmony共享算力空间能力盘点与国赛开发计划.md](../Harmony共享算力空间能力盘点与国赛开发计划.md) | 历史文档（已失效） | 早期“团队共享算力空间”产品定位与开发计划，已被规格修订 6 取代，不得作为开发依据 |

默认不再新增 `HANDOFF-*` 文档；本次按用户明确要求新增 S3 交接快照，不作为第二份持续维护的进度文件。需要记录的进度仍写入 `STATUS.md`；需要改变方向或范围时，先由用户确认，再修改规格。

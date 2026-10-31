# 调度 v2 文档入口

所有提交者开工前按以下顺序阅读：

1. [specification-r6.md](specification-r6.md) 的 §00 方向声明与 §1 全局规则；
2. [STATUS.md](STATUS.md)：当前切片、工作包状态、待真机清单；
3. 规格 §10.0 中当前切片涉及的工作包，以及这些工作包引用的章节。

**方向摘要**：协调者（宏观调度器）部署在局域网内指定的一台 PC 上；手机、平板、PC 是等价终端；所有任务只经过一条派发路径（`PlanningService`）；按切片 S1 → S8 推进；云端协调者是 S1—S8 完成后的可选尝试链路，不是当前主要工作。

## 文档状态

| 文档 | 状态 | 用途 |
| --- | --- | --- |
| [specification-r6.md](specification-r6.md) | 现行 | 实施规格，方向与规则以此为准 |
| [STATUS.md](STATUS.md) | 现行 | 唯一的进度记录，每次提交后更新 |
| [LOCAL-COORDINATOR-20261031.md](LOCAL-COORDINATOR-20261031.md) | 现行 | 局域网协调者的启动与验收操作说明 |
| [T2-FIELD-CONSUMERS.md](T2-FIELD-CONSUMERS.md) | 参考 | T2 字段与消费者对照；与规格冲突时以规格为准 |
| [specification-r5.md](specification-r5.md) | 已被取代 | 修订 5，仅供对照 |
| `HANDOFF-*.md`、[DESIGN-GAP-AND-CPU-HOST-20261031.md](DESIGN-GAP-AND-CPU-HOST-20261031.md) | 历史记录 | 各轮实现过程记录；其中的“下一步”与优先级已由规格 §10.0 和 `STATUS.md` 取代 |
| [TEAM-SPACE-CLOUD-20261031.md](TEAM-SPACE-CLOUD-20261031.md) | 历史记录（非主线） | 协作空间与云端部署说明；云端协调者已冻结 |
| [../Harmony团队共享算力空间功能设计方案.md](../Harmony团队共享算力空间功能设计方案.md)、[../Harmony共享算力空间能力盘点与国赛开发计划.md](../Harmony共享算力空间能力盘点与国赛开发计划.md) | 历史文档（已失效） | 早期“团队共享算力空间”产品定位与开发计划，已被规格修订 6 取代，不得作为开发依据 |

不再新增 `HANDOFF-*` 文档。需要记录的进度写入 `STATUS.md`；需要改变方向或范围时，先由用户确认，再修改规格。

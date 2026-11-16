# SoleAI 真机检索与 Windows 调度观测记录

日期：2026-11-14。本轮只评测 SoleAI，并补齐观测页面；不修改图片增强 App、照片算法或调度策略。

## 测试结果

手机、鸿蒙电脑通过 Wi-Fi 接入 Windows 协调中心。USB 仅用于安装、读取日志和操作手机，没有配置 HDC 网络转发。手机使用已安装的 SoleAI，文字输入为“500元以内的运动鞋”，图片由用户从相册选择此前的鞋子照片。

| 轮次 | App 总耗时 | 业务结果 | 协调中心实际执行 |
| --- | --- | --- | --- |
| 文字第一次 | 47.489 秒 | 30 件商品 | 鸿蒙电脑完成 `catalog.filter.v1`，SUCCEEDED、资源已结算；EXECUTE 8 ms，SDK 提交至校验结果 569 ms |
| 图片第一次 | 约 7.576 秒 | POLICY_REJECTED | 云端依赖健康检查不通过，未派发局域网商品计算 |
| 同图重试 | 40.203 秒 | HTTP 201，0 件候选商品 | 没有候选商品，未触发相似度复核或筛选；不能判定图像检索质量或协同计算验收通过 |
| 文字第二次 | 13.777 秒 | 30 件商品 | 手机 SoleAI 执行器完成 `catalog.filter.v1`，SUCCEEDED、资源已结算；EXECUTE 5 ms，SDK 提交至校验结果 588 ms |

两轮文字均经过现有 SDK 与协调器，但只有第一轮属于跨物理设备执行。没有强制派发、增加虚构计算负载或宣称 GPU 参与。

第一次文字请求的云端 HTTP 用时 7.155 秒，第二次 6.837 秒；总时长还包含能力与网络探测、处理响应和 SDK 计算。首次图像失败对应 `remoteDependencyHealth:false / REMOTE_UNAVAILABLE`，同期服务视觉探测出现 30.006 秒超时；后续视觉恢复但依赖仍有波动。图像重试 HTTP 请求耗时 24.729 秒，最终候选数为零。以上不足以把零结果归因为照片、商品库或模型的某一个确定因素。

## 为什么额度圆环可能一直为零

CPU 槽位、内存额度表示采样时调度任务占用的资源额度，不是整机 CPU 使用率，也不是 SoleAI 进程内存。商品筛选只有 5～8 ms，准入、加载、发布和结算也很短，可能全部发生在两次画像采样之间。任务结算后额度归零符合语义，不能把已释放额度保留为非零来制造活动效果。

云端搜索等待不占用本地协同计算额度；图片检索没有候选商品时也不会凭空产生本地筛选任务。本轮实时采样验证画像序号持续递增，SoleAI 业务阶段由 CLOUD_REQUEST 变为 FINISHED，进程 CPU、PSS 内存也持续上报。

## 已落地的观测补齐

- Windows 新增与原生端对应的 `/v2/apps/me/activity` 接收接口，绑定已注册 App 身份；有界内存存储，15 秒失效，不写调度资源或任务状态。
- 设备资源页上方显示 SoleAI 的应用进程 CPU、PSS 内存、文字/图片业务阶段及结果。它们是应用上报的状态，不能代替调度执行回执。
- 设备卡片新增“本设备执行记录”，显示当前历史窗口成功数、已释放资源数和最近三条任务；点击进入已有任务决策与阶段时间线。拒绝任务不计为成功，不把其他设备的任务归给本设备。
- 原圆环改称“瞬时额度”，明确与实测 CPU、应用内存区分。历史只统计协调中心当前返回的最近 100 条任务，不冒充全量累计。

查看方式：调度盘 → 设备资源 → 对应设备卡片；实际执行证据点击“本设备执行记录”中的任务。查看执行目标、状态、资源结算及 EXECUTE/LOAD/PUBLISH 阶段。跨度可能包含子跨度，不应简单相加。

## 代码与部署

- `services/coordinator/src/app-activity.ts`：应用观测内存存储。
- `services/coordinator/src/app.ts`、`telemetry-view.ts`：鉴权接收、空间快照投影。
- `apps/team-space-web/dispatch-activity.mjs`、`dispatch.js`：业务资源、短任务历史展示。
- `scripts/runtime-desktop.cjs`：新增静态模块白名单。
- `services/coordinator/test/app-activity.test.cjs`：身份隔离、过期、零值、真实接口、短任务证据展示。

本机已安装的协调中心已更新接收端并正常重启、完成设备重连；后续设备卡片改动只更新静态文件，无需再次重启或配对，刷新页面加载。桌面启动脚本采用原安装版加静态白名单的最小补丁，未把工作区内其他尚未配套安装的桌面改动一并覆盖。此前 ZIP 合集没有包含本轮新增内容。

手机安装的 SoleAI HAP SHA256：`B29D675097D9060A2E572D4C7251DA26481FDF50922058BF34EB460F15488559`。这次观测修复无需再次安装手机 App 或设备 B 包。

## 验证与证据

TypeScript 构建、前端语法检查通过。`app-activity.test.cjs` 与 `device-telemetry.test.cjs` 共 7 项通过，包含鉴权接口不会改变设备/attempt/outbox 记录的检查。

第一轮文字 job：`phone_1794588179927_1-4f935d7d-19d3-4243-bf76-047fffc1137f`，trace：`ce8a4bf1-5088-4e56-a49b-47e1793ed54e`。

第二轮文字 job：`phone_1794588851317_4-a5963000-ea9e-475f-8cfe-63dd9976cbaa`，trace：`2e0e75a3-072f-4b6c-9f33-fb7d2b6f6bf6`。

本地原始证据保存在 `.test/soleai-evaluation-20261114/`：`text-trace.txt`、`image-trace.txt`、`image-retry-trace.txt`、`telemetry-before-retry.json`、`telemetry.json`、`live-samples.json`、`second-text-trace.json` 及 UI 记录。该目录还含配对材料，不应整体提交仓库；本报告不包含凭据。

未完成项：图像检索的有效商品命中与后续跨设备相似度计算仍未验收；本轮也不能证明 SoleAI 因跨设备而提速。文字计算量很小，不能用持续高 CPU 利用率作为是否实际执行的判据。

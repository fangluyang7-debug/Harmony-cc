# 真实购物图像复核工具（E2）

此工具延续 SoleAI 业务服务 → 独立 App → SchedulerSdk → PlanningService → 终端执行器的架构。真实需求为“500元以内的运动鞋”：先从现有购物服务取得不同商品的原图，再计算全部唯一图像对的外观相似证据，供购物 Agent 复核近重复候选。商品筛选 `catalog.filter.v1` 仍保留。

## 业务与算法边界

新能力 `image.visual-match.v1` 在 Windows 和鸿蒙上编译同一份 C++ CPU 内核。图片最大边为 512 像素；采用两种空间尺度的局部梯度直方图、双向最近特征距离和前景平均颜色。整型归一化、积分直方图与 SSE2/NEON 距离累加保持两端输出一致。30 张不同商品图对应 435 个唯一图像对，不复制商品、不重复图像对、不用循环参数放大负载。

输出是外观相似指数、纹理/颜色分量及比较次数，**不是同款判定、语义识别或概率**。当前没有标注集上的准确率验收，不能自动据此删除商品。云端检索是真实购物 Agent；本地工具编排与合并是确定性程序，不冒充新 LLM Agent。

内核使用方向积分直方图及 SSE2/NEON 整数距离计算。每个候选特征对仍参与最近二匹配；累积距离已不可能改进两个方向的第二名时，可精确跳过后半维度，结果保持一致。输出的 `comparisons` 是候选特征对数量，不表示每对均计算了全部 128 维。

本轮交付的是可运行的独立 SDK 工具和只读结果报告，**尚未嵌入 SoleAI 手机聊天的自动工具调用**。调度盘会显示实际任务、设备与追踪，不增加第二条派发入口。

## 输入与执行

- 输入契约 `image.visual-bundle`：`HVG1` + 原始长度 + zlib 压缩的图像及图像对索引；单任务最多 32 张图、128 对、8 MiB 压缩输入。
- 输出契约 `image.visual-evidence`：规范化的图像对证据，合并时拒绝遗漏、重复或非法结果。
- 应用按图像块的上三角划分，只上传该分片涉及的图片；分片只由输入和粒度决定，不按设备预分配。
- 每个工作流有新的 UUID 和输入 artifact；来源端计时开始后读取原图、校验、归一化和压缩，随后注册并通过 SDK 上传。远端在任务内部解码和提取特征，无跨任务特征/结果缓存。
- Windows 执行器在受控 CPU 子进程中计算，取消等待子进程退出；鸿蒙 N-API 异步工作线程计算并检查取消标记。
- 独立 App 只声明该合同；单机用目标约束作为对照，协同不指定 targetId，由现有规划器选择。Windows 6、手机 2 是现场配置的槽位，脚本从设备设置读取，并非设备型号限制。

## 复现

先构建能力包、PC 代理、协调者及 Windows 应用，再构建安装 scheduler HAR/鸿蒙设备 HAP。正式基线仍是 API 22，本轮 API 24 本地签名包不代表 API 22 或通用发行通过。

首次下载真实输入到**来源电脑**的新目录，不把目录复制到执行设备：

```powershell
node scripts/acquire-shopping-images.cjs https://api-server-production-0135.up.railway.app .test/new-shopping-images "500元以内的运动鞋"
```

私有配置文件包含 `address`、协调中心证书路径 `caFile`、空间 `group`、当前空间会话 `cookie`、两台实际设备 ID 数组 `devices`（Windows 在前）、本机已配对代理配置路径 `ownerConfig` 和新 App 凭据保存路径 `appConnectionFile`。凭据只保存在忽略目录，不提交 Git。工具用本地所有者身份注册独立 App，后续使用 App 凭据；不会修改设备配额。

```powershell
node scripts/shopping-visual-agent.cjs .test/visual-shopping/config.private.json .test/new-shopping-images/manifest.json .test/new-visual-results.json 64 3
node scripts/audit-visual-shopping.cjs .test/new-visual-results.json <协调中心SQLite文件>
node scripts/render-shopping-visual-report.cjs .test/new-visual-results.json .test/new-shopping-images/manifest.json .test/new-visual-report.html
```

输出文件必须是新文件。最后一个可选参数为 `WINDOWS`、`PHONE`、`TEAM` 或它们的逗号分隔列表，省略时三种模式按轮次轮换顺序。每任务 30000 ms，完整工具预算 120000 ms；失败保留原记录并停止该组，不把成功片段拼接成完整结果。

## 公平性与验收口径

同一组使用固定原图、相同归一化、图像对、分片、算法及预算；计时含输入准备、上传、调度、计算、输出校验和合并。云端候选获取另报耗时，避免每次查询结果变化破坏同输入对照。启动校准只用参考夹具；没有真实输入预热轮。单机允许使用自身全部配置槽位，并继续走相同 SDK/协调器；不是直接函数调用的单机极限性能。

连续重负载曾触发手机 `THERMAL_LIMIT`，该失败完整保留。当前每个模式计时前采用同一规则：至少空闲 30 秒，两端在线、校准完成、能力可用且无能量门控；已知温控等级不高于 2，并连续稳定至少 5 秒。未知温度原样记录，不当作零。最多等待 5 分钟，否则终止测试。等待阶段不读取或传输任务图片，等待耗时及前后状态存入原始 JSON，不能把这一口径解释为连续满载吞吐量。

若现场无法满足等级 2 的较严格条件，可在单独记录的实验配置中设置 `maximumStartThermalLevel: 3`，对照实际可运行温态。该参数只控制测试前等待条件，不能超过 3，不改变设备原有 `OVERHEATED` 门控、额度或任务预算。整个组使用同一条件，公开保存每次的实际等级；等级 3 结果不能称为冷机结果，也不能与等级 2 的数字混算。

审计核验每个任务唯一 attempt、committed 回执、资源结算、结果接收、实际设备、输入上传与执行追踪、新 artifact，以及各模式完整输入/结果哈希一致。只有整轮成功且两台设备实际执行，才能作为双机数据。USB 只安装/调试；无线证据另存 WLAN/wlan0、协调中心连接与 HDC 无转发记录。

原始数据、失败尝试、正式结果和结论见 [实测报告](../../artifacts/acceptance/2026-11-09/shopping-visual/README.md)。不得把某一图片工具的结果扩大成整个购物流程、三机或所有任务均加速。

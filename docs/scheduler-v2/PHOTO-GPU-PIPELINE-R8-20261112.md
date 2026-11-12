# GPU 设备端流水处理 R8（2026-11-12）

## 用户最近六图记录

会话 desktop-172.20.10.6-BUNEjh，三轮六张原始图片哈希及顺序一致，全部交付。汇总证据见同名 JSON；未复制用户图片或身份资料。

| 批次 | 手机记录总耗时 | B GPU 增强块 | 本机 CPU 增强块 | 手机增强块 | GPU EXECUTE 累计 | GPU 最长计算间隔 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| f485c3fe | 21.318 秒 | 16 | 6 | 2 | 2.707 秒 | 2.413 秒 |
| 6afc1430 | 26.839 秒 | 17 | 4 | 3 | 2.796 秒 | 8.281 秒 |
| b70b19ff | 33.023 秒 | 0 | 19 | 5 | 无 | 无 |

最后一轮 24 个 GPU 候选均被标记 CONTROL_OFFLINE。前两轮确有 VULKAN 执行回执，不能据任务管理器 0–1% 判定 GPU 完全未参与。26.839 秒轮次 GPU 分块中位执行时间约 172 ms，本机 CPU 约 1846 ms，手机约 5743 ms。后两者样本数量和分块大小不同，此处仅用于找尾部计算瓶颈，不作等工作量硬件性能比。

GPU 执行区间分别分布在 14.866 / 19.647 秒窗口内，中间有大量空档。EXECUTE 包含引擎调用及必要处理，不是显卡硬件利用率；并行节点区间不能直接相加当作用户总耗时。8.281 秒空档还受后两张工作流较晚提交、CPU 尾部和准入影响，不能全部归为传输或唯一 GPU 名额。

## 原因与实现

1. 旧设备端把 LOAD、EXECUTE、PUBLISH 整个任务生命周期放在单个 exclusive GPU slot 内。增加远端队列后，下一块仍必须等上一块发布、结算，无法隐藏网络和前后处理。R8 的原生照片 Vulkan 执行器允许按显存决定 1～4 个并发任务生命周期（每 GiB 一个，上限四个）；四槽表示同一 GPU 的四路工作，不是四张显卡。4 GiB 及以上设备可四路重叠；每项仍分别占用真实的 CPU、RAM、VRAM 账本额度。其他未声明并发的 CUDA/旧执行器保持原能力。
2. 协调中心设备物理预算上限、设备额度申请、画像和派发准入同步支持此并发语义；旧设备画像仍只有一槽，不能因中心升级被强行并发。允许执行槽以外最多三个等待，总未结算不超过七个，兼容 agent 的八项 pending 上限。预算、显存不足或长队列仍可使 CPU 更早完成，不绑定 B 的设备 ID。
3. 修复 VRAM admissionLimit 使用 freeBytes 后又被账本减 occupied 的重复扣减。总可准入量取 freeBytes + 当前自身占用，并受物理显存、贡献上限约束，与现有 RAM 计算一致。不提前释放未结算资源，不绕开实际取消和结果校验。
4. Vulkan 模型空闲保留时间由 60 秒延长至 10 分钟，进程池仍最多四个，取消会等待进程退出。只复用模型，不缓存照片和推理成品；CPU 工作进程保留原策略。真实照片不在任务开始前放到 B，也不修改 float32 模型、放大倍数或质量阈值。
5. 执行器版本更新为 3，使新运行策略重新建立资格/成本证据。新增 PHOTO_GPU_TIMING 日志：attemptId、NVIDIA 设备名称与 Vulkan 索引、modelLoaded、modelLoadMs、inferenceMs。新版 Check-Photo-GPU.cmd 报告四路参考推理及随后模型复用的证据；明确标记 installation-reference-only，不作为业务加速成绩。

主要文件：

- packages/scheduler-core/src/gpu-pipeline.ts、index.ts
- services/pc-agent/src/host.ts、image-encoder.ts、photo-accelerator.ts
- services/pc-agent/src/executors/photo.ts、photo-workers.ts
- services/coordinator/src/spaces.ts、directory.ts
- scripts/check-photo-device.cjs

## 验证及边界

构建通过；68 个不同回归通过：设备画像/显卡选择 5、设备调度与 CPU 模型执行 11、Vulkan 4、GPU 队列与空间 7、目录/规划/照片工作流 38、运行库打包 3。

新增关键回归实际运行账本与队列：前四项 GPU 结果发布被阻塞时均能进入引擎，第五项等真实结算；重复提交只返回原回执。四个真实 Vulkan 子进程在本机核显通过未修改的参考质量检查，后续调用 modelLoaded=false。**这不是 B 的 NVIDIA 吞吐验收，不能据此承诺整批耗时。**

空间回归首次发现旧断言仍要求专用设备仅使用 3/4 CPU，而当前已有实现是全部逻辑 CPU；同步修正该过时断言及注释后通过，未为通过测试降低生产 CPU 配额。打包首次缺默认 Node 分发目录，改用当前已安装节点的 Node 运行时后完成。

完整 ZIP 解压到隔离目录，核对八个修改文件与源码构建一致、457 个文件中没有配对身份/数据库。使用解压后的节点与本轮打包中心完成独立会话短码配对、上线、照片 CPU 能力 ACTIVE；没有加入用户空间或代跑用户照片。包内 CPU 诊断 READY、score=1。NVIDIA 诊断由用户在 B 运行。

## 已部署和交付

本机中心旧会话 18 个工作流全部 SUCCEEDED、未结算 Attempt=0 后正常停止；备份到 `.test/gpu-r8-deploy-20261112-185532/`，更新目录与空间模块、scheduler-core 的新函数及两个安装副本。新协调中心 PID 8616，session `desktop-172.20.10.6-SSt6LO`，`https://172.20.10.6:7443/v2/health/ready` 证书校验返回 200 / ready:true。安装标记 PATCH-GPU-PIPELINE-R8.json 为 ACTIVE_AFTER_RESTART。保留 R2～R7 已部署修复及旧测试记录。

本机 Windows 节点在停止状态更新 host、照片引擎桥接与诊断脚本，标记 READY_FOR_NEXT_PAIRING；下次配对启动加载。手机和鸿蒙电脑无需换包。本轮没有 Git 合并、提交或推送。

**给 B 的完整包（必须更新）：**

`dist/调度系统分发-20261112-r8/02-Device-Agent-Windows-x64/02-Device-Agent-Windows-x64.zip`

大小 255700930 字节，SHA-256：

`13e1882c259b31254c7f8ecd95745189bcffa09a72ef7fd0829160aa1bf77366`

包内含 Node/Electron、模型、CPU/Vulkan 引擎；无需配置 CUDA/PyTorch。NVIDIA 驱动由 B 自身提供。此次分发不包含新 HAP。

## 用户复测步骤

1. B 完全退出旧设备调度件，将新 ZIP 完整解压到新目录，避免旧快捷方式启动旧包。
2. 可先双击 Check-Photo-GPU.cmd；应显示 GPU READY、正确 NVIDIA 名称，8 GiB 设备 pipelineSlots=4。失败时保留 PHOTO-DEVICE-CHECK.json；不要以 CPU READY 替代 GPU READY。
3. 打开本机中心“设备配对”，为本机节点、手机和 B 各生成新的设备码；B 运行新目录的 ZhiDiaoHongShu.exe。发现列表为空可手动填 `https://172.20.10.6:7443` 配对。按当前 Wi-Fi 地址为准。
4. 图片 App 重新连接本次空间并等待真实就绪。用相同顺序六张图、同模型及预算分别进行两机/三机测试；每轮结束后再开始下一轮，不额外预放照片。
5. 看整批耗时、首张成品时间、完成张数；之后用回执检查 GPU 实际分块比例、等待与改派。新并发下多个 EXECUTE 区间可重叠，后续 GPU 活跃窗口统计应取区间并集，不能继续把重叠区间求和当作利用率。

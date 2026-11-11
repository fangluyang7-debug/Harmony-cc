# Windows 独显节点无法执行照片增强：分发包问题排查

日期：2026-11-11。排查代码基线：`imageprocessing` / `92f34646c94da2d4822bca19d9dd71c9dcd4af6c`。

**交付范围：仅问题报告，未修复代码、未重新打包、未更新任何设备。** 用户要求先报告并推送文档，由双方据此安排后续修复。独显电脑当前不在局域网，也未运行节点程序；本报告不是该机器的 GPU 真机验收结果。

## 1. 结论

用户提供的 Windows 节点 ZIP 缺少照片增强模型、CPU 推理程序、Vulkan GPU 推理程序及运行配置。包内虽然有照片任务处理代码，但仅安装这个包无法注册核心的 `photo.enhance.v1` CPU 能力，也无法启动照片 GPU 后端。

此外，默认配对流程没有设置显存额度，而 GPU 初始化要求显存额度大于零。**补齐文件与补齐 GPU 贡献配置是两个独立事项**，不能只换一个含模型的 ZIP 就宣布问题解决。

现有打包流程还存在遗漏 GPU 程序的 OpenMP DLL 的问题；双显卡设备选择、失败原因提示也需要检查。当前没有证据证明用户这轮慢主要来自无线网络，也没有证据证明独显已承担增强计算。

## 2. 被检查的包及证据范围

用户提供文件名：`02-Device-Agent-Windows-x64.zip`，外层大小 **200,821,380 字节**。该文件有两层 ZIP：

| 对象 | SHA-256 |
| --- | --- |
| 用户提供的外层 ZIP | `de10585779e15f2de556f97f85ac7e7e269672e42b6f256c52f154a0a3708f53` |
| 内层 `02-Device-Agent-Windows-x64/02-Device-Agent-Windows-x64.zip` | `823e18762c28fbeb897ab43403c86379f15be0654b2227dc16ce94d2dbed74be` |

内层大小 **201,402,603 字节**，共 **483 个 ZIP 条目**。检查采用只读 ZIP 枚举、读取包内 JS、源码对照、本机 SQLite 只读查询和本机已下载 GPU EXE 的导入表检查；没有运行用户提供包内的程序。

证据边界：

- ZIP 缺文件是直接确认的事实；不能据此排除用户曾在远端另外手动安装过运行库或设置环境变量。
- 已核对包内 `host-main.js`、`executors/registry.js`、`photo-accelerator.js` 与本报告涉及的代码条件。
- 本机协调中心检查时没有监听 7443 / 7460；数据库反映已保存历史，不代表独显电脑当前状态。
- 本轮没有远端驱动、显存、GPU 使用率或任务传输耗时采样。不能填写估计值冒充实测。

## 3. 已确认的问题

### P1：分发包缺少核心照片运行库

内层 ZIP 中以下文件均不存在：

| 必需内容 | 检查结果 | 影响 |
| --- | --- | --- |
| `services/pc-agent/dist/photo/runtime.json` | 缺失 | 默认安装路径无法加载模型及引擎配置 |
| `realesrgan-x4plus.param` / `.bin` | 均缺失 | 没有本地增强模型 |
| `photo-runner*.exe` | 缺失 | 无法执行 Windows CPU 增强 |
| `realesrgan-ncnn-vulkan.exe` | 缺失 | 无法执行 Vulkan GPU 增强 |
| `vcomp140.dll` | 缺失 | 补 GPU EXE 后仍需处理其运行依赖 |

包内存在 `dist/executors/photo.js`、`dist/photo-installation.js` 和 `dist/photo-accelerator.js`，因此“有照片代码”不等于“具备照片增强能力”。

调用关系：

1. `services/pc-agent/src/photo-installation.ts` 默认读取 `dist/photo/runtime.json`，也支持显式 `HARMONY_PHOTO_RUNTIME`。
2. `services/pc-agent/src/executors/registry.ts` 只有在 `HARMONY_PHOTO_MODEL` 和 `HARMONY_PHOTO_RUNNER` 都存在时才注册 `photo.enhance.v1`。
3. 分析、分块准备、合成、交付阶段仍可注册；所以节点可以在线，也可以做部分轻量阶段，却不能执行最吃算力的增强阶段。

来源：`scripts/prepare-harmony-distribution.cjs` 第 128 行仅在设置 `HARMONY_PHOTO_RUNTIME` 时复制照片运行库，漏配时仍能成功产生设备 ZIP。该条件允许生成“可以配对，但不支持照片增强”的包，且当前说明没有充分区分其能力。

### P2：默认邀请没有显存额度，GPU 初始化被跳过

`apps/runtime-desktop/desktop.js` 默认生成的配对邀请包含 CPU、内存、系统内存保留及 `capacityMode: 'auto'`，**没有 `maxVramBytes`**。用户 ZIP 中的同名文件也如此。

`services/pc-agent/src/host-main.ts` 第 29 行的照片 GPU 初始化条件为：

```ts
process.env.HARMONY_PHOTO_VULKAN &&
!config.imageEncoder &&
(config.contribution.maxVramBytes ?? 0) > 0
```

因此：即使补齐 GPU 引擎，普通邀请中缺失显存额度仍使初始化条件不成立。

`services/coordinator/src/spaces.ts` 的 `MeasuredCapacity` / `autoContribution` 目前只处理 CPU 和系统内存，不会探测或自动增加 GPU / 显存资源池。`capacityMode: 'auto'` 不能解释为“已自动启用显卡”。

还需处理旧配对：现有设备额度更新对 CPU、RAM、VRAM 上限变化会返回 `CAPACITY_REPAIR_REQUIRED`。不能仅手工修改执行器的 `contribution.json` 就认为中心配额同步成功；后续修复需通过中心已有的配额/身份协议实现迁移或重新配对，保留单设备单空间和未结算任务处理。

### P3：正式打包脚本遗漏 Vulkan EXE 的 OpenMP DLL

即使设置 `HARMONY_PHOTO_RUNTIME`，正式打包脚本目前也只按 `model`、`runner`、`vulkan` 三个键复制目录/文件，不会复制 Vulkan EXE 同目录的 DLL。

本机已下载的 `realesrgan-ncnn-vulkan.exe` 的 PE 导入表包含：

```text
vulkan-1.dll
ole32.dll
KERNEL32.dll
OLEAUT32.dll
VCOMP140.DLL
```

本机原始运行库目录存在 `vcomp140.dll`，但正式打包逻辑没有携带它。新电脑如果没有全局可用的此依赖，即使模型和 EXE 已补齐也可能无法启动 GPU 引擎。`vulkan-1.dll` 通常由显卡驱动提供，应检查目标机驱动；不能把本机驱动 DLL 随意复制过去代替驱动安装。

这属于**已确认的打包遗漏、待远端验证的实际启动影响**；原始用户 ZIP 连 GPU EXE 都没有，不能把 DLL 缺失认定为这次唯一故障。

历史 `scripts/build-windows-agent.cjs` 曾处理 `vcomp140.dll`，但它已是废弃入口。修复应落在现用的 `prepare-harmony-distribution.cjs`，不能退回旧启动壳。

### P4：配置与诊断提示易造成误解

- `apps/runtime-desktop/agent.html` 的 CPU / CUDA 下拉项对应图像编码套件，要求 Python / 可信套件配置。它并不是照片 Real-ESRGAN GPU 的开关。
- 当前照片 GPU 路径为 `ncnn.photo.vulkan.v1` / `VULKAN`。NVIDIA 显卡可以使用 Vulkan；不能让用户仅因照片任务就安装一套无关的 CUDA / PyTorch 编码环境。
- 没有 Vulkan 路径或显存额度时，初始化直接跳过；进入探测后失败，也只输出统一的 `PHOTO_GPU_UNAVAILABLE`，未区分驱动、DLL、型号匹配和参考评测失败。
- “节点在线”“有独显”“有 GPU 资源池”“照片能力评测合格”“业务任务实际交给 GPU”是不同状态，界面和交付说明需分别呈现。

## 4. 本机保存记录：支持判断，但不代替远端复测

只读检查了本机已安装协调中心的 `desktop-172.20.10.6/coordinator.sqlite`，未复制数据库到仓库，也未输出设备凭证。

最新登记的一台 Windows 节点：

- holder：`92a672b5-31da-4821-b166-b20b21427fca`。
- 历史执行记录使用的 deviceId：`34344fb5-768a-4deb-9171-ad9b43e1f2c8`。
- 保存额度为自动模式、12 CPU 槽位、32,950,452,224 字节共享内存、1 GiB 系统保留；没有 `maxVramBytes`。
- 该 holder 共 9 个成功尝试：`photo.analyze.v1` 2 次、`photo.prepare.v1` 7 次；没有 `photo.enhance.v1` 尝试。
- 整份被检查数据库有 603 个成功 CPU 尝试、1 个拒绝 CPU 尝试，未发现 CUDA / VULKAN 尝试回执。此统计含历史轮次，不是用户本次批次的独立耗时报告。

设备名是自动生成的时间标签，当前无法再次连接远端确认硬件。因此，这台新节点与用户所说独显电脑的对应关系仍需核对；不能据此断言其确切型号或显存。

这些记录能说明“在线并执行过轻量阶段”没有转化成“参与核心增强”，但不能精确解释用户这轮总耗时。现阶段不应优先以 Wi-Fi 慢为结论，也不能承诺补包后必然达到某个加速倍数。

## 5. 后续待验证风险

1. **双显卡编号**：`photo-accelerator.ts` 使用 `HARMONY_PHOTO_GPU_ID ?? '0'`，然后要求 Vulkan 诊断日志中该编号的名称匹配 `nvidia-smi`。若集显是 Vulkan 0、NVIDIA 为 1，默认可能失败；目前没有自动切换到匹配 NVIDIA 的逻辑。实际设备顺序、名称与驱动版本待独显电脑上线后验证，不能假设 0 就是独显。
2. **后端互斥**：照片 GPU 初始化要求 `!config.imageEncoder`。如果先启用了另一个图像编码套件，照片 GPU 不会同时初始化；后续应明确支持范围或整合后端管理，不让用户靠错误的 CUDA 下拉框碰运气。
3. **能力与额度完整链**：应从 GPU 探测、真实参考推理、能力评测、GPU/VRAM 资源池和授权，一直核对到业务 offer / receipt。只看到显卡名称不算完成。
4. **真实性能**：驱动/能力恢复后仍需量化冷启动、分块推理、模型加载、网络、中间产物、调度及结果回传。此前无独显双机的性能记录不能当作此独显电脑的基线。

## 6. 建议修复顺序（尚未执行）

1. **完整打包并阻止漏包发布**：照片版节点包必须含已校验模型、优化 CPU runner、Vulkan runner、必要 DLL 和相对路径配置；缺任何必要文件就明确失败。打包清单明确是否支持照片 CPU / GPU，不再静默发布不完整的照片演示包。
2. **贯通 GPU 贡献配置**：让中心与设备双方明确确认显存贡献，并同步资源池和额度；解决普通邀请与已配对设备的迁移。尊重用户已有的“不共享 GPU”设置，不以改本地文件绕过中心配额。
3. **探测与可见诊断**：在双显卡机器选择真正匹配的 NVIDIA Vulkan 设备；分别报告缺运行库、缺驱动、显存额度为 0、初始化失败、参考评测失败及业务就绪。CPU 回退须明确显示，不能冒充 GPU 执行。
4. **验证正式交付包**：从最终 ZIP 解压到干净目录，在不设置开发机环境变量、没有预装 Node / Python / 模型路径的条件下启动；验证 CPU 增强。随后在 NVIDIA 真机验证 Vulkan 推理、参考质量与实际 GPU 使用率，并记录驱动/型号。测试不能只针对源码目录。
5. **再做性能对照**：同一组六张手机照片、同模型、同输入哈希、同预算，比较手机本机、手机+普通 Windows、手机+独显 Windows 的完整端到端耗时。展示实际设备/后端/阶段回执，记录分阶段追踪与 GPU 使用情况。

模型和引擎可预装；用户照片、分片及成品不能在任务前预放到独显电脑。不修改 SDK → 工作流 → 调度器的统一派发链，不清空历史来掩盖失败或慢任务。

## 7. 本轮交付与后续约束

- 仅新增此报告，并在文档入口及合并保护文档添加链接；未修改业务代码、配额、签名、安装程序或打包产物。
- 本轮静态/只读核查已完成；没有声称代码修复、GPU 真机通过或协同提速。
- 后续修复继续遵守 [修改记录与合并保护清单](MERGE-PROTECTION.md)，维护独立图片 App、真实单机、仅展示连接、原生统一界面及单设备单空间等既有功能。
- 旧双机耗时见 [性能记录](PHOTO-OPTIMIZATION-20261111.md)，不要将其中的本机 CPU 优化结果误写为 NVIDIA GPU 验收。

# X8 DevEco 模拟器能力实验

状态：**完成-替身**。日期：2026-11-01；不替代真机 X1/X2。

## 环境与连接

- 使用已有的 Pura 90 模拟器，冷启动；没有重置整个模拟器或操作真实手机。
- hdc 目标：`127.0.0.1:5555`；客体实查 `const.ohos.fullname` 为 `OpenHarmony-6.1.1.125`。
- DevEco 6.1.1.290 / SDK API 24。镜像元数据为 6.1.0.125，与实际客体查询分别记录。
- 网络实测采用 hdc 支持的 **rport**：模拟器 `127.0.0.1:<port>` 转发到宿主协调者相同端口。证书 SAN 与连接地址均为 127.0.0.1；保留 HTTPS/WSS 校验。
- 没有把回环转发称为多设备 Wi-Fi/LAN 时延测试；真机局域网连通与性能仍待后续设备验证。

## 已执行检查

| 项 | 结果与证据 |
| --- | --- |
| 独立 HAP 安装、启动、日志 | 原生 agent 与 HAR probe 安装成功；`aa start` 启动；日志 tag `HarmonyAgent` / `HarmonyProbe` |
| HTTPS/WSS 与正式调度 | `.test/agent-conformance-ateXRq/report.json`：共同 8 项协议断言及裁剪、生命周期两项全部通过，10/10 |
| 文本与 ImageKit | 文本结果正确；裁剪左右区域经独立颜色/尺寸评测；非法 box 返回已结算 FAILED，未发布输出 |
| TLS 正反例 | `.test/s2-native-trust-nKFcil/report.json`：错误指纹 0 次 HTTP、错误服务端证书 0 次 HTTP；正确证书/指纹到达 identity 与测试配对接口，3/3 |
| 额度验证 | 上述共同测试中，篡改签名的额度未获持久化 ACK；之后有效续期恢复；先缩后放保持物理预算 |
| 共享 fixture 原生执行 | HAR probe 执行 `tests/agent-conformance/fixtures/ledger-v2.json` 的 27 组判定；不把转译测试当成原生运行 |
| relationalStore 跨进程 | 探针强制停止再启动：启动计数 3→4；测试账本/outbox 从 SEEDED→RECOVERED；已接受但未执行的 attempt 恢复为 CANCELLED_SETTLED，outbox 保留 |
| 实际前后台切换 | 测试打开探针 HAP，使代理进入后台；画像为 BACKGROUND / ACTIVE、停止新准入。返回代理后恢复合格贡献。此结果只覆盖当前模拟器场景 |

探针运行摘要见 `.test/s2-probe-runtime.log`；后续一次运行计数为 5、仍为 RECOVERED。原生代理使用关系型数据库保存 identity、偏好、账本及 outbox；账本与待发消息作为同一快照原子写入。

## 复现

```powershell
npm run conformance:build
npm run harmony:v2:har
npm run harmony:v2:agent
npm run harmony:v2:probe
npm run conformance:test -- --agent harmony-emulator --include-crop
node tests/agent-conformance/trust.cjs
```

HAP 与日志在 `.test/`。默认安装路径、覆盖变量、测试 App 的数据重置范围见 `tests/agent-conformance/README.md`。

手动安装与持久化探针：

```powershell
$hdc = 'D:/Users/17321/AppData/DevEco Studio/sdk/default/openharmony/toolchains/hdc.exe'
& $hdc -t 127.0.0.1:5555 install .test/s2-harmony-har-probe/entry/build/default/outputs/default/entry-default-unsigned.hap
& $hdc -t 127.0.0.1:5555 shell aa start -a EntryAbility -b org.harmonycc.harprobe
& $hdc -t 127.0.0.1:5555 shell aa force-stop org.harmonycc.harprobe
& $hdc -t 127.0.0.1:5555 shell aa start -a EntryAbility -b org.harmonycc.harprobe
& $hdc -t 127.0.0.1:5555 shell hilog -x -T HarmonyProbe
```

## 实现中确认的平台差异

- WebSocket 的 connect Promise 返回并不等于可以发送，须等待 open 事件。
- 协调者身份使用 RSA-3072；CryptoFramework 验证器和公钥转换需匹配此规格。
- 创建裁剪画布时需显式给出 `srcPixelFormat=RGBA_8888` 及目标格式，否则实测出现红蓝通道互换，参考质量评测会拒绝。
- 对端 Date 只用于画像时间锚定；微观队列和租约使用单调时钟，避免 HTTP 秒级时间校正导致队列时间倒退。

未执行：真实手机、GPU、Wi-Fi 多物理终端、长时间后台保活、扫码、API 22 构建、真机开发者签名。不关闭 TLS 验证、不提升后台权限，也不以 PC 程序冒充鸿蒙代理。

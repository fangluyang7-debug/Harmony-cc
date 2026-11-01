# 独立 HAR 原生探针

bundle 为 `org.harmonycc.harprobe`，通过构建后的 scheduler HAR 引用导出，不复制协议或账本实现。与 TS / ArkTS 转译测试共用 `tests/agent-conformance/fixtures/ledger-v2.json` 的 27 组判定。

```powershell
npm run harmony:v2:har
npm run harmony:v2:probe
```

用 hdc 安装 `.test/s2-harmony-har-probe/entry/build/default/outputs/default/entry-default-unsigned.hap`，启动 `EntryAbility`。日志 tag 为 `HarmonyProbe`。首次建立测试账本与 outbox，强制停止再启动后，已准入但未执行的 fixture 必须恢复为 `CANCELLED_SETTLED`，同时保留 outbox。界面显示原生 fixture 数、持久化启动计数及 `SEEDED` / `RECOVERED`。这是隔离的测试数据，不会配对、贡献资源或执行线上任务。

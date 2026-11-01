# 调度 v2 App 注册与 SDK

本包提供 TypeScript SDK；同一提交代码由 HAR `v2/client/SchedulerSdk.ets` 原生编译，语义一致性测试检查两份源码相同。Native HTTPS 适配器为 HAR `HarmonySdkPort`，不依赖 agent。任务由局域网协调者现有的 PlanningService、preflight、持久化 outbox 和代理执行链路派发。

## 用户确认注册

在所有者设备上执行下列命令，即确认策略文件里的权限和额度。`owner-agent.json` 使用已经配对的设备配置；App 配置使用独立凭据，不能拿设备凭据直接提交任务。

```powershell
npm --workspace @harmony/pc-agent run build
npm --workspace @harmony/pc-agent run app:register -- owner-agent.json app-policy.json C:/HarmonyRuntime/my-app.json
npm --workspace @harmony/pc-agent run submit -- C:/HarmonyRuntime/my-app.json text.count.v1 input.json output.json
```

策略示例：

```json
{
  "label": "我的文本 App",
  "allowedContracts": ["text.count.v1"],
  "maxConcurrent": 2,
  "resources": [
    {"resourcePoolId": "cpu", "amount": 2},
    {"resourcePoolId": "ram", "amount": 134217728}
  ],
  "offlineBase": [],
  "onlineExtra": []
}
```

同一所有者、同一名称对应同一个逻辑 App；另一次安装得到独立 `appInstanceId`、holder 和凭据，在线任务共用 App 配额。也可显式传入自己已有的 `appId`。策略变化返回 `APP_POLICY_CONFLICT`，当前没有管理端修改策略界面。名称是用户确认的标签，不是发行者签名证明。

有本地额度的注册必须先存在用户确认的物理设备预算。`offlineBase` 在邀请发出时就预留，两个 App 不能重复拿走同一份容量；过期、撤销不自动归还离线保留量。登记不等于已经启用离线执行：SDK 宿主、本地执行及离线对账仍须继续完成。

接口：设备 bearer 调用 `POST /v2/apps/registrations`；App 用一次性 `registrationId/code` 调用 `POST /v2/apps/exchange`；App bearer 查询 `GET /v2/apps/me`。所有者可查询 `GET /v2/apps/registrations` 并调用 `POST /v2/apps/registrations/:appInstanceId/revoke`。邀请含固定证书信任信息，凭据不通过任务元数据传递。

## 提交

```ts
import { SchedulerSdk } from '@harmony/scheduler-client';
import { nodeSdkPort } from '@harmony/scheduler-client/dist/node';
import { randomUUID } from 'node:crypto';

const sdk = new SchedulerSdk(nodeSdkPort(appConfig.connection));
const input = await sdk.registerInput(Buffer.from('{"text":"Hello Harmony"}'), 'text.input');
const id = randomUUID();
const task = await sdk.submit({
  version: 3, id, outputContract: 'text.counts', qualityTarget: 'reference',
  nodes: [{id:'compute', capability:'text.count.v1', input, parameters:'{}', dependsOn:[]}]
}, {requestId:id, budgetMs:30000, resultDestination:'ORIGIN'});
const result = await task.result();
// 或 task.onResult(result => ..., error => ...)
sdk.releaseInput(input);
```

ArkTS 使用 `import {SchedulerSdk, HarmonySdkPort} from 'scheduler'`，先 `await HarmonySdkPort.open(context, invitation)`，再 `port.exchange(invitation.registrationId, invitation.code)`。后续 `registerInput/submit/result` 与上面一致。普通 App 应把交换后的凭据保存到自己的私有持久化存储；独立 HAR 探针只用于本次测试，不保存可复用的 App 登录态。

- `plan` 只发送元数据，返回输入上传票据；`submit` 再上传和 start。结果带哈希校验，可以通过 `resume(jobId)` 恢复查询。等待超时不重新提交、不取消执行、不释放资源。
- 等价方案为 `{version:3,id,outputContract,qualityTarget,alternatives:[workflowA,workflowB]}`。本批支持同一能力、同一输入的单节点方案，可通过不同 `targetId` 约束比较；PlanningService 决定路径。输出契约或质量目标不一致直接拒绝。
- 任务和接口均不接收调用方自报 `appId/principalId`。服务端从凭据取身份；旧 `/v2/jobs` 为同一服务实现的兼容入口，也要求注册 App。
- 已知的无容量拒绝最多等待 15 秒；请求超时等投递不明的错误直接返回，不盲目重放。可选 `SdkPort.cancelled()` 用于关闭提交窗口，停止等待；已经登记但尚未派发的任务会取消。
- **当前范围**：执行数据经协调者中继，结果返回来源；只支持单节点，跨能力等价路径和多节点返回明确的 S5 范围错误。SDK 宿主的来源本地执行、断网退回基础额度、固定服务节点及其他结果目的地尚未接入。`cancel()` 当前仅支持派发前取消；已派发且未结算返回 `CANCEL_REQUIRES_HOST`，继续保留配额，不伪造已停止状态。

## 验证

```powershell
npm run sdk:test
npm run coordinator:test
npm run harmony:v2:har
npm run harmony:v2:probe
npm run sdk:native:test
```

原生测试只接受回环模拟器目标，安装/更新独立 `org.harmonycc.harprobe` 并停止它，保留 S2 探针数据；不重置整个模拟器，不使用真机。新建独立协调者、PC 代理和 App 注册，测试文本与向量两条 SDK 提交，并核对实际业务回执和原生日志。证据写入忽略目录 `.test/phase-b-*/sdk-report.json`；HDC 转发不能用于真机局域网性能结论。

进度与剩余工作见项目唯一状态文件 `docs/scheduler-v2/STATUS.md`。

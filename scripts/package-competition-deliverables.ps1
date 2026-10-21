param(
  [string]$OutputDirectory = '',
  [string]$Stamp = '20260930'
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $root "提交文件\competition-deliverables\$Stamp-harmony-architecture-packages"
}

if (Test-Path -LiteralPath $OutputDirectory) {
  throw "Output directory already exists: $OutputDirectory"
}

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null

function Join-Root([string]$RelativePath) {
  return Join-Path $root $RelativePath
}

function Copy-Tree([string]$SourceRelativePath, [string]$DestinationRelativePath, [string[]]$Exclude = @()) {
  $source = Join-Root $SourceRelativePath
  if (-not (Test-Path -LiteralPath $source)) {
    throw "Missing source directory: $source"
  }
  $destination = Join-Path $OutputDirectory $DestinationRelativePath
  New-Item -ItemType Directory -Path $destination -Force | Out-Null
  $sourceFull = (Resolve-Path $source).Path.TrimEnd('\')
  Get-ChildItem -LiteralPath $sourceFull -Recurse -File | ForEach-Object {
    $relative = $_.FullName.Substring($sourceFull.Length).TrimStart('\')
    $skip = $false
    foreach ($pattern in $Exclude) {
      if ($relative -match $pattern) {
        $skip = $true
        break
      }
    }
    if ($skip) {
      return
    }
    $target = Join-Path $destination $relative
    $parent = Split-Path -Parent $target
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $target -Force
  }
}

function Copy-File([string]$SourceRelativePath, [string]$DestinationRelativePath) {
  $source = Join-Root $SourceRelativePath
  if (-not (Test-Path -LiteralPath $source)) {
    throw "Missing source file: $source"
  }
  $target = Join-Path $OutputDirectory $DestinationRelativePath
  New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
  Copy-Item -LiteralPath $source -Destination $target -Force
}

function Write-PackageText([string]$PackageRelativePath, [string]$RelativePath, [string]$Content) {
  $target = Join-Path $OutputDirectory "$PackageRelativePath\$RelativePath"
  New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
  Set-Content -LiteralPath $target -Value $Content -Encoding UTF8
}

function Add-Zip([string]$PackageName) {
  $source = Join-Path $OutputDirectory $PackageName
  $archive = Join-Path $OutputDirectory "$PackageName.zip"
  Compress-Archive -Path (Join-Path $source '*') -DestinationPath $archive -CompressionLevel Optimal
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash
  Add-Content -LiteralPath (Join-Path $OutputDirectory 'SHA256SUMS.txt') -Value "$hash  $PackageName.zip" -Encoding UTF8
}

$harmonySourceExcludes = @(
  '(^|\\)build(\\|$)',
  '(^|\\)\.test(\\|$)',
  '(^|\\)\.hvigor(\\|$)',
  '(^|\\)\.idea(\\|$)',
  '(^|\\)oh_modules(\\|$)',
  '(^|\\)node_modules(\\|$)',
  '(^|\\)monitor(\\|$)',
  '(^|\\)build-profile\.json5$'
)

$entrySourceExcludes = @(
  '(^|\\)build(\\|$)',
  '(^|\\)\.test(\\|$)',
  '(^|\\)\.hvigor(\\|$)',
  '(^|\\)\.idea(\\|$)',
  '(^|\\)oh_modules(\\|$)',
  '(^|\\)node_modules(\\|$)'
)

$schedulerSourceExcludes = @(
  '(^|\\)build(\\|$)',
  '(^|\\)\.test(\\|$)',
  '(^|\\)\.hvigor(\\|$)',
  '(^|\\)\.idea(\\|$)',
  '(^|\\)oh_modules(\\|$)',
  '(^|\\)node_modules(\\|$)'
)

$serverExcludes = @(
  '(^|\\)node_modules(\\|$)',
  '(^|\\)dist(\\|$)',
  '(^|\\)\.env$',
  '(^|\\)\.env\.(?!example$|zeabur\.example$)',
  '\.db$',
  '(^|\\)build(\\|$)',
  '(^|\\)\.test(\\|$)',
  '(^|\\)\.idea(\\|$)'
)

$webExcludes = @(
  '(^|\\)node_modules(\\|$)',
  '(^|\\)dist(\\|$)',
  '(^|\\)build(\\|$)',
  '(^|\\)\.vite(\\|$)',
  '(^|\\)\.idea(\\|$)'
)

$monitorPackage = '04-desktop-scheduler-monitor'
$demoPackage = '01-soleai-integrated-demo'
$appPackage = '02-soleai-application-source'
$schedulerPackage = '03-micro-scheduler-har'
$cloudPackage = '05-cloud-macro-coordinator'

Copy-Tree 'apps\harmony' "$demoPackage\source\apps\harmony" $harmonySourceExcludes
Copy-Tree 'apps\harmony\monitor' "$demoPackage\desktop-monitor" @('(^|\\)node_modules(\\|$)')
Copy-Tree 'contracts' "$demoPackage\source\contracts" @('(^|\\)node_modules(\\|$)')
Copy-File 'apps\harmony\entry\build-profile.json5' "$demoPackage\source\apps\harmony\entry\build-profile.json5"
Copy-File 'apps\harmony\entry\build\default\outputs\default\entry-default-unsigned.hap' "$demoPackage\artifacts\entry-default-unsigned.hap"
Copy-File 'apps\harmony\entry\build\default\outputs\default\entry-default-signed.hap' "$demoPackage\artifacts\entry-default-signed.hap"
Copy-File 'apps\harmony\scheduler\build\default\outputs\default\scheduler.har' "$demoPackage\artifacts\scheduler.har"
Copy-File 'apps\harmony\README.md' "$demoPackage\README-运行说明.md"
Copy-File 'apps\harmony\DEV_RUN_GUIDE.md' "$demoPackage\DEV_RUN_GUIDE.md"
Write-PackageText $demoPackage 'source\apps\harmony\build-profile.json5' @'
{
  "app": {
    "signingConfigs": [],
    "products": [
      {
        "name": "default",
        "targetSdkVersion": "6.0.2(22)",
        "compatibleSdkVersion": "6.0.2(22)",
        "runtimeOS": "HarmonyOS",
        "buildOption": {
          "strictMode": {
            "caseSensitiveCheck": true,
            "useNormalizedOHMUrl": true
          }
        }
      }
    ],
    "buildModeSet": [
      { "name": "debug" },
      { "name": "release" }
    ]
  },
  "modules": [
    {
      "name": "entry",
      "srcPath": "./entry",
      "targets": [
        {
          "name": "default",
          "applyToProducts": ["default"]
        }
      ]
    },
    {
      "name": "scheduler",
      "srcPath": "./scheduler"
    }
  ]
}
'@
Write-PackageText $demoPackage 'PACKAGE-STATUS.md' @'
# 当前 SoleAI 集成演示包

这是当前可运行的鸿蒙演示系统交付包。它包含 SoleAI `entry`、本地 `scheduler` HAR、手机调度状态展示、云端购物调用、电脑端调度监控和已经重新构建的 HAP/HAR。

## 真实架构状态

- SoleAI `entry` 在运行时嵌入并初始化 `scheduler`。
- `scheduler` 在工程上是独立 HAR，但当前不是单独安装的后台节点应用。
- Zeabur 地址由应用云 API 客户端使用；它不是独立的“微观调度器注册连接”。
- `apps/harmony/monitor` 是电脑端只读遥测监控，不是云端宏观调度器。

## 适合作为比赛演示系统吗

可以。比赛要求的是可演示的 HAP、源代码、用户体验和操作系统智能演示。这个包能够展示端侧资源感知调度、SoleAI 业务流程、云端任务闭环和电脑监控。

提交时应把它描述为“当前集成演示系统”，不要把它描述为已经完成完全设备解耦的最终产品。

## 运行

1. 优先用 `artifacts/entry-default-unsigned.hap` 在提交方 DevEco Studio 中重新签名。
2. `entry-default-signed.hap` 是本机调试签名版本，是否能安装取决于证书和设备范围。
3. 需要云端能力时，在应用内配置公开 HTTPS API Origin；不要把 API Key 或证书写入应用包。
4. 电脑调度盘在 `desktop-monitor`，启动方式见 `电脑调度盘打开步骤.md`。
'@
Write-PackageText $demoPackage '包定位说明.md' @'
# 包定位说明

`01-soleai-integrated-demo` 是比赛演示主包，面向“应用赛题须提交实际可演示 HAP 文件”的要求。

## 包内包含

- `artifacts/entry-default-unsigned.hap`：建议提交方重新签名后安装的 HAP。
- `artifacts/entry-default-signed.hap`：本机调试签名 HAP，安装范围受调试证书限制。
- `artifacts/scheduler.har`：当前演示使用的微观调度器 HAR 产物。
- `source/apps/harmony`：SoleAI `entry` 与 `scheduler` 的集成工程源码。
- `desktop-monitor`：电脑调度盘，仅用于遥测展示。

## 使用方式

App 已内置默认演示云端 API：`https://cixin.zeabur.app`。首次安装后通常不需要手动输入 Zeabur 地址；如果云端域名变更，仍可在 App 内改成新的 HTTPS API Origin。

## 准确表述

这是“当前可运行集成演示系统”。SoleAI 在运行时仍内嵌初始化微观调度器，不应描述为已经完全分离部署的独立设备节点系统。
'@

Copy-Tree 'apps\harmony\entry' "$appPackage\source\entry" $entrySourceExcludes
Copy-Tree 'apps\harmony\AppScope' "$appPackage\source\AppScope" @('(^|\\)node_modules(\\|$)')
Copy-File 'apps\harmony\entry\oh-package.json5' "$appPackage\source\entry\oh-package.json5"
Copy-File 'apps\harmony\entry\oh-package-lock.json5' "$appPackage\source\entry\oh-package-lock.json5"
Copy-File 'apps\harmony\entry\build-profile.json5' "$appPackage\source\entry\build-profile.json5"
Write-PackageText $appPackage 'README-源码边界.md' @'
# SoleAI 应用源码包

本包只保存鸿蒙 `entry` 应用和应用资源，作为 SoleAI 业务演示应用的源码快照。

## 重要边界

当前 `entry` 仍通过 `file:../scheduler` 引用微观调度器 HAR，并且多个业务服务会导入 `scheduler` 类型。因此这是“应用源码分包”，不是已经完全脱离调度器后可单独编译的纯应用。

完整构建需要把本包中的 `source/entry` 与 `03-micro-scheduler-har` 的 `source/scheduler` 放回同一个 HarmonyOS workspace。当前可直接运行的完整演示请使用 `01-soleai-integrated-demo`。

## 应用职责

- SoleAI ArkUI 页面、商品检索和结果展示。
- 本地样例数据、Embedding 资源、会话和反馈界面。
- 通过调度器客户端提交任务，并调用云端 API。
- 不包含云端 API 服务端和电脑端监控服务。
'@
Write-PackageText $appPackage '包定位说明.md' @'
# 包定位说明

`02-soleai-application-source` 是 SoleAI 应用侧源码边界包，用于说明演示 App 本身的 UI、业务流程和任务提交方式。

## 包内包含

- `source/entry`：HarmonyOS `entry` 模块源码。
- `source/AppScope`：应用级资源。
- `docs`：应用与调度 SDK 接入相关说明。

## 当前依赖

当前 SoleAI 仍依赖 `scheduler` HAR，不能单独脱离 `03-micro-scheduler-har` 编译。它适合证明“应用层和调度层已有工程边界”，但不是最终完全剥离后的纯业务 App 包。

## 云端地址

当前源码默认演示 API 为 `https://cixin.zeabur.app`，用户可在 App 内覆盖。
'@

Copy-Tree 'apps\harmony\scheduler' "$schedulerPackage\source\scheduler" $schedulerSourceExcludes
Copy-Tree 'contracts\scheduling\v1' "$schedulerPackage\contracts\scheduling\v1" @('(^|\\)node_modules(\\|$)')
Copy-File 'apps\harmony\scheduler\build\default\outputs\default\scheduler.har' "$schedulerPackage\artifacts\scheduler.har"
Copy-File 'apps\harmony\scheduler\README.md' "$schedulerPackage\README-调度件说明.md"
Write-PackageText $schedulerPackage 'README-源码边界.md' @'
# 微观调度器 HAR 包

本包是当前 HarmonyOS 本地调度中间件的独立源码和 HAR 产物，适合被多个鸿蒙应用作为模块依赖。

## 已具备能力

- TaskTemplate、SchedulerClient、SchedulerService 和 WorkloadExecutor。
- 设备状态、队列、优先级、超时、取消、反馈和本地策略。
- 本地资源画像、成本评估和执行计划。
- `scheduler.har` 可作为 HarmonyOS HAR 依赖。

## 当前边界

它现在是应用内可复用的 HAR，不是可独立安装、常驻运行并接受宏观调度指令的设备节点应用。真正的设备节点协议、注册、心跳、租约和跨设备执行仍属于后续解耦工作，不能在比赛材料中把 HAR 单独描述成已经完成的跨设备 Agent。
'@
Write-PackageText $schedulerPackage '包定位说明.md' @'
# 包定位说明

`03-micro-scheduler-har` 是微观调度器源码和 HAR 产物包，对应“Agent 赛题/调度件源码”的本地调度部分。

## 包内包含

- `source/scheduler`：HarmonyOS HAR 模块源码。
- `artifacts/scheduler.har`：可被 HarmonyOS 应用依赖的 HAR 产物。
- `contracts/scheduling/v1`：调度协议说明与 fixtures。
- `docs`：调度 SDK、策略闭环和算法导读。

## 当前定位

这是可复用的应用内微观调度件，负责本地任务队列、设备状态、策略评估、执行器注册、超时、取消、反馈和指标。

## 当前边界

它还不是一个可单独下载安装、常驻后台运行、自动向宏观调度器注册的“设备节点 App”。如果后续要实现多设备可插拔，应在此基础上增加节点注册、心跳、租约、远程执行和结果回传协议。
'@

Copy-Tree 'services\api-server' "$cloudPackage\source\services\api-server" $serverExcludes
Copy-Tree 'services\device-worker' "$cloudPackage\source\services\device-worker" @('(^|\\)node_modules(\\|$)')
Copy-Tree 'services\image-worker' "$cloudPackage\source\services\image-worker" @('(^|\\)__pycache__(\\|$)')
Copy-Tree 'apps\test-entry-web' "$cloudPackage\source\apps\test-entry-web" $webExcludes
Copy-Tree 'contracts' "$cloudPackage\source\contracts" @('(^|\\)node_modules(\\|$)')
Copy-Tree 'scripts' "$cloudPackage\source\scripts" @('(^|\\)node_modules(\\|$)', '(^|\\)upload-harmony-products(\.test)?\.mjs$')
Copy-File 'package.json' "$cloudPackage\source\package.json"
Copy-File 'package-lock.json' "$cloudPackage\source\package-lock.json"
Copy-File '.env.zeabur.example' "$cloudPackage\source\.env.zeabur.example"
Copy-File 'zbpack.json' "$cloudPackage\source\zbpack.json"
Write-PackageText $cloudPackage 'README-云端运行说明.md' @'
# 云端运行说明

本包用于部署 harmony-agent 的云端 API Runtime 和宏观调度器。推荐先复制 `source/.env.zeabur.example` 为部署平台环境变量模板，再按实际模型、存储、数据库和 Worker 凭据填写。

常用命令：

```powershell
npm ci
npm run api:build
npm run api:zeabur:start
```

真实 API Key、数据库文件、对象存储密钥、Worker token、证书和签名材料均不应进入提交包。
'@
Write-PackageText $cloudPackage 'README-源码边界.md' @'
# 云端宏观调度器源码包

本包是部署到 Zeabur 或其他 Node.js 环境的云端 Runtime 和宏观调度代码。

## 核心入口

- `services/api-server/src/core/runtime/scheduler.service.ts`：服务端资源感知放置和宏观调度。
- `services/api-server/src/core/runtime/runtime-runner.service.ts`：工作流运行和阶段执行。
- `services/api-server/src/core/runtime/device-dispatch.service.ts`：面向已配置设备 Worker 的派发适配。
- `services/device-worker`：可独立启动的 CPU Worker 示例。
- `apps/test-entry-web`：可选 Web 联调入口和 Runtime 观察页面。

## 当前真实边界

当前宏观调度器主要调度云端 Runtime、云执行器和已配置的 Worker；HarmonyOS 手机 HAR 尚未作为通用常驻设备节点通过注册/心跳协议接入。双手机演示路径仍是专用的 phone-dispatch 业务路径。

## 部署安全

只提交 `.env.example` 和 `.env.zeabur.example`。真实 API Key、数据库文件、COS 密钥、Worker token、证书和签名文件不在本包中。
'@
Write-PackageText $cloudPackage '包定位说明.md' @'
# 包定位说明

`05-cloud-macro-coordinator` 是云端宏观调度器和 Runtime 源码包，对应 Zeabur 云端服务。

## 包内包含

- `source/services/api-server`：NestJS API、购物 Runtime、宏观调度、会话和资产服务。
- `source/services/device-worker`：可独立启动的 CPU Worker 示例。
- `source/contracts`：调度和购物协议。
- `source/apps/test-entry-web`：可选 Web 联调入口。

## 当前定位

云端宏观调度器负责接收 App 任务、维护 Runtime、执行服务端放置决策、调度云端阶段和已配置的 Worker。

## 当前边界

HarmonyOS 手机端微观调度器尚未作为通用常驻节点，通过注册/心跳/租约协议接入该宏观调度器。当前 App 与云端主要通过公开 API 交互，默认演示地址为 `https://cixin.zeabur.app`。
'@

Copy-Tree 'apps\harmony\monitor' "$monitorPackage\monitor" @('(^|\\)node_modules(\\|$)')
Write-PackageText $monitorPackage 'README.md' @'
# 电脑端调度监控包

这是电脑上的只读调度监控服务，默认监听 8765 端口，接收手机上传的调度状态和遥测数据。

它不是宏观调度器，不负责选择设备、创建租约或派发任务。宏观调度代码位于 `05-cloud-macro-coordinator`。

打开和连接步骤见 `电脑调度盘打开步骤.md`。
'@
Write-PackageText $monitorPackage '包定位说明.md' @'
# 包定位说明

`04-desktop-scheduler-monitor` 是电脑端调度盘/监控包，用于演示时展示手机调度状态和遥测数据。

## 包内包含

- `monitor/server.mjs`：本地 Node 监控服务，默认用于 8765 端口。
- `monitor/public`：网页调度盘。
- `电脑调度盘打开步骤.md`：手机连接电脑调度盘的操作说明。

## 当前定位

这是演示辅助工具，适合比赛现场或录屏时展示调度状态。

## 当前边界

它不是宏观调度器，不负责跨设备任务选择、租约、派发或执行控制。
'@
Write-PackageText $monitorPackage '电脑调度盘打开步骤.md' @'
# 电脑调度盘打开步骤

本包用于在电脑浏览器里观察手机端 SoleAI 的调度状态。它只接收和展示遥测，不负责宏观调度、设备选择或任务派发。

## 1. 在电脑上启动调度盘

1. 解压 `04-desktop-scheduler-monitor.zip`。
2. 确认电脑已安装 Node.js。该监控服务无额外 npm 依赖，通常不需要执行 `npm install`。
3. 用 PowerShell 进入解压后的 `monitor` 目录。
4. 运行：

```powershell
node server.mjs
```

5. 终端会输出类似内容：

```text
Harmony Scheduler Monitor: http://localhost:8765
Pairing code: 123456
```

6. 在电脑浏览器打开 `http://localhost:8765`，按页面提示输入同一个 Pairing code。

## 2. 手机 SoleAI 连接电脑

1. 让手机和电脑连接同一个可信 Wi-Fi。
2. 在电脑 PowerShell 运行 `ipconfig`，找到当前 Wi-Fi 或以太网网卡的 IPv4 地址，例如 `192.168.1.20`。
3. 在手机 SoleAI 进入“我的 / 电脑实时监控”。
4. 接收地址填写：

```text
http://电脑IPv4:8765
```

例如：

```text
http://192.168.1.20:8765
```

5. 配对码填写电脑终端输出的 Pairing code。
6. 打开“向电脑推送实时遥测”开关并保存。
7. 在 SoleAI 中执行文字搜索或图片搜索，电脑调度盘应显示手机状态、任务事件、队列和运行信息。

## 3. 为什么是 8765

`8765` 是电脑调度盘本地服务的默认端口，来自 `monitor/server.mjs`：

```javascript
const PORT = Number(process.env.HARMONY_MONITOR_PORT ?? 8765);
```

它不是 Zeabur 云端 API 端口，也不是宏观调度器端口。它只用于“手机 -> 电脑调度盘”的局域网遥测上报。

如需更换端口，可在启动前设置环境变量：

```powershell
$env:HARMONY_MONITOR_PORT=8877
node server.mjs
```

此时电脑浏览器打开 `http://localhost:8877`，手机接收地址填写 `http://电脑IPv4:8877`。

## 4. 连不上时检查

- 手机不能填 `localhost` 或 `127.0.0.1`，除非使用 HDC/USB 端口转发；普通 Wi-Fi 演示应填写电脑 IPv4。
- 手机和电脑必须在同一个局域网内。
- Windows 防火墙弹窗时，允许 Node.js 在专用网络访问。
- 配对码要与当前终端输出一致；重启服务后配对码会变化。
- 若端口被占用，换一个 `HARMONY_MONITOR_PORT` 后同步修改手机地址。
- 该端口只适合可信局域网演示，不要暴露到公网。
'@
Write-PackageText $demoPackage '电脑调度盘打开步骤.md' @'
# 电脑调度盘打开步骤

本包中的电脑调度盘位于 `desktop-monitor`。它用于在电脑浏览器里观察手机端 SoleAI 的调度状态，只接收和展示遥测，不负责宏观调度、设备选择或任务派发。

## 1. 在电脑上启动调度盘

1. 进入 `desktop-monitor` 目录。
2. 确认电脑已安装 Node.js。该监控服务无额外 npm 依赖，通常不需要执行 `npm install`。
3. 运行：

```powershell
node server.mjs
```

4. 终端会输出本机访问地址和配对码，例如：

```text
Harmony Scheduler Monitor: http://localhost:8765
Pairing code: 123456
```

5. 在电脑浏览器打开 `http://localhost:8765`，输入同一个 Pairing code。

## 2. 手机 SoleAI 连接电脑

1. 手机和电脑连接同一个可信 Wi-Fi。
2. 在电脑 PowerShell 运行 `ipconfig`，找到当前网卡的 IPv4 地址，例如 `192.168.1.20`。
3. 在手机 SoleAI 进入“我的 / 电脑实时监控”。
4. 接收地址填写 `http://电脑IPv4:8765`，例如 `http://192.168.1.20:8765`。
5. 配对码填写电脑终端输出的 Pairing code。
6. 打开“向电脑推送实时遥测”开关并保存。
7. 执行 SoleAI 文字搜索或图片搜索，电脑调度盘应显示手机状态、任务事件、队列和运行信息。

## 3. 为什么是 8765

`8765` 是电脑调度盘本地服务的默认端口，来自 `desktop-monitor/server.mjs`：

```javascript
const PORT = Number(process.env.HARMONY_MONITOR_PORT ?? 8765);
```

它不是 Zeabur 云端 API 端口，也不是宏观调度器端口。它只用于“手机 -> 电脑调度盘”的局域网遥测上报。

如需更换端口，可在启动前设置环境变量：

```powershell
$env:HARMONY_MONITOR_PORT=8877
node server.mjs
```

此时电脑浏览器打开 `http://localhost:8877`，手机接收地址填写 `http://电脑IPv4:8877`。

## 4. 连不上时检查

- 手机不能填 `localhost` 或 `127.0.0.1`，除非使用 HDC/USB 端口转发；普通 Wi-Fi 演示应填写电脑 IPv4。
- 手机和电脑必须在同一个局域网内。
- Windows 防火墙弹窗时，允许 Node.js 在专用网络访问。
- 配对码要与当前终端输出一致；重启服务后配对码会变化。
- 若端口被占用，换一个 `HARMONY_MONITOR_PORT` 后同步修改手机地址。
- 该端口只适合可信局域网演示，不要暴露到公网。
'@

Write-PackageText '' 'README-分包清单.md' @'
# harmony-agent 鸿蒙比赛分包清单

生成日期：2026-09-30

默认演示云端 API：`https://cixin.zeabur.app`

## 推荐提交关系

1. `01-soleai-integrated-demo`：当前可运行的 SoleAI 集成演示系统，作为比赛 Demo 主包。
2. `02-soleai-application-source`：SoleAI 应用源码边界包。
3. `03-micro-scheduler-har`：可复用的 HarmonyOS 微观调度器 HAR 和源码。
4. `05-cloud-macro-coordinator`：云端宏观调度 Runtime、设备 Worker 和可选联调 Web。
5. `04-desktop-scheduler-monitor`：电脑端调度监控，可作为演示辅助附件。

## 评审时的准确表述

当前 Demo 可以展示完整的“应用任务 -> 本地调度 -> Zeabur 云端 Runtime -> 结果返回 -> 电脑遥测监控”链路。当前 `scheduler` 已经在工程上拆为独立 HAR，但 SoleAI 运行时仍内嵌初始化它；云端宏观调度器也尚未把 HarmonyOS 手机接入为通用常驻节点。

因此，这批包适合提交为“当前可运行演示系统 + 分层源码交付”，不应声称完全解耦的跨设备节点系统已经全部完成。

## 安全

所有包都排除了真实 `.env`、API Key、数据库文件、签名私钥、签名口令、依赖缓存和构建缓存。HAP/HAR 是重新构建的产物；签名 HAP 的安装范围仍受本机调试证书限制。
'@

New-Item -ItemType File -Path (Join-Path $OutputDirectory 'SHA256SUMS.txt') -Force | Out-Null
foreach ($package in @($demoPackage, $appPackage, $schedulerPackage, $monitorPackage, $cloudPackage)) {
  Add-Zip $package
}

$allArchive = Join-Path $OutputDirectory 'harmony-agent-competition-packages.zip'
Compress-Archive -Path (Get-ChildItem -LiteralPath $OutputDirectory -Force | Where-Object { $_.Name -ne 'harmony-agent-competition-packages.zip' } | ForEach-Object FullName) -DestinationPath $allArchive -CompressionLevel Optimal
Add-Content -LiteralPath (Join-Path $OutputDirectory 'SHA256SUMS.txt') -Value "$((Get-FileHash -Algorithm SHA256 -LiteralPath $allArchive).Hash)  harmony-agent-competition-packages.zip" -Encoding UTF8

Write-Output "Created competition packages in: $OutputDirectory"
Get-ChildItem -LiteralPath $OutputDirectory -File | Select-Object Name, Length, LastWriteTime

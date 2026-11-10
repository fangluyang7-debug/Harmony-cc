param([string]$PackageDir=$PSScriptRoot)
$ErrorActionPreference='Stop'
$packageRoot=(Resolve-Path -LiteralPath $PackageDir).Path
$candidates=@()
if($env:DEVECO_STUDIO_HOME){$candidates+=Join-Path $env:DEVECO_STUDIO_HOME 'sdk/default/openharmony/toolchains/hdc.exe'}
if($env:DEVECO_SDK_HOME){$candidates+=Join-Path $env:DEVECO_SDK_HOME 'default/openharmony/toolchains/hdc.exe'}
$candidates+='D:/Users/17321/AppData/DevEco Studio/sdk/default/openharmony/toolchains/hdc.exe'
$hdc=$candidates | Where-Object {Test-Path -LiteralPath $_} | Select-Object -First 1
if(-not $hdc){throw '未找到 HDC，请设置 DEVECO_STUDIO_HOME 后重新运行。'}
$files=@('03-Harmony-Device-Agent-API24-signed.hap','04-SoleAI-API24-signed.hap')
foreach($file in $files){if(-not (Test-Path -LiteralPath (Join-Path $packageRoot $file))){throw "补丁文件缺失：$file"}}
Write-Host '请连接手机调试线、解锁并确认调试授权。本工具只覆盖安装两个应用，保留数据。'
$devices=@(& $hdc list targets | Where-Object {$_ -and $_ -notmatch '\[Empty\]'} | ForEach-Object {$_.Trim()})
if($devices.Count -eq 0){throw '没有发现可调试设备。'}
for($i=0;$i -lt $devices.Count;$i++){Write-Host "$($i+1). $($devices[$i])"}
$choice=Read-Host '输入本次要更新的手机编号（请勿选择鸿蒙电脑）'
$number=0
if(-not [int]::TryParse($choice,[ref]$number) -or $number -lt 1 -or $number -gt $devices.Count){throw '设备编号无效。'}
$selected=$devices[$number-1]
foreach($file in $files){& $hdc -t $selected install -r (Join-Path $packageRoot $file);if($LASTEXITCODE -ne 0){throw "安装失败：$file。请检查系统版本、调试签名和设备授权，不要卸载清空数据。"}}
Write-Host '两个应用已更新。请按手动演示操作单打开 SoleAI。本脚本未启动任何购物任务。'

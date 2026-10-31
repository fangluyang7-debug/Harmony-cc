$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path $PSScriptRoot -Parent
$deployStage = Join-Path $repoRoot ('.test/space-deploy-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $deployStage | Out-Null
function Copy-Source([string]$relative) {
  $source = Join-Path $repoRoot $relative
  $target = Join-Path $deployStage $relative
  New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
  Copy-Item -LiteralPath $source -Destination $target -Recurse
}
# Only enumerated source is uploaded. Runtime databases, tokens, local files and previous builds are excluded.
Copy-Source 'package.json'
Copy-Source 'package-lock.json'
$manifest = Get-Content (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
foreach ($workspace in $manifest.workspaces) { Copy-Source ($workspace + '/package.json') }
foreach ($package in @('packages/scheduler-core','packages/resource-transport','packages/reference-capabilities','services/coordinator')) {
  Copy-Source ($package + '/src')
  Copy-Source ($package + '/tsconfig.json')
}
Copy-Source 'services/coordinator/prisma'
Copy-Source 'services/coordinator/scripts'
Copy-Source 'services/coordinator/Dockerfile'
Copy-Source 'apps/team-space-web'
Copy-Item -LiteralPath (Join-Path $repoRoot 'services/coordinator/railway.json') -Destination (Join-Path $deployStage 'railway.json')
Write-Output $deployStage

param([switch]$UseLocalSigning)
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$profile = Join-Path $repoRoot 'apps/harmony/build-profile.json5'
$template = Join-Path $repoRoot 'apps/harmony/build-profile.template.json5'
if (-not (Test-Path -LiteralPath $profile)) {
  Copy-Item -LiteralPath $template -Destination $profile
  Write-Output 'Created portable HarmonyOS build profile. Configure device signing in DevEco Studio when needed.'
}
if ($UseLocalSigning) {
  $localProfile = Join-Path $repoRoot '.migration-local/build-profile.original.json5'
  if (-not (Test-Path -LiteralPath $localProfile)) { throw 'Local signing backup is unavailable. Configure signing in DevEco Studio.' }
  Copy-Item -LiteralPath $localProfile -Destination $profile -Force
  Write-Output 'Restored this computer''s local signing profile (ignored by Git).'
}

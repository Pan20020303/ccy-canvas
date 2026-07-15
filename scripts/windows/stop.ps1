# Gracefully stop the backend process.

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $root

$pidFile = 'run\api.pid'

if (-not (Test-Path $pidFile)) {
  Write-Host 'Not running (no pid file)'
  # Best-effort: kill any stray ccy-canvas-api.exe
  Get-Process -Name 'ccy-canvas-api' -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "Killing stray process pid $($_.Id)"
    Stop-Process -Id $_.Id -Force
  }
  exit 0
}

$apiPid = Get-Content $pidFile
$proc = Get-Process -Id $apiPid -ErrorAction SilentlyContinue
if ($proc) {
  Write-Host "Stopping pid $apiPid ..."
  Stop-Process -Id $apiPid -Force
  for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Milliseconds 500
    if (-not (Get-Process -Id $apiPid -ErrorAction SilentlyContinue)) { break }
  }
}
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
Write-Host 'Stopped.'

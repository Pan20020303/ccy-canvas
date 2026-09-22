# Gracefully stop all backend API instances via /admin/shutdown HTTP endpoint.

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $root

$pidFiles = Get-ChildItem "run\api-*.pid" -ErrorAction SilentlyContinue
$singlePid = Join-Path $root "run\api.pid"

if ((Test-Path $singlePid) -and (-not $pidFiles)) {
  $pidFiles = @(Get-Item $singlePid)
}

if (-not $pidFiles) {
  Write-Host 'No running instances -- cleaning up stray processes'
  Get-Process -Name 'ccy-canvas-api' -ErrorAction SilentlyContinue | Stop-Process -Force
  exit 0
}

foreach ($pf in $pidFiles) {
  $name = $pf.BaseName
  $apiPid = Get-Content $pf.FullName
  $proc = Get-Process -Id $apiPid -ErrorAction SilentlyContinue
  if (-not $proc) {
    Write-Host "${name}: process $apiPid gone, removing pid file"
    Remove-Item $pf.FullName -Force
    continue
  }

  $port = 12090
  if ($name -match 'api-(\d+)') { $port = [int]$Matches[1] }

    Write-Host "${name}: stopping pid $apiPid via :${port}/admin/shutdown ..."
  try {
    $null = Invoke-WebRequest -Uri "http://127.0.0.1:${port}/admin/shutdown" -Method POST -TimeoutSec 5 -UseBasicParsing
    Write-Host "  Shutdown triggered."
  } catch {
    Write-Host "  Endpoint unreachable, process may already be dying"
  }

  for ($i = 0; $i -lt 50; $i++) {
    Start-Sleep -Milliseconds 500
    if (-not (Get-Process -Id $apiPid -ErrorAction SilentlyContinue)) {
      Write-Host "  Exited after $([math]::Round(($i+1)*0.5, 1))s."
      break
    }
  }

  if (Get-Process -Id $apiPid -ErrorAction SilentlyContinue) {
    Write-Host "  Timed out, force-killing ..."
    Stop-Process -Id $apiPid -Force
  }
  Remove-Item $pf.FullName -Force -ErrorAction SilentlyContinue
}

Write-Host 'All instances stopped.'

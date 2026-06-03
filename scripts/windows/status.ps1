# Print backend + PostgreSQL status.

$ErrorActionPreference = 'SilentlyContinue'
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $root

$pidFile = 'run\api.pid'

Write-Host '─── Backend ───────────────────────────────'
if ((Test-Path $pidFile) -and (Get-Process -Id (Get-Content $pidFile) -ErrorAction SilentlyContinue)) {
  $apiPid = Get-Content $pidFile
  $p = Get-Process -Id $apiPid
  Write-Host "Status: RUNNING (pid $apiPid)"
  Write-Host ("CPU: {0}s  WorkingSet: {1} MB  Started: {2}" -f `
    [math]::Round($p.CPU,1), `
    [math]::Round($p.WorkingSet64/1MB,1), `
    $p.StartTime)
} else {
  Write-Host 'Status: STOPPED'
}
Write-Host ''

Write-Host '─── PostgreSQL ────────────────────────────'
$state = docker inspect -f '{{.State.Status}}' ccy-canvas-postgres 2>$null
if ($state) {
  Write-Host "Container: $state"
  if ($state -eq 'running') {
    docker exec ccy-canvas-postgres pg_isready -U postgres -d ccy_canvas
  }
} else {
  Write-Host 'Container: missing or docker not available'
}
Write-Host ''

Write-Host '─── Recent logs (run\api.log tail) ────────'
if (Test-Path run\api.log) { Get-Content run\api.log -Tail 10 } else { Write-Host '(no log file yet)' }

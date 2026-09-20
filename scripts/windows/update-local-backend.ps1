# Roll one local replica at a time; never force-kill paid generation jobs.
param(
  [Parameter(Mandatory = $true)][string]$ExecutablePath,
  [string]$PreviousExecutablePath = '',
  [int[]]$Ports = @(9090, 9091, 9092)
)
$ErrorActionPreference = 'Stop'
$deployRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
$newExecutable = (Resolve-Path -LiteralPath $ExecutablePath).Path
if (-not $newExecutable.StartsWith($deployRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Update executable must be inside this project.' }
$originalExecutable = Join-Path $deployRoot 'ccy-canvas-api.exe'
if ($PreviousExecutablePath) {
  $originalExecutable = (Resolve-Path -LiteralPath $PreviousExecutablePath).Path
  if (-not $originalExecutable.StartsWith($deployRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Previous executable must be inside this project.' }
}
$newHash = (Get-FileHash -LiteralPath $newExecutable -Algorithm SHA256).Hash

foreach ($port in $Ports) {
  $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -First 1
  $process = Get-Process -Id $listener.OwningProcess -ErrorAction Stop
  if ($process.Path -ine $originalExecutable -and $process.Path -ine $newExecutable) { throw "Unexpected executable on port $port; no process stopped." }
}

$backupStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
foreach ($port in $Ports) {
  $activeCount = docker exec ccy-canvas-postgres psql -U postgres -d ccy_canvas -Atc "SELECT count(*) FROM generation_logs WHERE status IN ('queued','running','persisting','pending','retrying');"
  if ($LASTEXITCODE -ne 0 -or "$activeCount".Trim() -ne '0') { throw 'Active tasks or database check failure; update paused without forcing shutdown.' }
  $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop | Select-Object -First 1
  $process = Get-Process -Id $listener.OwningProcess -ErrorAction Stop
  if ($process.Path -ieq $newExecutable) { continue }
  if ($process.Path -ine $originalExecutable) { throw "Port $port owner changed; no process stopped." }
  $response = Invoke-WebRequest "http://127.0.0.1:${port}/admin/shutdown" -Method POST -TimeoutSec 5 -UseBasicParsing
  if ($response.StatusCode -ne 204) { throw "Shutdown was not acknowledged on port $port." }
  if (-not $process.WaitForExit(45000)) { throw "Port $port still draining; no force kill performed." }
  try {
    & "$PSScriptRoot\start-multi.ps1" -Ports @($port) -ExecutablePath $newExecutable
  } catch {
    # Restore the previous replica if the replacement never took the port.
    if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
      & "$PSScriptRoot\start-multi.ps1" -Ports @($port) -ExecutablePath $originalExecutable
    }
    throw
  }
}

# Keep all existing launch entry points on the same release, with backups.
foreach ($relativeTarget in @('ccy-canvas-api.exe', 'backend\ccy-canvas-api.exe', 'bin\ccy-canvas-api.exe')) {
  $target = Join-Path $deployRoot $relativeTarget
  if (Test-Path -LiteralPath $target) { Copy-Item -LiteralPath $target -Destination "$target.before-$backupStamp" }
  Copy-Item -LiteralPath $newExecutable -Destination $target -Force
  if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $newHash) { throw "Binary verification failed: $relativeTarget" }
}
foreach ($port in $Ports) {
  $health = Invoke-WebRequest "http://127.0.0.1:${port}/api/health" -TimeoutSec 5 -UseBasicParsing
  Write-Host "Updated port $port : HTTP $($health.StatusCode)"
}

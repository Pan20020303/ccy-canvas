# Start multiple backend API instances.
param(
  [int[]]$Ports = @(9090, 9091, 9092),
  [string]$ExecutablePath = ''
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $root
$instances = $Ports
$exe = if ($ExecutablePath) { (Resolve-Path -LiteralPath $ExecutablePath).Path } else { Join-Path $root 'backend\ccy-canvas-api.exe' }
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Backend executable is missing.' }
New-Item -ItemType Directory -Path (Join-Path $root 'run') -Force | Out-Null

$envVars = @{}
Get-Content '.env' | ForEach-Object {
  $line = $_.Trim()
  if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
    $k, $v = $line.Split('=', 2)
    $envVars[$k] = $v.Trim('"').Trim("'")
  }
}

foreach ($port in $instances) {
  if ($port -lt 1024 -or $port -gt 65535) { throw "Invalid API port: $port" }
  $pidFile = Join-Path $root "run\api-$port.pid"
  # A PID can be recycled by Windows. Trust the actual port owner and binary,
  # never the mere existence of the PID from an earlier boot.
  $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($listener) {
    $running = Get-Process -Id $listener.OwningProcess -ErrorAction Stop
    if ($running.Path -ine $exe) { throw "Port $port is occupied by a different executable; no process was stopped." }
    try {
      $health = Invoke-WebRequest "http://127.0.0.1:${port}/api/health" -TimeoutSec 5 -UseBasicParsing
      if ($health.StatusCode -ne 200) { throw 'Unhealthy API' }
    } catch { throw "Existing API on port $port did not pass its health check; no duplicate was started." }
    $running.Id | Out-File -LiteralPath $pidFile -Encoding ascii -NoNewline
    Write-Host "Port $port healthy (pid $($running.Id))"
    continue
  }
  if (Test-Path -LiteralPath $pidFile) {
    Remove-Item -LiteralPath $pidFile -Force
  }
  $envBlock = @{}
  foreach ($kv in $envVars.GetEnumerator()) { $envBlock[$kv.Key] = $kv.Value }
  $envBlock['HTTP_ADDR'] = "127.0.0.1:${port}"
  $logStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  $stdoutLog = Join-Path $root "run\api-$port-$logStamp.stdout.log"
  $stderrLog = Join-Path $root "run\api-$port-$logStamp.stderr.log"
  $proc = Start-Process -FilePath $exe -WorkingDirectory "backend" -Environment $envBlock -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
  $apiPid = $proc.Id
  $apiPid | Out-File -LiteralPath $pidFile -Encoding ascii -NoNewline
  $healthy = $false
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if ($proc.HasExited) { throw "API :$port failed to start; check $stderrLog" }
    try {
      $health = Invoke-WebRequest "http://127.0.0.1:${port}/api/health" -TimeoutSec 2 -UseBasicParsing
      if ($health.StatusCode -eq 200) { $healthy = $true; break }
    } catch { }
    Start-Sleep -Milliseconds 500
  }
  if (-not $healthy) { throw "API :$port did not become healthy; retain logs and inspect pid $apiPid." }
  Write-Host "Port $port healthy (pid $apiPid)"
}

Start-Sleep 2
foreach ($port in $instances) {
  try { $r = Invoke-WebRequest "http://127.0.0.1:${port}/api/health" -TimeoutSec 3 -UseBasicParsing; Write-Host ":$port $($r.StatusCode)" }
  catch { Write-Host ":$port DOWN" }
}

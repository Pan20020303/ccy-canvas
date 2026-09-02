# Start multiple backend API instances.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $root
$instances = @(9090, 9091, 9092)
$exe = Join-Path $root 'backend\ccy-canvas-api.exe'

$envVars = @{}
Get-Content '.env' | ForEach-Object {
  $line = $_.Trim()
  if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
    $k, $v = $line.Split('=', 2)
    $envVars[$k] = $v.Trim('"').Trim("'")
  }
}

foreach ($port in $instances) {
  $pidFile = Join-Path $root "run\api-$port.pid"
  if (Test-Path $pidFile) {
    $existing = Get-Content $pidFile
    if ($existing -and (Get-Process -Id $existing -ErrorAction SilentlyContinue)) {
      Write-Host "Port $port running (pid $existing)"; continue
    }
    Remove-Item $pidFile -Force
  }
  $envBlock = @{}
  foreach ($kv in $envVars.GetEnumerator()) { $envBlock[$kv.Key] = $kv.Value }
  $envBlock['HTTP_ADDR'] = "127.0.0.1:${port}"
  $logStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  $stdoutLog = Join-Path $root "run\api-$port-$logStamp.stdout.log"
  $stderrLog = Join-Path $root "run\api-$port-$logStamp.stderr.log"
  $proc = Start-Process -FilePath $exe -WorkingDirectory "backend" -Environment $envBlock -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog
  Start-Sleep 1
  if ($proc.HasExited) { throw "API :$port failed to start; check $stderrLog" }
  $apiPid = $proc.Id
  $apiPid | Out-File $pidFile -Encoding ascii -NoNewline
  Write-Host "Port $port pid=$apiPid"
}

Start-Sleep 2
foreach ($port in $instances) {
  try { $r = Invoke-WebRequest "http://127.0.0.1:${port}/api/health" -TimeoutSec 3 -UseBasicParsing; Write-Host ":$port $($r.StatusCode)" }
  catch { Write-Host ":$port DOWN" }
}

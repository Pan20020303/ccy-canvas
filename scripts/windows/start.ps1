# Start backend API as a hidden background process. PID + log in run\.

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $root

$pidFile = 'run\api.pid'
$logFile = 'run\api.log'
$bin     = 'bin\ccy-canvas-api.exe'

New-Item -ItemType Directory -Force -Path run | Out-Null

# Already running?
if (Test-Path $pidFile) {
  $existingPid = Get-Content $pidFile
  if ($existingPid -and (Get-Process -Id $existingPid -ErrorAction SilentlyContinue)) {
    Write-Host "Already running (pid $existingPid)"
    exit 0
  }
  Remove-Item $pidFile -Force
}

if (-not (Test-Path $bin)) {
  Write-Host "$bin not found — run scripts\windows\install.ps1 first" -ForegroundColor Red
  exit 1
}

# Load .env into the child process environment.
# Use .NET API + explicit UTF-8 reader so BOM bytes never leak into a value.
$envVars = @{}
if (Test-Path .env) {
  $reader = New-Object System.IO.StreamReader((Resolve-Path .env).Path, [System.Text.Encoding]::UTF8, $true)
  while (-not $reader.EndOfStream) {
    $line = $reader.ReadLine()
    if ($line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$') {
      $envVars[$matches[1]] = $matches[2].Trim().Trim('"').Trim("'")
    }
  }
  $reader.Close()
}

# Ensure local infrastructure containers are up. These are best-effort so a
# remote Postgres/Redis deployment can still be used via .env.
$postgresContainer = if ($envVars.ContainsKey('POSTGRES_CONTAINER') -and $envVars['POSTGRES_CONTAINER']) { $envVars['POSTGRES_CONTAINER'] } else { 'ccy-canvas-postgres' }
try { docker start $postgresContainer 2>$null | Out-Null } catch {}
if ($envVars.ContainsKey('REDIS_ADDR') -and $envVars['REDIS_ADDR']) {
  if ($envVars['REDIS_ADDR'] -match '^(localhost|127\.0\.0\.1):') {
    try { docker start ccy-canvas-redis 2>$null | Out-Null } catch {}
    $redisPing = $null
    try { $redisPing = docker exec ccy-canvas-redis redis-cli ping 2>$null } catch {}
    if ($redisPing -ne 'PONG') {
      Write-Host "Warning: REDIS_ADDR=$($envVars['REDIS_ADDR']) but ccy-canvas-redis did not answer PONG. Queue/cache will fail until Redis is running." -ForegroundColor Yellow
    }
  }
}

# Apply idempotent schema migrations before starting the API. This keeps
# existing server databases in sync after pulling newer backend code.
$migrationDir = Join-Path $root 'backend\db\migrations'
if (Test-Path $migrationDir) {
  Get-ChildItem $migrationDir -Filter '*.sql' | Sort-Object Name | ForEach-Object {
    Get-Content $_.FullName -Raw | docker exec -i $postgresContainer psql -U postgres -d ccy_canvas 2>$null | Out-Null
  }
}

# Use cmd /c with redirection to background-run the EXE and capture logs.
$envPairs = ($envVars.GetEnumerator() | ForEach-Object { "set `"$($_.Key)=$($_.Value)`" && " }) -join ''
$cmdLine = "$envPairs `"$bin`" >> `"$logFile`" 2>&1"

$process = Start-Process -FilePath "$env:ComSpec" `
  -ArgumentList "/c $cmdLine" `
  -WindowStyle Hidden `
  -PassThru

Start-Sleep -Seconds 1

# Find the actual ccy-canvas-api.exe child (Start-Process returns cmd.exe pid).
$apiProc = Get-Process -Name 'ccy-canvas-api' -ErrorAction SilentlyContinue | Select-Object -First 1
if ($apiProc) {
  $apiProc.Id | Out-File $pidFile -Encoding ascii -NoNewline
  Write-Host "Started (pid $($apiProc.Id)). Log: $logFile"
} else {
  Write-Host 'Failed to start — see log:' -ForegroundColor Red
  if (Test-Path $logFile) { Get-Content $logFile -Tail 30 }
  exit 1
}

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

# Ensure Postgres container is up
try { docker start ccy-canvas-postgres 2>$null | Out-Null } catch {}

# Load .env into the child process environment.
$envVars = @{}
if (Test-Path .env) {
  Get-Content .env | ForEach-Object {
    if ($_ -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$') {
      $envVars[$matches[1]] = $matches[2].Trim().Trim('"').Trim("'")
    }
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

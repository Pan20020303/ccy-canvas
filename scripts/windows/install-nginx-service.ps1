# Register nginx as a Windows service via NSSM so it survives logout / reboot.
# Prereq: install-nginx.ps1 already ran AND nssm is on PATH (choco install nssm).
#
# Run as Administrator:
#   powershell -ExecutionPolicy Bypass -File scripts\windows\install-nginx-service.ps1

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $root

if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) {
  Write-Host 'nssm not found. Install via: choco install nssm   (or https://nssm.cc)' -ForegroundColor Red
  exit 1
}

$installFile = "$root\run\nginx-install-dir.txt"
$installDir = if (Test-Path $installFile) { (Get-Content $installFile).Trim() } else { 'C:\nginx' }
$bin = Join-Path $installDir 'nginx.exe'
if (-not (Test-Path $bin)) {
  Write-Host "nginx.exe not found at $bin — run install-nginx.ps1 first." -ForegroundColor Red
  exit 1
}

$svc = 'CCYCanvasNginx'
nssm stop $svc 2>$null | Out-Null
nssm remove $svc confirm 2>$null | Out-Null

# Stop standalone nginx first so the service can own port 80.
Get-Process -Name 'nginx' -ErrorAction SilentlyContinue | Stop-Process -Force

nssm install $svc $bin
nssm set $svc AppDirectory $installDir
nssm set $svc AppStdout    (Join-Path $installDir 'logs\service-stdout.log')
nssm set $svc AppStderr    (Join-Path $installDir 'logs\service-stderr.log')
nssm set $svc AppRotateFiles 1
nssm set $svc AppRotateBytes 52428800     # 50 MB rotation
nssm set $svc Start SERVICE_AUTO_START
nssm set $svc AppStopMethodSkip 6         # ask nginx for graceful stop via signal first
nssm set $svc AppStopMethodConsole 5000
nssm set $svc AppExit Default Restart     # auto-restart on crash

nssm start $svc
Start-Sleep -Seconds 2
nssm status $svc

Write-Host ''
Write-Host "Service '$svc' installed. Manage via:" -ForegroundColor Green
Write-Host "  nssm status $svc"
Write-Host "  nssm restart $svc"
Write-Host "  nssm stop $svc"
Write-Host "  nssm remove $svc confirm"

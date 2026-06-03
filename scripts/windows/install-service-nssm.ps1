# Install backend as a Windows service via NSSM (Non-Sucking Service Manager).
# NSSM keeps the process alive across reboots and re-launches it on crash.
#
# Prereq:
#   choco install nssm                    # via chocolatey
#   - OR download nssm.exe and place in PATH from https://nssm.cc/download
#
# Run as Administrator:
#   powershell -ExecutionPolicy Bypass -File scripts\windows\install-service-nssm.ps1

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $root

if (-not (Get-Command nssm -ErrorAction SilentlyContinue)) {
  Write-Host 'nssm not found. Install via: choco install nssm   (or download from https://nssm.cc)' -ForegroundColor Red
  exit 1
}

$svc = 'CCYCanvasAPI'
$bin = (Resolve-Path 'bin\ccy-canvas-api.exe').Path
$log = (Resolve-Path 'run').Path

if (-not (Test-Path $bin)) { Write-Host "$bin missing — run install.ps1 first" -ForegroundColor Red; exit 1 }

# Stop and remove any old version of the service.
nssm stop $svc 2>$null | Out-Null
nssm remove $svc confirm 2>$null | Out-Null

# Install service.
nssm install $svc $bin
nssm set $svc AppDirectory $root
nssm set $svc AppStdout (Join-Path $log 'api.log')
nssm set $svc AppStderr (Join-Path $log 'api.log')
nssm set $svc AppRotateFiles 1
nssm set $svc AppRotateOnline 1
nssm set $svc AppRotateBytes 52428800   # 50 MB rotation
nssm set $svc Start SERVICE_AUTO_START

# Inject .env into the service environment.
if (Test-Path .env) {
  $envLines = @()
  Get-Content .env | ForEach-Object {
    if ($_ -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$') {
      $envLines += "$($matches[1])=$($matches[2].Trim().Trim('`"').Trim(`"'`"))"
    }
  }
  nssm set $svc AppEnvironmentExtra ($envLines -join "`r`n")
}

nssm start $svc
Start-Sleep -Seconds 2
nssm status $svc

Write-Host ''
Write-Host "Service '$svc' installed. Manage via:" -ForegroundColor Green
Write-Host "  nssm status $svc"
Write-Host "  nssm restart $svc"
Write-Host "  nssm stop $svc"
Write-Host "  nssm remove $svc confirm   # uninstall"

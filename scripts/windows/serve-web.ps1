# Simple static server for dist\ using Python (testing only).
param([int]$Port = 5173)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot\..\..").Path

if (-not (Test-Path "$root\dist")) {
  Write-Host "dist\ not found — run scripts\windows\build-web.ps1 first" -ForegroundColor Red
  exit 1
}

$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) { $py = Get-Command py -ErrorAction SilentlyContinue }
if (-not $py) {
  Write-Host 'python not installed — install Python 3 or use nginx (see DEPLOY.md).' -ForegroundColor Red
  exit 1
}

Set-Location "$root\dist"
Write-Host "Serving dist\ on 0.0.0.0:$Port (Ctrl+C to stop)"
& $py.Source -m http.server $Port --bind 0.0.0.0

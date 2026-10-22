# SPA-aware static server for dist\ — handles refresh on /app, /admin etc.
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

# Use our SPA-aware server (falls back to index.html on unknown routes).
& $py.Source "$root\scripts\spa_server.py" --port $Port --host 0.0.0.0 --dir "$root\dist"

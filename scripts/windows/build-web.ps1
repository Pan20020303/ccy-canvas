# Build the frontend bundle, injecting VITE_API_BASE_URL from .env.

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $root

function Log($msg)  { Write-Host "==> $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "!!! $msg" -ForegroundColor Yellow }

# Parse .env for PUBLIC_API_BASE
$apiBase = ''
if (Test-Path .env) {
  Get-Content .env | ForEach-Object {
    if ($_ -match '^\s*PUBLIC_API_BASE\s*=\s*(.*)\s*$') {
      $apiBase = $matches[1].Trim().Trim('"').Trim("'")
    }
  }
}

if ([string]::IsNullOrWhiteSpace($apiBase)) {
  Warn 'PUBLIC_API_BASE not set — frontend will use relative paths (assumes nginx reverse-proxy).'
} else {
  Log "Building frontend with VITE_API_BASE_URL=$apiBase"
}

$env:VITE_API_BASE_URL = $apiBase
npm run build
if ($LASTEXITCODE -ne 0) { Write-Host 'Frontend build failed' -ForegroundColor Red; exit 1 }

Log 'Frontend built to dist\'

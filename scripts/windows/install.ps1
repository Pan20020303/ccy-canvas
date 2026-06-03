# One-shot install / upgrade for Windows.
# Run from project root in PowerShell (Run as Administrator recommended for first time):
#   powershell -ExecutionPolicy Bypass -File scripts\windows\install.ps1

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $root

function Log($msg)  { Write-Host "==> $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "!!! $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Host "xxx $msg" -ForegroundColor Red; exit 1 }

# 1. Dependency check ────────────────────────────────────────────────────────
foreach ($cmd in @('go','npm','docker')) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    Die "Missing dependency: $cmd (install it then re-run)"
  }
}

# 2. .env bootstrap ──────────────────────────────────────────────────────────
if (-not (Test-Path .env)) {
  Log 'Generating .env from .env.example'
  Copy-Item .env.example .env

  function RandHex($bytes = 32) {
    $b = New-Object byte[] $bytes
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
    ($b | ForEach-Object { $_.ToString('x2') }) -join ''
  }
  function RandBase64($bytes = 32) {
    $b = New-Object byte[] $bytes
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
    [Convert]::ToBase64String($b)
  }

  $sess = RandHex 32
  $enc  = RandBase64 32
  (Get-Content .env) `
    -replace '^SESSION_SECRET=.*',    "SESSION_SECRET=$sess" `
    -replace '^CCY_ENCRYPTION_KEY=.*', "CCY_ENCRYPTION_KEY=$enc" `
    | Set-Content .env -Encoding utf8
  Log 'Auto-generated SESSION_SECRET and CCY_ENCRYPTION_KEY'
  Warn 'Edit .env to set PUBLIC_API_BASE to your LAN IP before building frontend.'
}

# 3. Start PostgreSQL ────────────────────────────────────────────────────────
Log 'Starting PostgreSQL container (docker compose)'
docker compose up -d postgres

Log 'Waiting for PostgreSQL to accept connections'
for ($i = 0; $i -lt 30; $i++) {
  try { docker exec ccy-canvas-postgres pg_isready -U postgres -d ccy_canvas | Out-Null; if ($LASTEXITCODE -eq 0) { break } } catch {}
  Start-Sleep -Seconds 1
}

# 4. Build backend ───────────────────────────────────────────────────────────
Log 'Building backend binary'
New-Item -ItemType Directory -Force -Path bin | Out-Null
Push-Location backend
go build -o ..\bin\ccy-canvas-api.exe .\cmd\api
if ($LASTEXITCODE -ne 0) { Pop-Location; Die 'Backend build failed' }
Pop-Location
$size = (Get-Item bin\ccy-canvas-api.exe).Length
Log "Built bin\ccy-canvas-api.exe ($size bytes)"

# 5. Install + build frontend ────────────────────────────────────────────────
Log 'Installing frontend dependencies'
npm install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { Die 'npm install failed' }

powershell -ExecutionPolicy Bypass -File "$root\scripts\windows\build-web.ps1"

Log 'INSTALL DONE.'
Write-Host ''
Write-Host 'Next steps:'
Write-Host '  1) Edit .env: confirm PUBLIC_API_BASE, SESSION_SECRET, CCY_ENCRYPTION_KEY'
Write-Host '  2) scripts\windows\start.ps1   # start backend'
Write-Host '  3) Open http://<server-lan-ip> (with nginx) or http://<server-lan-ip>:5173 (with serve-web.ps1)'

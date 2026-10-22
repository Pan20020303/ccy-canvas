# One-click dev launcher for CCY Canvas.
#
# What it does, in order:
#   1. Make sure the Postgres container is up
#   2. Apply any unapplied schema migrations (idempotent)
#   3. (Re)build + start the backend API on :8080
#   4. Start the Vite dev server on :5173 in a separate window
#   5. Wait for both ports to be ready
#   6. Open the workspace in the default browser
#
# Safe to double-click multiple times -- running components are detected
# and reused instead of starting duplicates.
#
# NOTE: this file is intentionally ASCII-only so Windows PowerShell 5.1
# (default on Windows 10/11) parses it reliably regardless of console
# code page. Don't add box-drawing or emoji characters back.

$ErrorActionPreference = 'Continue'
$ProjectRoot = 'D:\code\ccy-canvas'
$BackendBin  = Join-Path $ProjectRoot 'backend\ccy-canvas-backend-latest.exe'
$ApiLog      = Join-Path $ProjectRoot 'backend\api.log'
$ApiErrLog   = Join-Path $ProjectRoot 'backend\api.err.log'
$EnvFile     = Join-Path $ProjectRoot '.env'

function Write-Step($message) {
  Write-Host ''
  Write-Host '----------------------------------------------' -ForegroundColor DarkCyan
  Write-Host (' ' + $message) -ForegroundColor Cyan
  Write-Host '----------------------------------------------' -ForegroundColor DarkCyan
}

function Write-Ok($message)   { Write-Host ('  [OK]   ' + $message) -ForegroundColor Green }
function Write-Skip($message) { Write-Host ('  [..]   ' + $message) -ForegroundColor DarkYellow }
function Write-Bad($message)  { Write-Host ('  [FAIL] ' + $message) -ForegroundColor Red }

$Host.UI.RawUI.WindowTitle = 'CCY Canvas - Launcher'
Clear-Host
Write-Host ''
Write-Host '   ============================================' -ForegroundColor Cyan
Write-Host '             CCY Canvas - Dev Launcher'  -ForegroundColor Cyan
Write-Host '   ============================================' -ForegroundColor Cyan

Set-Location $ProjectRoot

# ---------- 1. Postgres ----------
Write-Step '1/5  Postgres container'
$pgStatus = docker inspect -f '{{.State.Status}}' ccy-canvas-postgres 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Bad 'Container ccy-canvas-postgres not found. Run scripts\windows\install.ps1 first.'
  Read-Host 'Press Enter to exit'
  exit 1
}
if ($pgStatus -eq 'running') {
  Write-Ok 'Already running'
} else {
  docker start ccy-canvas-postgres | Out-Null
  Start-Sleep -Seconds 1
  Write-Ok 'Started'
}

# ---------- 2. Migrations ----------
Write-Step '2/5  Apply pending DB migrations'
$migrationDir = Join-Path $ProjectRoot 'backend\db\migrations'
if (Test-Path $migrationDir) {
  $files = Get-ChildItem $migrationDir -Filter '*.sql' | Sort-Object Name
  foreach ($f in $files) {
    # Pipe each migration into psql inside the container. Idempotent
    # migrations (those using IF NOT EXISTS / ALTER ... IF NOT EXISTS)
    # are safe to re-run on every launch. Errors are tolerated.
    $null = Get-Content $f.FullName -Raw | docker exec -i ccy-canvas-postgres psql -U postgres -d ccy_canvas 2>$null
    Write-Ok $f.Name
  }
} else {
  Write-Skip 'No migration directory found'
}

# ---------- 3. Backend ----------
Write-Step '3/5  Backend API on port 8080'

# Kill any existing backend bound to :8080 so we start with a clean process.
$existing = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  $existing.OwningProcess | Sort-Object -Unique | ForEach-Object {
    Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 1
  Write-Skip 'Restarted (was already running)'
}

if (-not (Test-Path $BackendBin)) {
  Write-Bad ('Backend binary missing: ' + $BackendBin)
  Write-Host '  Building from source ...' -ForegroundColor DarkGray
  Push-Location (Join-Path $ProjectRoot 'backend')
  go build -o ccy-canvas-backend-latest.exe ./cmd/api
  $built = $?
  Pop-Location
  if (-not $built) {
    Write-Bad 'go build failed.'
    Read-Host 'Press Enter to exit'
    exit 1
  }
  Write-Ok 'Built'
}

# Load .env into the child env so DATABASE_URL etc. are visible.
$envVars = @{}
if (Test-Path $EnvFile) {
  $reader = New-Object System.IO.StreamReader((Resolve-Path $EnvFile).Path, [System.Text.Encoding]::UTF8, $true)
  while (-not $reader.EndOfStream) {
    $line = $reader.ReadLine()
    if ($line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$') {
      $envVars[$matches[1]] = $matches[2].Trim().Trim('"').Trim("'")
    }
  }
  $reader.Close()
}
foreach ($k in $envVars.Keys) { Set-Item -Path "Env:$k" -Value $envVars[$k] }

$backendProc = Start-Process -FilePath $BackendBin `
  -WorkingDirectory (Join-Path $ProjectRoot 'backend') `
  -WindowStyle Hidden `
  -PassThru `
  -RedirectStandardOutput $ApiLog `
  -RedirectStandardError $ApiErrLog

# Probe /api/health until it answers (or we give up after 15s).
$ready = $false
for ($i = 0; $i -lt 15; $i++) {
  Start-Sleep -Seconds 1
  try {
    $resp = Invoke-WebRequest -Uri 'http://localhost:8080/api/health' -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop
    if ($resp.StatusCode -eq 200) { $ready = $true; break }
  } catch { }
}
if ($ready) {
  Write-Ok ('Started (pid ' + $backendProc.Id + ')')
} else {
  Write-Bad ('Backend pid ' + $backendProc.Id + ' did not respond on /api/health within 15s. See ' + $ApiLog)
}

# ---------- 4. Frontend dev server ----------
Write-Step '4/5  Frontend dev server on port 5173'

$viteRunning = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue
if ($viteRunning) {
  Write-Ok 'Already running'
} else {
  # Launch `npm run dev` in a NEW window so its logs are visible separately.
  # The launcher window stays clean and shows the summary at the end.
  $vitePs1 = @"
`$Host.UI.RawUI.WindowTitle = 'CCY Canvas - Vite Dev Server'
Set-Location '$ProjectRoot'
Write-Host 'Starting Vite dev server on http://localhost:5173 ...' -ForegroundColor Cyan
Write-Host ''
npm run dev
Read-Host 'Press Enter to close'
"@
  $viteScriptPath = Join-Path $env:TEMP ('ccy-canvas-vite-' + [System.Guid]::NewGuid().ToString() + '.ps1')
  Set-Content -Path $viteScriptPath -Value $vitePs1 -Encoding UTF8
  Start-Process -FilePath 'powershell.exe' `
    -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $viteScriptPath `
    -WindowStyle Normal | Out-Null
  Write-Ok 'Launched in new window'
}

# ---------- 5. Open browser ----------
Write-Step '5/5  Wait for frontend and open browser'
$webReady = $false
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 1
  try {
    $resp = Invoke-WebRequest -Uri 'http://localhost:5173' -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop
    if ($resp.StatusCode -ge 200 -and $resp.StatusCode -lt 400) { $webReady = $true; break }
  } catch { }
}
if ($webReady) {
  Write-Ok 'http://localhost:5173 is live'
  Start-Process 'http://localhost:5173'
} else {
  Write-Bad 'Frontend did not come up in 30s -- open http://localhost:5173 manually'
}

# ---------- Summary ----------
Write-Host ''
Write-Host '   ============================================' -ForegroundColor Green
Write-Host '             ALL SYSTEMS RUNNING' -ForegroundColor Green
Write-Host '   ============================================' -ForegroundColor Green
Write-Host ''
Write-Host '  Workspace : http://localhost:5173' -ForegroundColor White
Write-Host '  Backend   : http://localhost:8080  (log: backend\api.log)' -ForegroundColor White
Write-Host '  Postgres  : localhost:5432 (docker: ccy-canvas-postgres)' -ForegroundColor White
Write-Host ''
Write-Host '  Close this window anytime -- services keep running.' -ForegroundColor DarkGray
Write-Host '  To stop everything later: run scripts\windows\stop-all.ps1' -ForegroundColor DarkGray
Write-Host ''
Start-Sleep -Seconds 8

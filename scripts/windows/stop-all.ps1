# Stop everything started by desktop-launch.ps1.
# Postgres container is left running by default (containers are cheap),
# pass `-StopPostgres` to also stop it.
#
# ASCII-only on purpose -- Windows PowerShell 5.1 mis-parses unicode
# punctuation/emoji depending on console code page.

param([switch]$StopPostgres)

$ErrorActionPreference = 'Continue'
$Host.UI.RawUI.WindowTitle = 'CCY Canvas - Stop'
Clear-Host
Write-Host ''
Write-Host '   Stopping CCY Canvas services ...' -ForegroundColor Cyan
Write-Host ''

# Kill anything bound to backend (:8080) and frontend (:5173).
foreach ($port in @(8080, 5173)) {
  $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($conns) {
    $conns.OwningProcess | Sort-Object -Unique | ForEach-Object {
      $p = Get-Process -Id $_ -ErrorAction SilentlyContinue
      if ($p) {
        Write-Host ('   [OK] Stopping ' + $p.ProcessName + ' (pid ' + $p.Id + ', port ' + $port + ')') -ForegroundColor Green
        Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
      }
    }
  } else {
    Write-Host ('   [..] Nothing on port ' + $port) -ForegroundColor DarkYellow
  }
}

# Best-effort: also kill any leftover backend exe that may have detached
# from a freed port already.
Get-Process -Name 'ccy-canvas-backend-latest' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

if ($StopPostgres) {
  docker stop ccy-canvas-postgres 2>$null | Out-Null
  Write-Host '   [OK] Postgres container stopped' -ForegroundColor Green
} else {
  Write-Host '   [..] Postgres container left running (pass -StopPostgres to stop it too)' -ForegroundColor DarkYellow
}

Write-Host ''
Write-Host '   Done.' -ForegroundColor Green
Write-Host ''
Start-Sleep -Seconds 3

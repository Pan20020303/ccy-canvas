# Dump PostgreSQL to a timestamped .sql.gz file. Recommended via Windows Task Scheduler.

param(
  [string]$BackupDir = 'C:\Backups\ccy-canvas',
  [int]$RetainDays = 14
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null

$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$out = Join-Path $BackupDir "ccy-canvas-$ts.sql.gz"

# pg_dump + gzip in one pipeline. gzip needs to be on PATH (Git for Windows includes it).
$gzip = Get-Command gzip -ErrorAction SilentlyContinue
if (-not $gzip) {
  # Fallback: dump uncompressed
  $out = $out -replace '\.gz$',''
  docker exec ccy-canvas-postgres pg_dump -U postgres ccy_canvas | Out-File $out -Encoding utf8
} else {
  $tmp = Join-Path $BackupDir "ccy-canvas-$ts.sql"
  docker exec ccy-canvas-postgres pg_dump -U postgres ccy_canvas | Out-File $tmp -Encoding utf8
  & $gzip.Source $tmp
}

Write-Host "Wrote $out"

# Prune backups older than RetainDays.
Get-ChildItem -Path $BackupDir -Filter 'ccy-canvas-*.sql*' |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$RetainDays) } |
  ForEach-Object { Remove-Item $_.FullName -Force; Write-Host "Pruned $($_.Name)" }

param(
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
}

Write-Host "Starting PostgreSQL via Docker Compose..."
docker compose up -d postgres

Write-Host "Waiting for PostgreSQL healthcheck..."
$attempt = 0
do {
  $attempt++
  $status = docker inspect --format "{{.State.Health.Status}}" ccy-canvas-postgres 2>$null
  if ($status -eq "healthy") { break }
  Start-Sleep -Seconds 2
} while ($attempt -lt 30)

if ($status -ne "healthy") {
  throw "PostgreSQL container did not become healthy in time."
}

$envMap = @{}
Get-Content ".env" | ForEach-Object {
  if ($_ -match "^\s*#" -or $_ -match "^\s*$") { return }
  $parts = $_ -split "=", 2
  if ($parts.Length -eq 2) {
    $envMap[$parts[0]] = $parts[1]
  }
}

$env:DATABASE_URL = $envMap["DATABASE_URL"]
$env:SESSION_SECRET = $envMap["SESSION_SECRET"]
$env:HTTP_ADDR = $envMap["HTTP_ADDR"]
$env:COOKIE_SECURE = $envMap["COOKIE_SECURE"]

if (-not $SkipBuild) {
  Write-Host "Running frontend build precheck..."
  npm run build
}

Write-Host "Starting backend on $env:HTTP_ADDR ..."
Start-Process -FilePath "go" -ArgumentList "run ./cmd/api" -WorkingDirectory (Join-Path $root "backend") -WindowStyle Hidden

Write-Host "Starting frontend dev server..."
npm run dev

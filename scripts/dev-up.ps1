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
$reader = New-Object System.IO.StreamReader((Resolve-Path ".env").Path, [System.Text.Encoding]::UTF8, $true)
while (-not $reader.EndOfStream) {
  $line = $reader.ReadLine()
  if ($line -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$') {
    $envMap[$matches[1]] = $matches[2].Trim().Trim('"').Trim("'")
  }
}
$reader.Close()

# The backend reads configuration from its process environment; it does not
# parse .env itself. Forward every entry so storage/Redis/encryption/provider
# settings are not silently lost (previously only four basic values were set,
# which made STORAGE_BACKEND fall back to local even when .env said "oss").
foreach ($key in $envMap.Keys) {
  Set-Item -Path "Env:$key" -Value $envMap[$key]
}

if (-not $SkipBuild) {
  Write-Host "Running frontend build precheck..."
  npm run build
}

Write-Host "Starting backend on $env:HTTP_ADDR ..."
Start-Process -FilePath "go" -ArgumentList "run ./cmd/api" -WorkingDirectory (Join-Path $root "backend") -WindowStyle Hidden

Write-Host "Starting frontend dev server..."
npm run dev

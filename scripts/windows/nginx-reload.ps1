# Hot-reload nginx config (no downtime).
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
$installFile = "$root\run\nginx-install-dir.txt"
$installDir = if (Test-Path $installFile) { (Get-Content $installFile).Trim() } else { 'C:\nginx' }

if (-not (Test-Path "$installDir\nginx.exe")) {
  Write-Host "nginx not found at $installDir" -ForegroundColor Red
  exit 1
}

Push-Location $installDir
& .\nginx.exe -t
if ($LASTEXITCODE -ne 0) { Pop-Location; Write-Host 'Config test failed; not reloading.' -ForegroundColor Red; exit 1 }
& .\nginx.exe -s reload
Pop-Location

Write-Host 'nginx reloaded.'

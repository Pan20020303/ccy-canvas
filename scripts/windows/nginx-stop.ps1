$root = (Resolve-Path "$PSScriptRoot\..\..").Path
$installFile = "$root\run\nginx-install-dir.txt"
$installDir = if (Test-Path $installFile) { (Get-Content $installFile).Trim() } else { 'C:\nginx' }

if (-not (Test-Path "$installDir\nginx.exe")) {
  Write-Host "nginx not found at $installDir" -ForegroundColor Red
  exit 1
}

Push-Location $installDir
& .\nginx.exe -s quit 2>$null | Out-Null
Pop-Location

Start-Sleep -Milliseconds 500

# Catch any residual workers.
$residual = Get-Process -Name 'nginx' -ErrorAction SilentlyContinue
if ($residual) {
  $residual | Stop-Process -Force
  Write-Host 'Force-killed residual nginx workers.'
} else {
  Write-Host 'nginx stopped.'
}

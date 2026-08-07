# Start nginx — uses InstallDir saved during install-nginx.ps1 (defaults C:\nginx).
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
$installFile = "$root\run\nginx-install-dir.txt"
$installDir = if (Test-Path $installFile) { (Get-Content $installFile).Trim() } else { 'C:\nginx' }

if (-not (Test-Path "$installDir\nginx.exe")) {
  Write-Host "nginx not found at $installDir — run install-nginx.ps1 first" -ForegroundColor Red
  exit 1
}

if (Get-Process -Name 'nginx' -ErrorAction SilentlyContinue) {
  Write-Host 'nginx already running'
  exit 0
}

Start-Process -FilePath "$installDir\nginx.exe" -WorkingDirectory $installDir -WindowStyle Hidden
Start-Sleep -Seconds 1
$p = Get-Process -Name 'nginx' -ErrorAction SilentlyContinue
if ($p) { Write-Host "Started (pids: $((($p | Select-Object -Expand Id) -join ', ')))" }
else    { Write-Host "Failed to start — see $installDir\logs\error.log" -ForegroundColor Red; exit 1 }

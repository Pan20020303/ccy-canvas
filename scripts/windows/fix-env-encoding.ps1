# Repair an existing .env that was accidentally saved as UTF-8 WITH BOM
# or with CRLF — rewrites to UTF-8 (no BOM) + LF.
# Run if you see 乱码 (mojibake) in the file, or the backend can't read DATABASE_URL.

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $root

if (-not (Test-Path .env)) { Write-Host '.env not found' -ForegroundColor Red; exit 1 }

# Read with BOM-detection enabled; .NET will strip the BOM if present.
$reader = New-Object System.IO.StreamReader((Resolve-Path .env).Path, [System.Text.Encoding]::UTF8, $true)
$content = $reader.ReadToEnd()
$reader.Close()

# Normalize line endings to LF.
$content = $content -replace "`r`n","`n" -replace "`r","`n"

# Write back as UTF-8 no BOM.
$enc = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText((Resolve-Path .env).Path, $content, $enc)

# Verify: check the first 3 bytes are NOT EF BB BF.
$bytes = [System.IO.File]::ReadAllBytes((Resolve-Path .env).Path) | Select-Object -First 3
if ($bytes.Count -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
  Write-Host 'Repair failed — .env still has BOM' -ForegroundColor Red
  exit 1
}
Write-Host '.env repaired (UTF-8 no BOM, LF line endings).' -ForegroundColor Green

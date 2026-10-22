$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
powershell -ExecutionPolicy Bypass -File "$root\scripts\windows\stop.ps1"
powershell -ExecutionPolicy Bypass -File "$root\scripts\windows\start.ps1"

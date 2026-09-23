$envFile = 'D:\code\ccy-canvas\.env'
Get-Content $envFile | ForEach-Object {
  if ($_ -match '^(\w+)=(.*)$') {
    [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
  }
}
Set-Location 'D:\code\ccy-canvas\backend'
& 'D:\code\ccy-canvas\backend\ccy-canvas-backend-latest.exe' 1>>'D:\code\ccy-canvas\backend-dev-live.log' 2>>'D:\code\ccy-canvas\backend-dev-live.err.log'

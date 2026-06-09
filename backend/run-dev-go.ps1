$envFile = 'D:\code\ccy-canvas\.env'
Get-Content $envFile | ForEach-Object {
  if ($_ -match '^(\w+)=(.*)$') {
    [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
  }
}

Set-Location 'D:\code\ccy-canvas\backend'
go run ./cmd/api 1>>'D:\code\ccy-canvas\backend\api.log' 2>>'D:\code\ccy-canvas\backend\api.err.log'

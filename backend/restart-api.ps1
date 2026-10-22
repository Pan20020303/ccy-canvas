# 重启 ccy-canvas API（用仓库里的 .env）
#
# 为什么需要这个脚本：Go 侧不读 .env（只有 DSH 会读），所以从终端手工启动会
# 缺 DATABASE_URL / SESSION_ENCRYPTION 之类的变量而启动失败。这里统一从 .env 注入。
#
# 用法（在 backend 目录下）：
#   pwsh -File restart-api.ps1 -Exe .\ccy-canvas-api.exe
#
# 行为：
#   1. 找到监听 HTTP_ADDR（默认 :9090）的旧进程并优雅停止
#   2. 校验目标二进制存在
#   3. 用 .env 注入的环境变量启动，stderr 落 run/ 目录
param(
    [string]$Exe = ".\ccy-canvas-api.exe",
    [int]$Port = 9090,
    [int]$WaitSeconds = 25
)

$ErrorActionPreference = "Stop"
$backendDir = $PSScriptRoot
$repoRoot = Split-Path $backendDir -Parent
$envFile = Join-Path $repoRoot ".env"
$runDir = Join-Path $backendDir "run"

if (-not (Test-Path $Exe)) { throw "找不到二进制: $Exe" }
if (-not (Test-Path $envFile)) { throw "找不到 .env: $envFile" }
New-Item -ItemType Directory -Force -Path $runDir | Out-Null

# ── 1. 停旧进程 ───────────────────────────────────────────────────────────────
$conn = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalPort -eq $Port }
if ($conn) {
    foreach ($ownerPid in ($conn.OwningProcess | Select-Object -Unique)) {
        try {
            $proc = Get-Process -Id $ownerPid -ErrorAction Stop
            Write-Host "[restart] 停止 PID $ownerPid ($($proc.ProcessName))"
            Stop-Process -Id $ownerPid -Force
        } catch {
            Write-Host "[restart] PID $ownerPid 已不在"
        }
    }
    Start-Sleep -Seconds 2
}

# ── 2. 注入 .env（跳过注释与空行）─────────────────────────────────────────────
Get-Content $envFile | Where-Object { $_ -match '^[A-Za-z_][A-Za-z0-9_]*=' } | ForEach-Object {
    $kv = $_ -split '=', 2
    [Environment]::SetEnvironmentVariable($kv[0].Trim(), $kv[1].Trim(), 'Process')
}
Write-Host "[restart] 已注入 .env（DB=$($env:DATABASE_URL -replace ':[^:@]+@', ':***@')）"

# ── 3. 启动 ──────────────────────────────────────────────────────────────────
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outLog = Join-Path $runDir "api-$stamp.stdout.log"
$errLog = Join-Path $runDir "api-$stamp.stderr.log"
Write-Host "[restart] 启动 $Exe，日志: $errLog"
$proc = Start-Process -FilePath $Exe -WorkingDirectory $backendDir -PassThru `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog
Write-Host "[restart] 新 PID $($proc.Id)"

# ── 4. 等它真正开始监听（而不是猜时间）──────────────────────────────────────
$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    if ($proc.HasExited) {
        Write-Host "[restart] 进程已退出（code=$($proc.ExitCode)），stderr 尾部："
        Get-Content $errLog -Tail 20 | ForEach-Object { Write-Host "  $_" }
        exit 1
    }
    $listening = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalPort -eq $Port }
    if ($listening) {
        Write-Host "[restart] 已在 :$Port 监听 ✅"
        exit 0
    }
}
Write-Host "[restart] 超时（$WaitSeconds s）仍未监听，stderr 尾部："
Get-Content $errLog -Tail 20 | ForEach-Object { Write-Host "  $_" }
exit 1

[CmdletBinding()]
param(
    [ValidateSet("Start", "Stop", "Restart", "Status")]
    [string]$Action = "Status",
    [string]$ConfigPath = "C:\ccy迁移\config\compute-nodes\seetacloud-h3.json"
)

$ErrorActionPreference = "Stop"

function Read-NodeConfig {
    if (-not (Test-Path -LiteralPath $ConfigPath)) {
        throw "SSH compute config not found: $ConfigPath"
    }
    $config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    foreach ($name in @("name", "host", "ssh_port", "ssh_user", "identity_file", "local_port", "remote_port", "pid_file", "log_file")) {
        if ($null -eq $config.$name -or [string]::IsNullOrWhiteSpace([string]$config.$name)) {
            throw "SSH compute config is missing '$name': $ConfigPath"
        }
    }
    return $config
}

function Get-TunnelProcess([object]$Config) {
    if (-not (Test-Path -LiteralPath $Config.pid_file)) {
        return $null
    }
    $savedPid = (Get-Content -LiteralPath $Config.pid_file -Raw).Trim()
    if ($savedPid -notmatch '^\d+$') {
        return $null
    }
    return Get-Process -Id ([int]$savedPid) -ErrorAction SilentlyContinue
}

function Wait-ComfyUI([object]$Config) {
    $deadline = (Get-Date).AddSeconds(15)
    $url = "http://127.0.0.1:$($Config.local_port)/system_stats"
    do {
        try {
            $null = Invoke-RestMethod -Uri $url -TimeoutSec 3
            return
        } catch {
            Start-Sleep -Milliseconds 500
        }
    } while ((Get-Date) -lt $deadline)
    throw "SSH tunnel started, but remote ComfyUI did not answer at $url. See $($Config.log_file)"
}

function Start-Tunnel([object]$Config) {
    $running = Get-TunnelProcess $Config
    if ($null -ne $running) {
        Wait-ComfyUI $Config
        Write-Output "$($Config.name): running (PID $($running.Id), http://127.0.0.1:$($Config.local_port))"
        return
    }

    if (-not (Test-Path -LiteralPath $Config.identity_file)) {
        throw "SSH identity file not found: $($Config.identity_file)"
    }
    $ssh = (Get-Command ssh.exe -ErrorAction Stop).Source
    $runtimeDir = Split-Path -Parent $Config.pid_file
    $logDir = Split-Path -Parent $Config.log_file
    New-Item -ItemType Directory -Force -Path $runtimeDir, $logDir | Out-Null

    $forward = "127.0.0.1:$($Config.local_port):127.0.0.1:$($Config.remote_port)"
    $target = "$($Config.ssh_user)@$($Config.host)"
    $arguments = @(
        "-N", "-T",
        "-o", "BatchMode=yes",
        "-o", "ExitOnForwardFailure=yes",
        "-o", "ServerAliveInterval=20",
        "-o", "ServerAliveCountMax=3",
        "-o", "StrictHostKeyChecking=yes",
        "-i", ('"' + $Config.identity_file + '"'),
        "-p", [string]$Config.ssh_port,
        "-L", $forward,
        $target
    )
    $process = Start-Process -FilePath $ssh -ArgumentList $arguments -PassThru -WindowStyle Hidden -RedirectStandardError $Config.log_file
    Set-Content -LiteralPath $Config.pid_file -Value $process.Id -NoNewline
    try {
        Wait-ComfyUI $Config
    } catch {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $Config.pid_file -Force -ErrorAction SilentlyContinue
        throw
    }
    Write-Output "$($Config.name): started (PID $($process.Id), http://127.0.0.1:$($Config.local_port))"
}

function Stop-Tunnel([object]$Config) {
    $running = Get-TunnelProcess $Config
    if ($null -ne $running) {
        Stop-Process -Id $running.Id -Force
        $running.WaitForExit(5000) | Out-Null
    }
    Remove-Item -LiteralPath $Config.pid_file -Force -ErrorAction SilentlyContinue
    Write-Output "$($Config.name): stopped"
}

$nodeConfig = Read-NodeConfig
switch ($Action) {
    "Start" { Start-Tunnel $nodeConfig }
    "Stop" { Stop-Tunnel $nodeConfig }
    "Restart" { Stop-Tunnel $nodeConfig; Start-Tunnel $nodeConfig }
    "Status" {
        $process = Get-TunnelProcess $nodeConfig
        if ($null -eq $process) {
            Write-Output "$($nodeConfig.name): stopped"
            exit 1
        }
        try {
            Wait-ComfyUI $nodeConfig
            Write-Output "$($nodeConfig.name): healthy (PID $($process.Id), http://127.0.0.1:$($nodeConfig.local_port))"
        } catch {
            Write-Output "$($nodeConfig.name): tunnel process exists but ComfyUI is unavailable (PID $($process.Id))"
            exit 2
        }
    }
}

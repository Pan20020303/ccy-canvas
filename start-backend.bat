@echo off
chcp 65001 >nul
echo ========================================
echo   CCY Canvas Backend Startup
echo ========================================

cd /d "C:\ccy迁移\code\ccy-canvas"

echo [1] Loading .env ...
setlocal enabledelayedexpansion

for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
    set "line=%%a"
    if not "!line:~0,1!"=="#" (
        if not "%%a"=="" (
            set "%%a=%%b"
            echo   Set %%a
        )
    )
)

echo.
echo [2] Starting backend API on 0.0.0.0:9090 ...
echo.

ccy-canvas-api.exe

pause

@echo off
chcp 65001 >nul
echo ========================================
echo   CCY Canvas - Start All Services
echo ========================================

echo.
echo [1] Starting Docker containers (PostgreSQL + Redis) ...
cd /d "C:\ccy迁移\code\ccy-canvas"
docker-compose up -d
timeout /t 5 /nobreak >nul

echo.
echo [2] Starting Nginx ...
cd /d "C:\ccy迁移\nginx"
taskkill /F /IM nginx.exe 2>nul
start "" nginx.exe
timeout /t 2 /nobreak >nul

echo.
echo [3] Starting Backend API ...
cd /d "C:\ccy迁移\code\ccy-canvas"

setlocal enabledelayedexpansion
for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
    set "line=%%a"
    if not "!line:~0,1!"=="#" (
        if not "%%a"=="" (
            set "%%a=%%b"
        )
    )
)

start "" ccy-canvas-api.exe

echo.
echo ========================================
echo   All services started!
echo   Frontend:  http://localhost
echo   API:       http://localhost:9090
echo   LAN:       http://192.168.110.150
echo ========================================
echo.
pause

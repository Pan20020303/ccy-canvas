@echo off
REM CCY Canvas - Stop all running services.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-all.ps1"

@echo off
chcp 65001 >nul
rem ============================================================
rem  Agent Bridge: the DeepSeek Harness runtime for ccy agents.
rem
rem  Go(9090) -> bridge(:39300) -> dsh --profile sdk -> MCP canvas tools
rem
rem  Must stay running: without it, agents flagged
rem  agentRuntime=harness fail loudly with
rem  "智能体桥接服务不可用" (deliberately no silent fallback).
rem  Must run on the same machine as the API: the DSH SDK is stdio-only.
rem
rem  NOTE: keep this file ASCII-only. Non-ASCII text plus escaped
rem  parentheses in echo broke batch parsing once already.
rem ============================================================
cd /d "%~dp0"

echo.
echo [agent-bridge] starting on port 39300 ...

if not exist ".agent-bridge" mkdir ".agent-bridge"

rem Port cleanup lives in Node: netstat/findstr/taskkill inside batch is
rem easy to get wrong, and getting it wrong means the old process survives,
rem the new one cannot bind, and every agent reports the bridge is down.
node scripts\agent-bridge\stop.mjs --port 39300

start "ccy-agent-bridge" /min cmd /c "node scripts\agent-bridge\server.mjs --port 39300 --workspace .agent-bridge >> .agent-bridge\bridge.log 2>&1"

rem Health probing also lives in Node (same reason: reliable exit codes).
node scripts\agent-bridge\healthcheck.mjs --port 39300 --wait 20
if errorlevel 1 (
    echo [agent-bridge] NOT READY - see .agent-bridge\bridge.log
) else (
    echo [agent-bridge] ready - http://127.0.0.1:39300  inspector: /inspector
)

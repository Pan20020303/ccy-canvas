#!/usr/bin/env bash
# Print service status for backend + PostgreSQL.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PID_FILE="run/api.pid"

echo "─── Backend ───────────────────────────────"
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  PID=$(cat "$PID_FILE")
  echo "Status: RUNNING (pid $PID)"
  ps -p "$PID" -o pid,rss,vsz,etime,cmd 2>/dev/null || true
else
  echo "Status: STOPPED"
fi
echo

echo "─── PostgreSQL ────────────────────────────"
if command -v docker >/dev/null 2>&1; then
  STATE=$(docker inspect -f '{{.State.Status}}' ccy-canvas-postgres 2>/dev/null || echo "missing")
  echo "Container: $STATE"
  if [ "$STATE" = "running" ]; then
    docker exec ccy-canvas-postgres pg_isready -U postgres -d ccy_canvas || true
  fi
else
  echo "docker not installed — cannot check"
fi
echo

echo "─── Recent logs (run/api.log tail) ────────"
[ -f run/api.log ] && tail -n 10 run/api.log || echo "(no log file yet)"

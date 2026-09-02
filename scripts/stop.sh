#!/usr/bin/env bash
# Gracefully stop the backend via the /admin/shutdown HTTP endpoint.
# Falls back to SIGTERM if the endpoint is unreachable; force-kills after 25s.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PID_FILE="run/api.pid"
PORT="${CCY_API_PORT:-9090}"

if [ ! -f "$PID_FILE" ]; then
  echo "Not running (no pid file)"; exit 0
fi
PID=$(cat "$PID_FILE")

if ! kill -0 "$PID" 2>/dev/null; then
  echo "Process $PID not found; removing pid file."
  rm -f "$PID_FILE"
  exit 0
fi

echo "Stopping pid $PID (graceful via POST /admin/shutdown, waiting up to 25s) ..."

# Trigger via HTTP (cross-platform, doesn't depend on OS signal quirks).
if curl -s -X POST "http://127.0.0.1:${PORT}/admin/shutdown" --max-time 5 >/dev/null 2>&1; then
  echo "  Shutdown triggered via HTTP."
else
  echo "  HTTP endpoint unreachable — falling back to SIGTERM."
  kill "$PID" || true
fi

for i in $(seq 1 50); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.5
done

if kill -0 "$PID" 2>/dev/null; then
  echo "Force killing pid $PID"
  kill -9 "$PID" || true
fi

rm -f "$PID_FILE"
echo "Stopped."

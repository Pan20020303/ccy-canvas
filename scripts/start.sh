#!/usr/bin/env bash
# Start the backend API as a background process.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PID_FILE="run/api.pid"
LOG_FILE="run/api.log"
BIN="bin/ccy-canvas-api"

mkdir -p run

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Already running (pid $(cat "$PID_FILE"))"
  exit 0
fi

[ -x "$BIN" ] || { echo "Binary $BIN not found — run scripts/install.sh first"; exit 1; }

# Make sure PostgreSQL is up before launching.
if command -v docker >/dev/null 2>&1; then
  docker start ccy-canvas-postgres >/dev/null 2>&1 || true
fi

# Load .env into environment for the backend process.
if [ -f .env ]; then
  set -a; # shellcheck disable=SC1091
  source .env
  set +a
fi

nohup "$BIN" >> "$LOG_FILE" 2>&1 &
echo $! > "$PID_FILE"
sleep 1

if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Started (pid $(cat "$PID_FILE")). Log: $LOG_FILE"
else
  echo "Failed to start — check $LOG_FILE"
  tail -n 30 "$LOG_FILE"
  rm -f "$PID_FILE"
  exit 1
fi

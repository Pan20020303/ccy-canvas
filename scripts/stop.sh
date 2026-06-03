#!/usr/bin/env bash
# Gracefully stop the backend API process.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PID_FILE="run/api.pid"
if [ ! -f "$PID_FILE" ]; then
  echo "Not running (no pid file)"; exit 0
fi
PID=$(cat "$PID_FILE")

if kill -0 "$PID" 2>/dev/null; then
  echo "Stopping pid $PID ..."
  kill "$PID"
  for i in $(seq 1 20); do
    kill -0 "$PID" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$PID" 2>/dev/null; then
    echo "Force killing pid $PID"
    kill -9 "$PID" || true
  fi
fi
rm -f "$PID_FILE"
echo "Stopped."

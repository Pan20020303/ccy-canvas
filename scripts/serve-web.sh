#!/usr/bin/env bash
# SPA-aware static server for dist/ — handles refresh on /app, /admin etc.
# Production should still use nginx (see DEPLOY.md) for caching + reverse-proxy.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${1:-5173}"

[ -d "$ROOT/dist" ] || { echo "dist/ not found — run scripts/build-web.sh first"; exit 1; }

PY=""
if command -v python3 >/dev/null 2>&1; then PY=python3
elif command -v python >/dev/null 2>&1; then PY=python
else
  echo "python not found — install python3, or use nginx instead"
  exit 1
fi

exec "$PY" "$ROOT/scripts/spa_server.py" --port "$PORT" --host 0.0.0.0 --dir "$ROOT/dist"

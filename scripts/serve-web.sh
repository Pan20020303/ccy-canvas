#!/usr/bin/env bash
# Simple static server for dist/ — uses Python's built-in http.server.
# Use for testing only; production should use nginx (see DEPLOY.md).

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${1:-5173}"

[ -d "$ROOT/dist" ] || { echo "dist/ not found — run scripts/build-web.sh first"; exit 1; }

cd "$ROOT/dist"

if command -v python3 >/dev/null 2>&1; then
  echo "Serving dist/ on 0.0.0.0:$PORT (Ctrl+C to stop)"
  python3 -m http.server "$PORT" --bind 0.0.0.0
elif command -v python >/dev/null 2>&1; then
  python -m http.server "$PORT" --bind 0.0.0.0
else
  echo "python not found — install python3, or use nginx instead"
  exit 1
fi

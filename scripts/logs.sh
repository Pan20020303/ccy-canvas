#!/usr/bin/env bash
# Tail backend log; pass --pg for PostgreSQL container log.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ "${1:-}" = "--pg" ]; then
  docker logs -f ccy-canvas-postgres
else
  tail -f "$ROOT/run/api.log"
fi

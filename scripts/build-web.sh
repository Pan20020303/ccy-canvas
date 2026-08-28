#!/usr/bin/env bash
# Build the frontend bundle with VITE_API_BASE_URL injected from .env.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
log()  { echo -e "${GREEN}==>${NC} $*"; }
warn() { echo -e "${YELLOW}!!!${NC} $*"; }

# Source .env to pick up PUBLIC_API_BASE
if [ -f .env ]; then
  # shellcheck disable=SC1091
  set -a; source .env; set +a
fi

API_BASE="${PUBLIC_API_BASE:-}"
if [ -z "$API_BASE" ]; then
  warn "PUBLIC_API_BASE not set in .env — frontend will call API via relative path (assumes same-origin reverse-proxy)."
else
  log "Building frontend with VITE_API_BASE_URL=$API_BASE"
fi

export VITE_API_BASE_URL="$API_BASE"
npm run build

log "Frontend built to dist/"

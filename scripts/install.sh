#!/usr/bin/env bash
# One-shot install/upgrade: starts PG, runs migrations, builds backend + frontend.
# Idempotent — safe to re-run for upgrades.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}==>${NC} $*"; }
warn() { echo -e "${YELLOW}!!!${NC} $*"; }
die()  { echo -e "${RED}xxx${NC} $*"; exit 1; }

# 1. Dependency check ────────────────────────────────────────────────────────
for cmd in go npm docker; do
  command -v "$cmd" >/dev/null 2>&1 || die "Missing dependency: $cmd"
done

# 2. .env bootstrap ──────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  log "Generating .env from .env.example"
  cp .env.example .env
  # auto-generate strong secrets
  if command -v openssl >/dev/null 2>&1; then
    NEW_SESS=$(openssl rand -hex 32)
    NEW_ENC=$(openssl rand -base64 32 | tr -d '\n')
    sed -i.bak "s|SESSION_SECRET=.*|SESSION_SECRET=$NEW_SESS|" .env || true
    sed -i.bak "s|CCY_ENCRYPTION_KEY=.*|CCY_ENCRYPTION_KEY=$NEW_ENC|" .env || true
    rm -f .env.bak
    log "Auto-generated SESSION_SECRET and CCY_ENCRYPTION_KEY"
  else
    warn "openssl not found — please manually edit .env"
  fi
  warn "Edit .env to set PUBLIC_API_BASE to your LAN IP before building frontend."
fi

# 3. Start PostgreSQL (docker-compose) ───────────────────────────────────────
log "Starting PostgreSQL container"
docker compose up -d postgres

log "Waiting for PostgreSQL to be ready"
for i in $(seq 1 30); do
  if docker exec ccy-canvas-postgres pg_isready -U postgres -d ccy_canvas >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# 4. Build backend ───────────────────────────────────────────────────────────
log "Building backend binary"
mkdir -p bin
( cd backend && go build -o ../bin/ccy-canvas-api ./cmd/api )
log "Built bin/ccy-canvas-api ($(stat -c%s bin/ccy-canvas-api 2>/dev/null || stat -f%z bin/ccy-canvas-api) bytes)"

# 5. Install + build frontend ────────────────────────────────────────────────
log "Installing frontend dependencies"
npm install --no-audit --no-fund

bash "$ROOT/scripts/build-web.sh"

log "✅ Install done."
echo
echo "Next steps:"
echo "  1) Confirm .env (especially PUBLIC_API_BASE, SESSION_SECRET, CCY_ENCRYPTION_KEY)"
echo "  2) bash scripts/start.sh   # start backend"
echo "  3) Open http://<server-lan-ip> (with nginx) or http://<server-lan-ip>:5173 (with serve-web.sh)"

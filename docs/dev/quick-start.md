# Quick Start

## Prerequisites

- Docker Desktop
- Go 1.26+
- Node.js 20+
- npm

## One-Command Local Startup

From the repo root:

```powershell
.\scripts\dev-up.ps1
```

This script will:

- create `.env` from `.env.example` if missing
- start PostgreSQL with `docker compose`
- wait until PostgreSQL is healthy
- export backend env vars from `.env`
- run a frontend build precheck
- start the Go API server in the background
- start the Vite dev server in the foreground

## Default Local Endpoints

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:8080`
- PostgreSQL: `localhost:5432`

## Docker Middleware Only

If you only want the local middleware:

```powershell
docker compose up -d postgres
docker compose ps
```

Stop it with:

```powershell
docker compose down
```

If you want to remove the local database volume too:

```powershell
docker compose down -v
```

## Environment

Default local env file:

```env
DATABASE_URL=postgres://postgres:postgres@localhost:5432/ccy_canvas?sslmode=disable
SESSION_SECRET=01234567890123456789012345678901
HTTP_ADDR=:8080
COOKIE_SECURE=false
```

## Notes

- The PostgreSQL schema is initialized from `backend/db/migrations/001_identity_credit.sql`.
- `scripts/dev-up.ps1` starts the backend with `go run ./cmd/api` in a background process.
- For a full auth flow check, follow `docs/dev/auth-verification.md`.

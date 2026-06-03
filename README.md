# CCY Canvas

A node-based generative AI canvas for image / video / text / audio workflows, with multi-vendor model relay, team workspaces, credit accounting, and an admin console.

## Tech Stack

- **Frontend** — React 19, TypeScript, Vite, Zustand, React Flow (`@xyflow/react`), TailwindCSS, Radix UI
- **Backend** — Go, Huma v2, chi router, PostgreSQL (pgx + sqlc), bcrypt session auth
- **Storage** — PostgreSQL, local disk uploads

## Quick Start (Dev)

```bash
# 1. Install deps
npm install
cd backend && go mod download && cd ..

# 2. Start PostgreSQL
docker compose up -d postgres

# 3. Run backend
cp .env.example .env   # edit secrets first
cd backend && go run ./cmd/api

# 4. Run frontend
npm run dev
```

Open <http://localhost:5173>.

## Production Deployment (LAN, ~20 concurrent users)

See [DEPLOY.md](./DEPLOY.md). Quick recipe:

**Linux / macOS:**
```bash
bash scripts/install.sh   # one-shot install / upgrade
vim .env                  # set PUBLIC_API_BASE to your LAN IP
bash scripts/build-web.sh
bash scripts/start.sh
```

**Windows (PowerShell as Administrator):**
```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\install.ps1
notepad .env              # set PUBLIC_API_BASE
powershell -ExecutionPolicy Bypass -File scripts\windows\build-web.ps1
powershell -ExecutionPolicy Bypass -File scripts\windows\start.ps1
```

For production-grade Windows service (auto-restart, log rotation):
```powershell
choco install nssm
powershell -ExecutionPolicy Bypass -File scripts\windows\install-service-nssm.ps1
```

## Project Layout

```
├── backend/             # Go API server
│   ├── cmd/api/         # main entry
│   ├── internal/        # bounded contexts (identity, modelcatalog, workspace, credits)
│   └── db/              # SQL migrations + sqlc queries
├── src/app/             # React app
│   ├── components/      # canvas + admin UI
│   └── store.ts         # Zustand store with persistence
├── scripts/             # deployment scripts
├── docker-compose.yml   # PostgreSQL for dev
└── DEPLOY.md            # production deployment guide
```

## Tests

```bash
npm run test            # frontend (vitest)
cd backend && go test ./...
```

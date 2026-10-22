# Frontend Acceptance Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start the local app stack, verify the auth-to-workspace smoke path is reachable, and hand the user a concrete interaction journey for live acceptance testing.

**Architecture:** Reuse the repository's existing local development workflow so startup behavior matches the documented environment. Validate infrastructure readiness first, then verify backend health and frontend availability before handing off a user test script.

**Tech Stack:** PowerShell, Docker Compose, Go API, Vite, PostgreSQL, existing repo scripts and docs

---

### Task 1: Validate Local Startup Inputs

**Files:**
- Modify: `D:\code\ccy-canvas\docs\superpowers\plans\2026-05-28-frontend-acceptance-run-plan.md`
- Check: `D:\code\ccy-canvas\docs\dev\quick-start.md`
- Check: `D:\code\ccy-canvas\scripts\dev-up.ps1`
- Check: `D:\code\ccy-canvas\.env.example`

- [ ] **Step 1: Read the startup documentation and script**

Run:

```powershell
Get-Content -Path 'docs\dev\quick-start.md'
Get-Content -Path 'scripts\dev-up.ps1'
Get-Content -Path '.env.example'
```

Expected: the documented local flow uses Docker Compose for PostgreSQL, `go run ./cmd/api` for the backend, and `npm run dev` for the frontend.

- [ ] **Step 2: Confirm the repository already has the required inputs**

Run:

```powershell
Test-Path '.env.example'
Test-Path 'scripts\dev-up.ps1'
Test-Path 'package.json'
Test-Path 'backend\go.mod'
```

Expected: all commands return `True`.

### Task 2: Start The Local Stack

**Files:**
- Check: `D:\code\ccy-canvas\docker-compose.yml`
- Check: `D:\code\ccy-canvas\.env`

- [ ] **Step 1: Ensure the local environment file exists**

Run:

```powershell
if (-not (Test-Path '.env')) { Copy-Item '.env.example' '.env' }
Get-Content -Path '.env'
```

Expected: `.env` exists and contains `DATABASE_URL`, `SESSION_SECRET`, `HTTP_ADDR`, and `COOKIE_SECURE`.

- [ ] **Step 2: Start PostgreSQL**

Run:

```powershell
docker compose up -d postgres
docker compose ps
```

Expected: the `postgres` service is listed and transitions to a healthy state.

- [ ] **Step 3: Start the backend in the background**

Run:

```powershell
$envMap = @{}
Get-Content '.env' | ForEach-Object {
  if ($_ -match '^\s*#' -or $_ -match '^\s*$') { return }
  $parts = $_ -split '=', 2
  if ($parts.Length -eq 2) { $envMap[$parts[0]] = $parts[1] }
}
$env:DATABASE_URL = $envMap['DATABASE_URL']
$env:SESSION_SECRET = $envMap['SESSION_SECRET']
$env:HTTP_ADDR = $envMap['HTTP_ADDR']
$env:COOKIE_SECURE = $envMap['COOKIE_SECURE']
Start-Process -FilePath 'go' -ArgumentList 'run ./cmd/api' -WorkingDirectory (Join-Path (Get-Location) 'backend') -WindowStyle Hidden
```

Expected: the command returns without blocking and a backend process starts.

- [ ] **Step 4: Start the frontend development server**

Run:

```powershell
Start-Process -FilePath 'npm' -ArgumentList 'run dev -- --host 127.0.0.1 --port 5173' -WorkingDirectory (Get-Location) -WindowStyle Hidden
```

Expected: the command returns without blocking and a Vite dev server starts on `http://127.0.0.1:5173`.

### Task 3: Verify Reachability Before User Handoff

**Files:**
- Check: `D:\code\ccy-canvas\docs\dev\auth-verification.md`

- [ ] **Step 1: Verify backend health**

Run:

```powershell
Invoke-WebRequest -Uri 'http://127.0.0.1:8080/api/health' -UseBasicParsing | Select-Object -ExpandProperty Content
```

Expected: a JSON response containing a health envelope with an `ok` status.

- [ ] **Step 2: Verify frontend availability**

Run:

```powershell
Invoke-WebRequest -Uri 'http://127.0.0.1:5173' -UseBasicParsing | Select-Object -ExpandProperty StatusCode
```

Expected: `200`.

- [ ] **Step 3: Check the documented auth route expectations**

Run:

```powershell
Get-Content -Path 'docs\dev\auth-verification.md'
```

Expected: the document confirms `/app` should redirect logged-out users to `/login`, and the login/register forms should expose the expected fields.

### Task 4: Hand Off The Acceptance Journey

**Files:**
- Modify: `D:\code\ccy-canvas\docs\superpowers\plans\2026-05-28-frontend-acceptance-run-plan.md`

- [ ] **Step 1: Summarize the active local URLs**

Provide:

```text
Frontend: http://127.0.0.1:5173
Backend: http://127.0.0.1:8080
```

Expected: the user can open the frontend URL directly.

- [ ] **Step 2: Provide a structured user journey for live testing**

Provide:

```text
1. Visit /login and check form state, labels, error handling, and submit behavior.
2. Visit /register and check all fields, invite-code UX, and navigation back to login.
3. Log in with an available account and verify redirect behavior.
4. Enter /app and test navbar, account menu, canvas load, right-click create, connect-to-create, and grouping entry.
5. Attempt /admin with the current account and confirm the permission path behaves as expected.
```

Expected: the user can follow the flow and report issues in order.

## Self-Review

- Spec coverage: this plan covers environment startup, smoke verification, and user-handoff for the exact acceptance flow defined in the spec.
- Placeholder scan: no `TODO`, `TBD`, or undefined execution steps remain.
- Type consistency: all paths, URLs, and command names match the repository docs and current Windows environment.

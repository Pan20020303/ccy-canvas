# Server Error Log Review - 2026-06

## Findings

The supplied server log bundle mainly contains three classes of messages.

### 1. Authentication 401s

Examples:

- `UNAUTHENTICATED: Authentication required`
- `UNAUTHENTICATED: Invalid email or password`

These are expected application-level responses when a browser has no valid
session cookie or a login attempt uses the wrong password. They are not backend
crashes.

### 2. Nginx upstream connection refused / reset

Examples:

- `connect() failed (10061: No connection could be made...) while connecting to upstream`
- `WSARecv() failed (10054: An existing connection was forcibly closed...) while reading response header from upstream`

Root cause: nginx was proxying to `127.0.0.1:9090`, but the API process was not
consistently listening there, or was restarted while clients had in-flight
requests/SSE streams.

Mitigations:

- Keep nginx upstream port aligned with `HTTP_ADDR`.
- Use Redis-backed Asynq queue by setting `REDIS_ADDR`, so generation tasks do
  not depend on one long-lived HTTP request or a detached goroutine.
- Use `/api/health` for backend health checks instead of treating `/api/auth/me`
  401 as a failure.

### 3. Windows nginx process-spawn alert

Example:

- `no more than 60 processes can be spawned`

Root cause: nginx-for-Windows has a low process-spawn ceiling. Using
`worker_processes auto` plus repeated reload/start cycles can exhaust that
ceiling.

Fix:

- Windows nginx generated config now uses `worker_processes 1`.
- If this alert has already happened on a server, stop all residual nginx
  processes before starting again:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\nginx-stop.ps1
powershell -ExecutionPolicy Bypass -File scripts\windows\nginx-start.ps1
```

## Required Server Configuration

For the durable queue/cache path, `.env` must include Redis:

```env
REDIS_ADDR=localhost:6379
REDIS_PASSWORD=
REDIS_DB=0
CHANNEL_POLICY=single
```

Then restart the backend:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\restart.ps1
```

Confirm status:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\status.ps1
```

Expected backend log lines:

```text
[cache] Redis cache enabled
[tasks] Asynq queue enabled
[tasks] Asynq worker starting
listening on ...
```


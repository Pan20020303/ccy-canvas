# Auth Verification

## Environment

Preferred local setup uses Docker for PostgreSQL:

```powershell
docker compose up -d postgres
```

Backend environment variables:

```powershell
$env:DATABASE_URL="postgres://postgres:postgres@localhost:5432/ccy_canvas?sslmode=disable"
$env:SESSION_SECRET="01234567890123456789012345678901"
$env:HTTP_ADDR=":8080"
$env:COOKIE_SECURE="false"
```

## Backend

```powershell
cd backend
go test ./...
go run ./cmd/api
```

Expected:

- `GET http://localhost:8080/api/health` returns an envelope with `status: ok`.

## Frontend

```powershell
npm install
npm run build
npm run dev
```

Expected:

- Visiting `/app` while logged out redirects to `/login`.
- Login form shows email and password fields.
- Register page shows name, email, password, and invitation code fields.

## Admin Invitation Flow

Create the first admin directly in PostgreSQL for local development:

1. Generate a bcrypt hash for a known password using the backend password service or a small Go snippet.
2. Insert the user:

```sql
INSERT INTO users (email, password_hash, name, role)
VALUES ('admin@example.com', '<bcrypt hash>', 'Admin', 'admin');
```

After logging in as admin:

- `POST /api/admin/invitations` returns a plaintext invitation code once.
- Registering with that code creates a member account and a credit account.
- The same single-use invitation cannot be redeemed twice.

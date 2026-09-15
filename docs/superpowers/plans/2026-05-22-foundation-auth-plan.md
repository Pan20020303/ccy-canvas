# Foundation Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the project foundation, invitation-based authentication, protected user/admin routes, and member daily credit account initialization.

**Architecture:** Implement a DDD-style modular monolith in Go under `backend/`, with identity and credit contexts separated from HTTP and PostgreSQL infrastructure. Keep the existing React/Vite user app in `src/`, add real API-backed auth state, and remove the demo-only login behavior from the route boundary.

**Tech Stack:** Go, chi, pgx/v5, sqlc, PostgreSQL, bcrypt, signed HttpOnly session cookie, React, TypeScript, Vite, Zustand, React Router.

---

## Scope Check

The full product spec covers multiple independent subsystems. This first plan implements only the foundation vertical slice:

- Backend project skeleton.
- Database schema for users, invitations, redemptions, and credit accounts.
- Invitation-based registration.
- Email/password login and logout.
- Current-user endpoint.
- Admin invitation creation endpoint.
- Frontend protected routes and redesigned login/register flow.

Follow-up plans should cover:

- Model catalog and NewAPI provider configuration.
- Dynamic parameter schema and pricing rules.
- Generation jobs, credit reservation, settlement, and node running UX.
- Asset library, file manager, project collaboration, and canvas controls.
- Admin dashboard, charts, logs, and audit views.

This plan deliberately produces a working authentication slice that can be tested independently.

## File Structure

Create backend files:

```text
backend/
  go.mod
  sqlc.yaml
  cmd/api/main.go
  db/migrations/001_identity_credit.sql
  db/queries/identity.sql
  internal/shared/apperror/apperror.go
  internal/shared/httpx/json.go
  internal/shared/httpx/middleware.go
  internal/platform/config/config.go
  internal/platform/database/database.go
  internal/platform/password/bcrypt.go
  internal/platform/session/cookie.go
  internal/identity/domain/user.go
  internal/identity/domain/invitation.go
  internal/identity/domain/invitation_test.go
  internal/identity/application/service.go
  internal/identity/infrastructure/postgres_repository.go
  internal/identity/interfaces/http_handler.go
  internal/credits/domain/account.go
  internal/credits/application/service.go
```

Modify frontend files:

```text
package.json
index.html
tsconfig.json
tsconfig.node.json
vite.config.ts
src/app/App.tsx
src/app/routes.tsx
src/app/store.ts
src/app/components/LoginPage.tsx
```

Create frontend files:

```text
src/app/api/client.ts
src/app/auth/AuthProvider.tsx
src/app/auth/ProtectedRoute.tsx
src/app/components/RegisterPage.tsx
```

Do not modify unrelated canvas node behavior in this plan.

## Task 1: Backend Module And Health Endpoint

**Files:**
- Create: `backend/go.mod`
- Create: `backend/cmd/api/main.go`
- Create: `backend/internal/platform/config/config.go`
- Create: `backend/internal/shared/httpx/json.go`
- Create: `backend/internal/shared/httpx/middleware.go`
- Create: `backend/internal/shared/apperror/apperror.go`

- [ ] **Step 1: Create backend module**

Create `backend/go.mod`:

```go
module ccy-canvas/backend

go 1.26

require (
	github.com/go-chi/chi/v5 v5.2.3
	github.com/jackc/pgx/v5 v5.7.6
	github.com/google/uuid v1.6.0
	golang.org/x/crypto v0.41.0
)
```

- [ ] **Step 2: Add typed app errors**

Create `backend/internal/shared/apperror/apperror.go`:

```go
package apperror

import "fmt"

type Code string

const (
	CodeUnauthenticated    Code = "UNAUTHENTICATED"
	CodeForbidden          Code = "FORBIDDEN"
	CodeInvalidInput       Code = "INVALID_INPUT"
	CodeInvitationInvalid  Code = "INVITATION_INVALID"
	CodeEmailAlreadyExists Code = "EMAIL_ALREADY_EXISTS"
	CodeInternal           Code = "INTERNAL"
)

type Error struct {
	Code    Code
	Message string
	Err     error
}

func (e *Error) Error() string {
	if e.Err == nil {
		return string(e.Code) + ": " + e.Message
	}
	return fmt.Sprintf("%s: %s: %v", e.Code, e.Message, e.Err)
}

func (e *Error) Unwrap() error {
	return e.Err
}

func New(code Code, message string) *Error {
	return &Error{Code: code, Message: message}
}

func Wrap(code Code, message string, err error) *Error {
	return &Error{Code: code, Message: message, Err: err}
}
```

- [ ] **Step 3: Add JSON helpers**

Create `backend/internal/shared/httpx/json.go`:

```go
package httpx

import (
	"encoding/json"
	"errors"
	"net/http"

	"ccy-canvas/backend/internal/shared/apperror"
)

type envelope struct {
	Data      any    `json:"data,omitempty"`
	Error     any    `json:"error,omitempty"`
	RequestID string `json:"request_id"`
}

type errorBody struct {
	Code    apperror.Code `json:"code"`
	Message string        `json:"message"`
	Details any           `json:"details,omitempty"`
}

func WriteJSON(w http.ResponseWriter, r *http.Request, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(envelope{
		Data:      data,
		RequestID: RequestIDFrom(r.Context()),
	})
}

func WriteError(w http.ResponseWriter, r *http.Request, err error) {
	status := http.StatusInternalServerError
	body := errorBody{Code: apperror.CodeInternal, Message: "Internal server error"}

	var appErr *apperror.Error
	if errors.As(err, &appErr) {
		body.Code = appErr.Code
		body.Message = appErr.Message
		switch appErr.Code {
		case apperror.CodeUnauthenticated:
			status = http.StatusUnauthorized
		case apperror.CodeForbidden:
			status = http.StatusForbidden
		case apperror.CodeInvalidInput, apperror.CodeInvitationInvalid, apperror.CodeEmailAlreadyExists:
			status = http.StatusBadRequest
		default:
			status = http.StatusInternalServerError
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(envelope{
		Error:     body,
		RequestID: RequestIDFrom(r.Context()),
	})
}

func DecodeJSON(r *http.Request, dst any) error {
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(dst); err != nil {
		return apperror.Wrap(apperror.CodeInvalidInput, "Invalid request body", err)
	}
	return nil
}
```

- [ ] **Step 4: Add request ID middleware**

Create `backend/internal/shared/httpx/middleware.go`:

```go
package httpx

import (
	"context"
	"net/http"

	"github.com/google/uuid"
)

type requestIDKey struct{}

func RequestIDMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestID := r.Header.Get("X-Request-ID")
		if requestID == "" {
			requestID = "req_" + uuid.NewString()
		}
		ctx := context.WithValue(r.Context(), requestIDKey{}, requestID)
		w.Header().Set("X-Request-ID", requestID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func RequestIDFrom(ctx context.Context) string {
	value, _ := ctx.Value(requestIDKey{}).(string)
	if value == "" {
		return "req_unknown"
	}
	return value
}
```

- [ ] **Step 5: Add configuration loader**

Create `backend/internal/platform/config/config.go`:

```go
package config

import (
	"fmt"
	"os"
)

type Config struct {
	HTTPAddr      string
	DatabaseURL   string
	SessionSecret string
	CookieSecure  bool
}

func Load() (Config, error) {
	cfg := Config{
		HTTPAddr:      getenv("HTTP_ADDR", ":8080"),
		DatabaseURL:   os.Getenv("DATABASE_URL"),
		SessionSecret: os.Getenv("SESSION_SECRET"),
		CookieSecure:  getenv("COOKIE_SECURE", "false") == "true",
	}
	if cfg.DatabaseURL == "" {
		return Config{}, fmt.Errorf("DATABASE_URL is required")
	}
	if len(cfg.SessionSecret) < 32 {
		return Config{}, fmt.Errorf("SESSION_SECRET must be at least 32 characters")
	}
	return cfg, nil
}

func getenv(key string, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}
```

- [ ] **Step 6: Add health endpoint**

Create `backend/cmd/api/main.go`:

```go
package main

import (
	"log"
	"net/http"

	"ccy-canvas/backend/internal/platform/config"
	"ccy-canvas/backend/internal/shared/httpx"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatal(err)
	}

	router := chi.NewRouter()
	router.Use(middleware.RealIP)
	router.Use(httpx.RequestIDMiddleware)
	router.Use(middleware.Logger)
	router.Get("/api/health", func(w http.ResponseWriter, r *http.Request) {
		httpx.WriteJSON(w, r, http.StatusOK, map[string]string{"status": "ok"})
	})

	log.Printf("listening on %s", cfg.HTTPAddr)
	if err := http.ListenAndServe(cfg.HTTPAddr, router); err != nil {
		log.Fatal(err)
	}
}
```

- [ ] **Step 7: Verify backend compiles**

Run:

```powershell
cd backend
go mod tidy
go test ./...
```

Expected:

```text
ok or [no test files] for all backend packages
```

- [ ] **Step 8: Commit backend skeleton**

Run:

```powershell
git add backend
git commit -m "feat: add backend API skeleton"
```

## Task 2: Database Schema And sqlc Queries

**Files:**
- Create: `backend/sqlc.yaml`
- Create: `backend/db/migrations/001_identity_credit.sql`
- Create: `backend/db/queries/identity.sql`
- Create: `backend/internal/platform/database/database.go`
- Generated: `backend/internal/platform/database/sqlc/*`

- [ ] **Step 1: Add migration**

Create `backend/db/migrations/001_identity_credit.sql`:

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'member')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  email_verified_at timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash text NOT NULL UNIQUE,
  role text NOT NULL CHECK (role IN ('admin', 'member')),
  initial_daily_quota integer NOT NULL CHECK (initial_daily_quota >= 0),
  max_uses integer NOT NULL CHECK (max_uses > 0),
  used_count integer NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  expires_at timestamptz NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE TABLE invitation_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_id uuid NOT NULL REFERENCES invitations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  email text NOT NULL,
  redeemed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE credit_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id),
  daily_quota integer NOT NULL CHECK (daily_quota >= 0),
  current_balance integer NOT NULL CHECK (current_balance >= 0),
  reset_timezone text NOT NULL DEFAULT 'Asia/Shanghai',
  last_reset_on date NOT NULL DEFAULT CURRENT_DATE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE credit_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  account_id uuid NOT NULL REFERENCES credit_accounts(id),
  type text NOT NULL CHECK (type IN ('daily_reset', 'reserve', 'charge', 'refund', 'admin_adjustment')),
  amount integer NOT NULL,
  balance_after integer NOT NULL,
  generation_job_id uuid,
  model_id uuid,
  reason text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX credit_ledger_entries_user_created_idx ON credit_ledger_entries(user_id, created_at DESC);
CREATE INDEX invitations_created_by_idx ON invitations(created_by, created_at DESC);
```

- [ ] **Step 2: Add sqlc config**

Create `backend/sqlc.yaml`:

```yaml
version: "2"
sql:
  - engine: "postgresql"
    queries: "db/queries"
    schema: "db/migrations"
    gen:
      go:
        package: "sqlc"
        out: "internal/platform/database/sqlc"
        sql_package: "pgx/v5"
        emit_json_tags: true
        emit_interface: false
        emit_empty_slices: true
```

- [ ] **Step 3: Add identity queries**

Create `backend/db/queries/identity.sql`:

```sql
-- name: CreateUser :one
INSERT INTO users (email, password_hash, name, role)
VALUES ($1, $2, $3, $4)
RETURNING id, email, password_hash, name, role, status, email_verified_at, last_login_at, created_at, updated_at;

-- name: GetUserByEmail :one
SELECT id, email, password_hash, name, role, status, email_verified_at, last_login_at, created_at, updated_at
FROM users
WHERE email = $1;

-- name: GetUserByID :one
SELECT id, email, password_hash, name, role, status, email_verified_at, last_login_at, created_at, updated_at
FROM users
WHERE id = $1;

-- name: UpdateUserLastLogin :exec
UPDATE users
SET last_login_at = now(), updated_at = now()
WHERE id = $1;

-- name: CreateInvitation :one
INSERT INTO invitations (code_hash, role, initial_daily_quota, max_uses, expires_at, created_by, note)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING id, code_hash, role, initial_daily_quota, max_uses, used_count, expires_at, created_by, note, created_at, revoked_at;

-- name: GetInvitationByCodeHashForUpdate :one
SELECT id, code_hash, role, initial_daily_quota, max_uses, used_count, expires_at, created_by, note, created_at, revoked_at
FROM invitations
WHERE code_hash = $1
FOR UPDATE;

-- name: IncrementInvitationUse :exec
UPDATE invitations
SET used_count = used_count + 1
WHERE id = $1;

-- name: CreateInvitationRedemption :exec
INSERT INTO invitation_redemptions (invitation_id, user_id, email)
VALUES ($1, $2, $3);

-- name: CreateCreditAccount :one
INSERT INTO credit_accounts (user_id, daily_quota, current_balance)
VALUES ($1, $2, $2)
RETURNING id, user_id, daily_quota, current_balance, reset_timezone, last_reset_on, status, updated_at;

-- name: GetCreditAccountByUserID :one
SELECT id, user_id, daily_quota, current_balance, reset_timezone, last_reset_on, status, updated_at
FROM credit_accounts
WHERE user_id = $1;

-- name: CreateCreditLedgerEntry :exec
INSERT INTO credit_ledger_entries (user_id, account_id, type, amount, balance_after, reason, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7);
```

- [ ] **Step 4: Add database connector**

Create `backend/internal/platform/database/database.go`:

```go
package database

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

func Open(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return pool, nil
}
```

- [ ] **Step 5: Generate sqlc code**

Run:

```powershell
cd backend
go install github.com/sqlc-dev/sqlc/cmd/sqlc@latest
sqlc generate
go test ./...
```

Expected:

```text
internal/platform/database/sqlc contains generated Go files
go test ./... exits successfully
```

- [ ] **Step 6: Commit database foundation**

Run:

```powershell
git add backend/sqlc.yaml backend/db backend/internal/platform/database
git commit -m "feat: add identity database schema"
```

## Task 3: Identity Domain Rules

**Files:**
- Create: `backend/internal/identity/domain/user.go`
- Create: `backend/internal/identity/domain/invitation.go`
- Create: `backend/internal/identity/domain/invitation_test.go`

- [ ] **Step 1: Write invitation domain tests**

Create `backend/internal/identity/domain/invitation_test.go`:

```go
package domain

import (
	"testing"
	"time"
)

func TestInvitationCanBeRedeemed(t *testing.T) {
	invitation := Invitation{
		Role:              RoleMember,
		InitialDailyQuota: 500,
		MaxUses:           1,
		UsedCount:         0,
		ExpiresAt:         time.Now().Add(time.Hour),
	}
	if err := invitation.ValidateRedeemable(time.Now()); err != nil {
		t.Fatalf("expected invitation to be redeemable, got %v", err)
	}
}

func TestInvitationRejectsExpiredCode(t *testing.T) {
	invitation := Invitation{
		Role:              RoleMember,
		InitialDailyQuota: 500,
		MaxUses:           1,
		UsedCount:         0,
		ExpiresAt:         time.Now().Add(-time.Minute),
	}
	err := invitation.ValidateRedeemable(time.Now())
	if err == nil {
		t.Fatal("expected expired invitation to fail")
	}
}

func TestInvitationRejectsUsedUpCode(t *testing.T) {
	invitation := Invitation{
		Role:              RoleMember,
		InitialDailyQuota: 500,
		MaxUses:           1,
		UsedCount:         1,
		ExpiresAt:         time.Now().Add(time.Hour),
	}
	err := invitation.ValidateRedeemable(time.Now())
	if err == nil {
		t.Fatal("expected used-up invitation to fail")
	}
}
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```powershell
cd backend
go test ./internal/identity/domain -run TestInvitation -v
```

Expected:

```text
FAIL with undefined: Invitation
```

- [ ] **Step 3: Add user domain types**

Create `backend/internal/identity/domain/user.go`:

```go
package domain

import (
	"strings"
	"time"
)

type Role string

const (
	RoleAdmin  Role = "admin"
	RoleMember Role = "member"
)

type UserStatus string

const (
	UserStatusActive   UserStatus = "active"
	UserStatusDisabled UserStatus = "disabled"
)

type User struct {
	ID              string
	Email           string
	Name            string
	Role            Role
	Status          UserStatus
	EmailVerifiedAt *time.Time
	LastLoginAt     *time.Time
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

func NormalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

func IsValidRole(role Role) bool {
	return role == RoleAdmin || role == RoleMember
}
```

- [ ] **Step 4: Add invitation domain**

Create `backend/internal/identity/domain/invitation.go`:

```go
package domain

import (
	"time"

	"ccy-canvas/backend/internal/shared/apperror"
)

type Invitation struct {
	ID                string
	CodeHash          string
	Role              Role
	InitialDailyQuota int32
	MaxUses           int32
	UsedCount         int32
	ExpiresAt         time.Time
	RevokedAt         *time.Time
}

func (i Invitation) ValidateRedeemable(now time.Time) error {
	if i.RevokedAt != nil {
		return apperror.New(apperror.CodeInvitationInvalid, "Invitation has been revoked")
	}
	if !now.Before(i.ExpiresAt) {
		return apperror.New(apperror.CodeInvitationInvalid, "Invitation has expired")
	}
	if i.UsedCount >= i.MaxUses {
		return apperror.New(apperror.CodeInvitationInvalid, "Invitation has already been used")
	}
	if !IsValidRole(i.Role) {
		return apperror.New(apperror.CodeInvitationInvalid, "Invitation role is invalid")
	}
	if i.InitialDailyQuota < 0 {
		return apperror.New(apperror.CodeInvitationInvalid, "Invitation quota is invalid")
	}
	return nil
}
```

- [ ] **Step 5: Run domain tests**

Run:

```powershell
cd backend
go test ./internal/identity/domain -v
```

Expected:

```text
PASS
```

- [ ] **Step 6: Commit domain rules**

Run:

```powershell
git add backend/internal/identity/domain
git commit -m "feat: add identity domain rules"
```

## Task 4: Password And Session Infrastructure

**Files:**
- Create: `backend/internal/platform/password/bcrypt.go`
- Create: `backend/internal/platform/session/cookie.go`
- Create: `backend/internal/platform/session/cookie_test.go`

- [ ] **Step 1: Write session round-trip test**

Create `backend/internal/platform/session/cookie_test.go`:

```go
package session

import "testing"

func TestManagerSignsAndParsesSession(t *testing.T) {
	manager := NewManager("01234567890123456789012345678901", false)
	cookie, err := manager.NewCookie("user-1", "admin")
	if err != nil {
		t.Fatalf("NewCookie returned error: %v", err)
	}

	claims, err := manager.Parse(cookie.Value)
	if err != nil {
		t.Fatalf("Parse returned error: %v", err)
	}

	if claims.UserID != "user-1" {
		t.Fatalf("UserID = %q", claims.UserID)
	}
	if claims.Role != "admin" {
		t.Fatalf("Role = %q", claims.Role)
	}
}
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```powershell
cd backend
go test ./internal/platform/session -v
```

Expected:

```text
FAIL with undefined: NewManager
```

- [ ] **Step 3: Add password service**

Create `backend/internal/platform/password/bcrypt.go`:

```go
package password

import "golang.org/x/crypto/bcrypt"

type Service struct {
	cost int
}

func NewService() Service {
	return Service{cost: bcrypt.DefaultCost}
}

func (s Service) Hash(raw string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(raw), s.cost)
	if err != nil {
		return "", err
	}
	return string(hash), nil
}

func (s Service) Compare(hash string, raw string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(raw)) == nil
}
```

- [ ] **Step 4: Add signed cookie session manager**

Create `backend/internal/platform/session/cookie.go`:

```go
package session

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

const CookieName = "ccy_session"

type Claims struct {
	UserID    string `json:"user_id"`
	Role      string `json:"role"`
	ExpiresAt int64  `json:"expires_at"`
}

type Manager struct {
	secret []byte
	secure bool
}

func NewManager(secret string, secure bool) Manager {
	return Manager{secret: []byte(secret), secure: secure}
}

func (m Manager) NewCookie(userID string, role string) (*http.Cookie, error) {
	claims := Claims{
		UserID:    userID,
		Role:      role,
		ExpiresAt: time.Now().Add(7 * 24 * time.Hour).Unix(),
	}
	value, err := m.sign(claims)
	if err != nil {
		return nil, err
	}
	return &http.Cookie{
		Name:     CookieName,
		Value:    value,
		Path:     "/",
		MaxAge:   7 * 24 * 60 * 60,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   m.secure,
	}, nil
}

func (m Manager) ClearCookie() *http.Cookie {
	return &http.Cookie{
		Name:     CookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   m.secure,
	}
}

func (m Manager) Parse(value string) (Claims, error) {
	parts := strings.Split(value, ".")
	if len(parts) != 2 {
		return Claims{}, errors.New("invalid session format")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return Claims{}, err
	}
	expected := m.signature(parts[0])
	if !hmac.Equal([]byte(parts[1]), []byte(expected)) {
		return Claims{}, errors.New("invalid session signature")
	}
	var claims Claims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return Claims{}, err
	}
	if time.Now().Unix() >= claims.ExpiresAt {
		return Claims{}, errors.New("session expired")
	}
	return claims, nil
}

func (m Manager) sign(claims Claims) (string, error) {
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	return encoded + "." + m.signature(encoded), nil
}

func (m Manager) signature(encodedPayload string) string {
	mac := hmac.New(sha256.New, m.secret)
	_, _ = mac.Write([]byte(encodedPayload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
```

- [ ] **Step 5: Run infrastructure tests**

Run:

```powershell
cd backend
go test ./internal/platform/password ./internal/platform/session -v
```

Expected:

```text
PASS
```

- [ ] **Step 6: Commit password and session infrastructure**

Run:

```powershell
git add backend/internal/platform/password backend/internal/platform/session
git commit -m "feat: add password and session infrastructure"
```

## Task 5: Identity Application And HTTP Routes

**Files:**
- Create: `backend/internal/identity/application/service.go`
- Create: `backend/internal/identity/infrastructure/postgres_repository.go`
- Create: `backend/internal/identity/interfaces/http_handler.go`
- Modify: `backend/cmd/api/main.go`
- Create: `backend/internal/credits/domain/account.go`
- Create: `backend/internal/credits/application/service.go`

- [ ] **Step 1: Add credit account domain**

Create `backend/internal/credits/domain/account.go`:

```go
package domain

type Account struct {
	ID             string
	UserID         string
	DailyQuota     int32
	CurrentBalance int32
}
```

- [ ] **Step 2: Add credit account application contract**

Create `backend/internal/credits/application/service.go`:

```go
package application

import "context"

type AccountCreator interface {
	CreateInitialAccount(ctx context.Context, userID string, dailyQuota int32, createdBy *string) error
	GetSummary(ctx context.Context, userID string) (CreditSummary, error)
}

type CreditSummary struct {
	DailyQuota     int32 `json:"daily_quota"`
	CurrentBalance int32 `json:"current_balance"`
	ConsumedToday  int32 `json:"consumed_today"`
}
```

- [ ] **Step 3: Add identity application service**

Create `backend/internal/identity/application/service.go`:

```go
package application

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"strings"
	"time"

	creditapp "ccy-canvas/backend/internal/credits/application"
	"ccy-canvas/backend/internal/identity/domain"
	"ccy-canvas/backend/internal/shared/apperror"
)

type PasswordHasher interface {
	Hash(raw string) (string, error)
	Compare(hash string, raw string) bool
}

type Repository interface {
	CreateUser(ctx context.Context, input CreateUserInput) (UserDTO, error)
	GetUserByEmail(ctx context.Context, email string) (UserWithPasswordDTO, error)
	GetUserByID(ctx context.Context, id string) (UserDTO, error)
	UpdateLastLogin(ctx context.Context, id string) error
	CreateInvitation(ctx context.Context, input CreateInvitationInput) (InvitationDTO, error)
	RedeemInvitation(ctx context.Context, codeHash string, email string, createUser func(role domain.Role, dailyQuota int32) (string, error)) error
}

type Service struct {
	repo      Repository
	password  PasswordHasher
	credits   creditapp.AccountCreator
	now       func() time.Time
}

func NewService(repo Repository, password PasswordHasher, credits creditapp.AccountCreator) Service {
	return Service{repo: repo, password: password, credits: credits, now: time.Now}
}

type CreateUserInput struct {
	Email        string
	PasswordHash string
	Name         string
	Role         domain.Role
}

type CreateInvitationInput struct {
	CodeHash          string
	Role              domain.Role
	InitialDailyQuota int32
	MaxUses           int32
	ExpiresAt         time.Time
	CreatedBy         string
	Note              string
}

type UserDTO struct {
	ID    string      `json:"id"`
	Email string      `json:"email"`
	Name  string      `json:"name"`
	Role  domain.Role `json:"role"`
}

type UserWithPasswordDTO struct {
	UserDTO
	PasswordHash string
	Status       string
}

type InvitationDTO struct {
	ID                string      `json:"id"`
	Code              string      `json:"code,omitempty"`
	Role              domain.Role `json:"role"`
	InitialDailyQuota int32       `json:"initial_daily_quota"`
	MaxUses           int32       `json:"max_uses"`
	ExpiresAt         time.Time   `json:"expires_at"`
}

func (s Service) RegisterByInvite(ctx context.Context, email string, rawPassword string, name string, code string) (UserDTO, error) {
	email = domain.NormalizeEmail(email)
	if email == "" || rawPassword == "" || name == "" || code == "" {
		return UserDTO{}, apperror.New(apperror.CodeInvalidInput, "Email, password, name, and invitation code are required")
	}
	passwordHash, err := s.password.Hash(rawPassword)
	if err != nil {
		return UserDTO{}, apperror.Wrap(apperror.CodeInternal, "Could not hash password", err)
	}

	var created UserDTO
	codeHash := HashInvitationCode(code)
	err = s.repo.RedeemInvitation(ctx, codeHash, email, func(role domain.Role, dailyQuota int32) (string, error) {
		user, err := s.repo.CreateUser(ctx, CreateUserInput{
			Email: email, PasswordHash: passwordHash, Name: strings.TrimSpace(name), Role: role,
		})
		if err != nil {
			return "", err
		}
		created = user
		createdBy := user.ID
		if err := s.credits.CreateInitialAccount(ctx, user.ID, dailyQuota, &createdBy); err != nil {
			return "", err
		}
		return user.ID, nil
	})
	if err != nil {
		return UserDTO{}, err
	}
	return created, nil
}

func (s Service) Login(ctx context.Context, email string, rawPassword string) (UserDTO, error) {
	user, err := s.repo.GetUserByEmail(ctx, domain.NormalizeEmail(email))
	if err != nil {
		return UserDTO{}, apperror.New(apperror.CodeUnauthenticated, "Invalid email or password")
	}
	if user.Status != "active" || !s.password.Compare(user.PasswordHash, rawPassword) {
		return UserDTO{}, apperror.New(apperror.CodeUnauthenticated, "Invalid email or password")
	}
	if err := s.repo.UpdateLastLogin(ctx, user.ID); err != nil {
		return UserDTO{}, err
	}
	return user.UserDTO, nil
}

func (s Service) CurrentUser(ctx context.Context, userID string) (UserDTO, error) {
	return s.repo.GetUserByID(ctx, userID)
}

func (s Service) CreateInvitation(ctx context.Context, role domain.Role, initialDailyQuota int32, maxUses int32, expiresAt time.Time, createdBy string, note string) (InvitationDTO, error) {
	if !domain.IsValidRole(role) {
		return InvitationDTO{}, apperror.New(apperror.CodeInvalidInput, "Invalid role")
	}
	if initialDailyQuota < 0 || maxUses <= 0 || !expiresAt.After(s.now()) {
		return InvitationDTO{}, apperror.New(apperror.CodeInvalidInput, "Invalid invitation settings")
	}
	code, err := GenerateInvitationCode()
	if err != nil {
		return InvitationDTO{}, apperror.Wrap(apperror.CodeInternal, "Could not generate invitation code", err)
	}
	invitation, err := s.repo.CreateInvitation(ctx, CreateInvitationInput{
		CodeHash: HashInvitationCode(code), Role: role, InitialDailyQuota: initialDailyQuota,
		MaxUses: maxUses, ExpiresAt: expiresAt, CreatedBy: createdBy, Note: note,
	})
	if err != nil {
		return InvitationDTO{}, err
	}
	invitation.Code = code
	return invitation, nil
}

func GenerateInvitationCode() (string, error) {
	buf := make([]byte, 12)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return strings.ToUpper(base64.RawURLEncoding.EncodeToString(buf)), nil
}

func HashInvitationCode(code string) string {
	normalized := strings.ToUpper(strings.TrimSpace(code))
	sum := sha256.Sum256([]byte(normalized))
	return hex.EncodeToString(sum[:])
}
```

- [ ] **Step 4: Add PostgreSQL repository**

Create `backend/internal/identity/infrastructure/postgres_repository.go` with repository methods backed by generated sqlc queries. Use `pgxpool.Pool.Begin` in `RedeemInvitation`, fetch the invitation with `FOR UPDATE`, call `domain.Invitation.ValidateRedeemable(time.Now())`, create the user through the callback, increment use count, and create redemption in one transaction.

The key transaction body must match this shape:

```go
tx, err := r.pool.Begin(ctx)
if err != nil {
	return err
}
defer tx.Rollback(ctx)

qtx := r.queries.WithTx(tx)
row, err := qtx.GetInvitationByCodeHashForUpdate(ctx, codeHash)
if err != nil {
	return apperror.New(apperror.CodeInvitationInvalid, "Invitation code is invalid")
}
invitation := domain.Invitation{
	ID: row.ID.String(), CodeHash: row.CodeHash, Role: domain.Role(row.Role),
	InitialDailyQuota: row.InitialDailyQuota, MaxUses: row.MaxUses,
	UsedCount: row.UsedCount, ExpiresAt: row.ExpiresAt.Time,
}
if row.RevokedAt.Valid {
	t := row.RevokedAt.Time
	invitation.RevokedAt = &t
}
if err := invitation.ValidateRedeemable(time.Now()); err != nil {
	return err
}
userID, err := createUser(invitation.Role, invitation.InitialDailyQuota)
if err != nil {
	return err
}
if err := qtx.IncrementInvitationUse(ctx, row.ID); err != nil {
	return err
}
if err := qtx.CreateInvitationRedemption(ctx, sqlc.CreateInvitationRedemptionParams{
	InvitationID: row.ID,
	UserID: pgtype.UUID{Bytes: uuid.MustParse(userID), Valid: true},
	Email: email,
}); err != nil {
	return err
}
return tx.Commit(ctx)
```

- [ ] **Step 5: Add HTTP handler**

Create `backend/internal/identity/interfaces/http_handler.go` with routes:

```go
r.Post("/api/auth/register-by-invite", h.RegisterByInvite)
r.Post("/api/auth/login", h.Login)
r.Post("/api/auth/logout", h.Logout)
r.Get("/api/auth/me", h.Me)
r.Post("/api/admin/invitations", h.RequireAdmin(h.CreateInvitation))
```

Request DTOs:

```go
type registerRequest struct {
	Email string `json:"email"`
	Password string `json:"password"`
	Name string `json:"name"`
	InvitationCode string `json:"invitation_code"`
}

type loginRequest struct {
	Email string `json:"email"`
	Password string `json:"password"`
}

type createInvitationRequest struct {
	Role string `json:"role"`
	InitialDailyQuota int32 `json:"initial_daily_quota"`
	MaxUses int32 `json:"max_uses"`
	ExpiresAt time.Time `json:"expires_at"`
	Note string `json:"note"`
}
```

Each successful login/register response sets the session cookie and returns:

```json
{
  "user": {
    "id": "uuid",
    "email": "person@example.com",
    "name": "Person",
    "role": "member"
  }
}
```

- [ ] **Step 6: Wire routes in main**

Modify `backend/cmd/api/main.go` to:

- Open the pgx pool using `database.Open`.
- Build sqlc queries.
- Build repositories and services.
- Register identity routes.
- Close the pool on shutdown.

The final main setup must follow this order:

```go
cfg, err := config.Load()
ctx := context.Background()
pool, err := database.Open(ctx, cfg.DatabaseURL)
queries := sqlc.New(pool)
sessionManager := session.NewManager(cfg.SessionSecret, cfg.CookieSecure)
passwordService := password.NewService()
```

- [ ] **Step 7: Run backend tests**

Run:

```powershell
cd backend
go test ./...
```

Expected:

```text
PASS
```

- [ ] **Step 8: Commit auth service**

Run:

```powershell
git add backend
git commit -m "feat: add invitation auth API"
```

## Task 6: Frontend Build Foundation And API Client

**Files:**
- Create: `package.json`
- Create: `index.html`
- Create: `tsconfig.json`
- Create: `tsconfig.node.json`
- Create: `vite.config.ts`
- Create: `src/app/api/client.ts`

- [ ] **Step 1: Add frontend package**

Create `package.json`:

```json
{
  "name": "ccy-canvas",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@vitejs/plugin-react": "latest",
    "@xyflow/react": "latest",
    "clsx": "latest",
    "lucide-react": "latest",
    "react": "latest",
    "react-dom": "latest",
    "react-responsive-masonry": "latest",
    "react-router": "latest",
    "tailwind-merge": "latest",
    "zustand": "latest"
  },
  "devDependencies": {
    "typescript": "latest",
    "vite": "latest"
  }
}
```

- [ ] **Step 2: Add Vite entry files**

Create `index.html`:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>橙次元</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["DOM", "DOM.Iterable", "ES2022"],
    "allowJs": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx"
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

Create `tsconfig.node.json`:

```json
{
  "compilerOptions": {
    "composite": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "allowSyntheticDefaultImports": true
  },
  "include": ["vite.config.ts"]
}
```

Create `vite.config.ts`:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:8080"
    }
  }
});
```

- [ ] **Step 3: Add API client**

Create `src/app/api/client.ts`:

```ts
export type ApiUser = {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
};

export type CreditSummary = {
  daily_quota: number;
  current_balance: number;
  consumed_today: number;
};

type Envelope<T> = {
  data?: T;
  error?: { code: string; message: string; details?: unknown };
  request_id: string;
};

export class ApiError extends Error {
  code: string;
  requestId: string;

  constructor(code: string, message: string, requestId: string) {
    super(message);
    this.code = code;
    this.requestId = requestId;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {})
    }
  });
  const body = (await res.json()) as Envelope<T>;
  if (!res.ok || body.error) {
    throw new ApiError(body.error?.code || "HTTP_ERROR", body.error?.message || res.statusText, body.request_id);
  }
  return body.data as T;
}

export const api = {
  me: () => request<{ user: ApiUser; credit_summary?: CreditSummary }>("/api/auth/me"),
  login: (email: string, password: string) =>
    request<{ user: ApiUser }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password })
    }),
  registerByInvite: (input: { email: string; password: string; name: string; invitation_code: string }) =>
    request<{ user: ApiUser }>("/api/auth/register-by-invite", {
      method: "POST",
      body: JSON.stringify(input)
    }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" })
};
```

- [ ] **Step 4: Install and typecheck frontend**

Run:

```powershell
npm install
npm run build
```

Expected:

```text
Vite build completes or reports only pre-existing TypeScript errors from existing MVP files
```

If pre-existing TypeScript errors appear in existing MVP files, record the exact file and message in the commit body.

- [ ] **Step 5: Commit frontend foundation**

Run:

```powershell
git add package.json package-lock.json index.html tsconfig.json tsconfig.node.json vite.config.ts src/app/api
git commit -m "feat: add frontend build foundation"
```

## Task 7: Auth Provider, Protected Routes, Login And Register UI

**Files:**
- Create: `src/app/auth/AuthProvider.tsx`
- Create: `src/app/auth/ProtectedRoute.tsx`
- Create: `src/app/components/RegisterPage.tsx`
- Modify: `src/app/App.tsx`
- Modify: `src/app/routes.tsx`
- Modify: `src/app/components/LoginPage.tsx`
- Modify: `src/app/store.ts`

- [ ] **Step 1: Add auth provider**

Create `src/app/auth/AuthProvider.tsx`:

```tsx
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { api, ApiUser, CreditSummary } from "../api/client";

type AuthContextValue = {
  user: ApiUser | null;
  creditSummary: CreditSummary | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  registerByInvite: (input: { email: string; password: string; name: string; invitation_code: string }) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<ApiUser | null>(null);
  const [creditSummary, setCreditSummary] = useState<CreditSummary | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    try {
      const data = await api.me();
      setUser(data.user);
      setCreditSummary(data.credit_summary || null);
    } catch {
      setUser(null);
      setCreditSummary(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    creditSummary,
    loading,
    login: async (email, password) => {
      const data = await api.login(email, password);
      setUser(data.user);
      await refresh();
    },
    registerByInvite: async (input) => {
      const data = await api.registerByInvite(input);
      setUser(data.user);
      await refresh();
    },
    logout: async () => {
      await api.logout();
      setUser(null);
      setCreditSummary(null);
    },
    refresh
  }), [user, creditSummary, loading]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
```

- [ ] **Step 2: Add protected route**

Create `src/app/auth/ProtectedRoute.tsx`:

```tsx
import { Navigate } from "react-router";
import { useAuth } from "./AuthProvider";

export function ProtectedRoute({ children, adminOnly = false }: { children: React.ReactNode; adminOnly?: boolean }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="w-full h-screen bg-[#0a0a0a] text-neutral-400 flex items-center justify-center text-sm">
        Loading...
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;
  if (adminOnly && user.role !== "admin") return <Navigate to="/app" replace />;
  return <>{children}</>;
}
```

- [ ] **Step 3: Wrap router with AuthProvider**

Modify `src/app/App.tsx`:

```tsx
import { RouterProvider } from "react-router";
import { AuthProvider } from "./auth/AuthProvider";
import { router } from "./routes";

export default function App() {
  return (
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  );
}
```

- [ ] **Step 4: Update routes**

Modify `src/app/routes.tsx` so:

- `/` redirects to `/app`.
- `/app` wraps the current canvas root in `ProtectedRoute`.
- `/admin` is a minimal protected admin screen for this plan.
- `/login` renders `LoginPage`.
- `/register` renders `RegisterPage`.

Route shape:

```tsx
export const router = createBrowserRouter([
  { path: "/", element: <Navigate to="/app" replace /> },
  { path: "/login", Component: LoginPage },
  { path: "/register", Component: RegisterPage },
  {
    path: "/app",
    element: (
      <ProtectedRoute>
        <Root />
      </ProtectedRoute>
    ),
  },
  {
    path: "/admin",
    element: (
      <ProtectedRoute adminOnly>
        <div className="min-h-screen bg-[#0a0a0a] text-neutral-200 p-6">Admin Console</div>
      </ProtectedRoute>
    ),
  },
]);
```

- [ ] **Step 5: Redesign login page**

Modify `src/app/components/LoginPage.tsx` to:

- Remove demo admin checkbox.
- Use `useAuth().login`.
- Provide email and password fields.
- Link to `/register`.

Submit logic:

```tsx
const submit = async (e: React.FormEvent) => {
  e.preventDefault();
  setError("");
  try {
    await login(email, password);
    navigate("/app");
  } catch (err: any) {
    setError(err?.message || "登录失败");
  }
};
```

- [ ] **Step 6: Add register page**

Create `src/app/components/RegisterPage.tsx` with fields:

- Name
- Email
- Password
- Invitation code

Submit logic:

```tsx
const submit = async (e: React.FormEvent) => {
  e.preventDefault();
  setError("");
  try {
    await registerByInvite({ name, email, password, invitation_code: invitationCode });
    navigate("/app");
  } catch (err: any) {
    setError(err?.message || "注册失败");
  }
};
```

- [ ] **Step 7: Remove persisted demo user from store**

Modify `src/app/store.ts`:

- Remove `user`, `login`, and `logout` from the persisted store type.
- Keep canvas, tasks, history, projects, model UI state, shortcuts, and settings.
- Components needing user identity should use `useAuth`.

If a component still imports `user`, `login`, or `logout` from `useStore`, update it in this task to use `useAuth`.

- [ ] **Step 8: Run frontend build**

Run:

```powershell
npm run build
```

Expected:

```text
Build succeeds, or any remaining errors are unrelated existing MVP issues listed in the task notes
```

- [ ] **Step 9: Commit frontend auth**

Run:

```powershell
git add src/app/App.tsx src/app/routes.tsx src/app/auth src/app/components/LoginPage.tsx src/app/components/RegisterPage.tsx src/app/store.ts
git commit -m "feat: add API-backed auth routes"
```

## Task 8: Manual Verification Script

**Files:**
- Create: `docs/dev/auth-verification.md`

- [ ] **Step 1: Add verification doc**

Create `docs/dev/auth-verification.md`:

```markdown
# Auth Verification

## Environment

Backend environment variables:

```powershell
$env:DATABASE_URL="postgres://postgres:postgres@localhost:5432/ccy_canvas?sslmode=disable"
$env:SESSION_SECRET="01234567890123456789012345678901"
$env:HTTP_ADDR=":8080"
```

## Backend

```powershell
cd backend
go test ./...
go run ./cmd/api
```

Expected:

- `GET http://localhost:8080/api/health` returns `{"data":{"status":"ok"}}`.

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

```sql
INSERT INTO users (email, password_hash, name, role)
VALUES ('admin@example.com', '<bcrypt hash generated by backend password service>', 'Admin', 'admin');
```

After logging in as admin:

- `POST /api/admin/invitations` returns a plaintext invitation code once.
- Registering with that code creates a member account and a credit account.
- The same single-use invitation cannot be redeemed twice.
```

- [ ] **Step 2: Run all available checks**

Run:

```powershell
cd backend
go test ./...
cd ..
npm run build
```

Expected:

```text
Backend tests pass.
Frontend build passes or reports only documented pre-existing MVP type errors.
```

- [ ] **Step 3: Commit verification docs**

Run:

```powershell
git add docs/dev/auth-verification.md
git commit -m "docs: add auth verification steps"
```

## Self-Review Checklist

- The plan starts with the required header.
- The scope is limited to foundation auth and credit account initialization.
- The plan avoids model catalog, generation, asset library, and dashboard implementation work.
- Each task has exact files and commands.
- Domain tests exist before domain implementation.
- Session tests exist before session implementation.
- Backend user registration creates a credit account.
- Frontend `/app` is protected.
- Admin-only route protection is represented by `/admin`.
- User-facing API key and local demo auth are removed from this slice.

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

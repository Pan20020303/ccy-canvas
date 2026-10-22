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

-- name: ApplyDailyResetIfDue :one
-- 懒重置:仅当上次重置日期早于账户时区的「今天」时,把余额抬到至少 daily_quota
-- (GREATEST 保留管理员额外加分/未来充值,不冲掉),并把 last_reset_on 推到今天。
-- WHERE 里的日期条件保证并发下只有第一个请求真正更新并拿到行(其余 0 行),
-- 因此账本不会重复记 daily_reset。0 行(pgx.ErrNoRows)= 今日已重置,无需处理。
UPDATE credit_accounts
SET current_balance = GREATEST(current_balance, daily_quota),
    last_reset_on = (now() AT TIME ZONE reset_timezone)::date,
    updated_at = now()
WHERE user_id = $1
  AND last_reset_on < (now() AT TIME ZONE reset_timezone)::date
RETURNING id, user_id, daily_quota, current_balance, reset_timezone, last_reset_on, status, updated_at;

-- name: SumUserCreditsConsumedToday :one
-- 单用户「今日已用」,按账户时区的今天零点起算(与重置口径一致);
-- 只统计真实扣费(reserve/charge),退款不抵消展示值。
SELECT COALESCE(SUM(ABS(l.amount)), 0)::int AS total
FROM credit_ledger_entries l
JOIN credit_accounts a ON a.user_id = l.user_id
WHERE l.user_id = $1
  AND l.type IN ('charge', 'reserve')
  AND l.created_at >= (date_trunc('day', now() AT TIME ZONE a.reset_timezone) AT TIME ZONE a.reset_timezone);

-- name: ListUserCreditLedger :many
-- 用户侧「我的积分明细」:仅本人流水,不含他人信息(邮箱/姓名),按时间倒序分页。
SELECT id, type, amount, balance_after, reason, created_at
FROM credit_ledger_entries
WHERE user_id = $1
ORDER BY created_at DESC
LIMIT $2 OFFSET $3;

-- name: CountUserCreditLedger :one
SELECT COUNT(*)::bigint AS total
FROM credit_ledger_entries
WHERE user_id = $1;

-- name: CreateCreditLedgerEntry :exec
INSERT INTO credit_ledger_entries (user_id, account_id, type, amount, balance_after, reason, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7);

-- ─── Admin: Users ────────────────────────────────────────────────────────────

-- name: ListUsers :many
SELECT u.id, u.email, u.name, u.role, u.status, u.last_login_at, u.created_at,
       COALESCE(ca.daily_quota, 0)::int AS daily_quota,
       COALESCE(ca.current_balance, 0)::int AS current_balance
FROM users u
LEFT JOIN credit_accounts ca ON ca.user_id = u.id
ORDER BY u.created_at DESC;

-- name: UpdateUserRole :one
UPDATE users SET role = $2, updated_at = now() WHERE id = $1
RETURNING id, email, name, role, status, last_login_at, created_at, updated_at;

-- name: UpdateUserStatus :one
UPDATE users SET status = $2, updated_at = now() WHERE id = $1
RETURNING id, email, name, role, status, last_login_at, created_at, updated_at;

-- name: UpdateUserPassword :exec
UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1;

-- name: DeleteUser :exec
DELETE FROM users WHERE id = $1;

-- ─── Admin: Invitations ──────────────────────────────────────────────────────

-- name: ListInvitations :many
SELECT i.id, i.code_hash, i.role, i.initial_daily_quota, i.max_uses, i.used_count,
       i.expires_at, i.created_by, i.note, i.created_at, i.revoked_at,
       u.name AS creator_name
FROM invitations i
LEFT JOIN users u ON u.id = i.created_by
ORDER BY i.created_at DESC;

-- name: RevokeInvitation :one
UPDATE invitations SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL
RETURNING id, code_hash, role, initial_daily_quota, max_uses, used_count, expires_at, created_by, note, created_at, revoked_at;

-- ─── Admin: Stats ────────────────────────────────────────────────────────────

-- name: CountUsers :one
SELECT count(*)::int AS total,
       count(*) FILTER (WHERE role = 'admin')::int AS admins,
       count(*) FILTER (WHERE status = 'active')::int AS active
FROM users;

-- name: CountProviderConfigs :one
SELECT count(*)::int AS total,
       count(*) FILTER (WHERE status = 'enabled')::int AS enabled
FROM provider_configs;

-- name: AdjustCreditBalance :one
UPDATE credit_accounts
SET current_balance = current_balance + $2,
    updated_at = now()
WHERE user_id = $1
RETURNING id, user_id, daily_quota, current_balance, reset_timezone, last_reset_on, status, updated_at;

-- name: AdjustCreditQuota :one
UPDATE credit_accounts
SET daily_quota = $2,
    updated_at = now()
WHERE user_id = $1
RETURNING id, user_id, daily_quota, current_balance, reset_timezone, last_reset_on, status, updated_at;

-- name: SumCreditsConsumedToday :one
SELECT COALESCE(SUM(ABS(amount)), 0)::int AS total
FROM credit_ledger_entries
WHERE type IN ('charge', 'reserve')
  AND created_at >= CURRENT_DATE;

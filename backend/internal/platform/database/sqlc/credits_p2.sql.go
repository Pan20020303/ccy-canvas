// Hand-authored credit queries for per-generation charging (credit
// deduction feature). Kept out of the sqlc-generated identity.sql.go so we
// can iterate without re-running sqlc generate.
//
// Model: a generation RESERVES credits at submit (atomic guarded deduct so
// the balance can never go negative and concurrent submits can't overspend),
// and REFUNDS them if the task ends in a terminal failure. A successful
// generation simply keeps the reserve — the reserve ledger row IS the
// consumption record.

package sqlc

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
)

// ─── Atomic guarded deduct (reserve) ──────────────────────────────────

const deductCreditBalanceIfEnough = `
UPDATE credit_accounts
SET current_balance = current_balance - $2,
    updated_at = now()
WHERE user_id = $1 AND current_balance >= $2
RETURNING id, user_id, daily_quota, current_balance, status
`

type DeductCreditBalanceRow struct {
	ID             pgtype.UUID `json:"id"`
	UserID         pgtype.UUID `json:"user_id"`
	DailyQuota     int32       `json:"daily_quota"`
	CurrentBalance int32       `json:"current_balance"`
	Status         string      `json:"status"`
}

// DeductCreditBalanceIfEnough subtracts amount from the user's balance only
// if the balance covers it. Returns pgx.ErrNoRows when the balance is
// insufficient (or no account exists) — the caller maps that to
// "insufficient credits". The WHERE ... >= guard makes this safe under
// concurrent generations (no read-then-write race, no negative balance).
func (q *Queries) DeductCreditBalanceIfEnough(ctx context.Context, userID pgtype.UUID, amount int32) (DeductCreditBalanceRow, error) {
	row := q.db.QueryRow(ctx, deductCreditBalanceIfEnough, userID, amount)
	var i DeductCreditBalanceRow
	err := row.Scan(&i.ID, &i.UserID, &i.DailyQuota, &i.CurrentBalance, &i.Status)
	return i, err
}

// ─── Admin: credit ledger listing ─────────────────────────────────────

type CreditLedgerRow struct {
	ID           pgtype.UUID        `json:"id"`
	UserID       pgtype.UUID        `json:"user_id"`
	UserName     string             `json:"user_name"`
	UserEmail    string             `json:"user_email"`
	Type         string             `json:"type"`
	Amount       int32              `json:"amount"`
	BalanceAfter int32              `json:"balance_after"`
	Reason       string             `json:"reason"`
	CreatedAt    pgtype.Timestamptz `json:"created_at"`
}

const listCreditLedgerEntries = `
SELECT l.id, l.user_id, u.name, u.email, l.type, l.amount, l.balance_after, l.reason, l.created_at
FROM credit_ledger_entries l
JOIN users u ON u.id = l.user_id
WHERE ($1 = '' OR u.name ILIKE '%' || $1 || '%' OR u.email ILIKE '%' || $1 || '%')
  AND ($2 = '' OR l.type = $2)
ORDER BY l.created_at DESC
LIMIT $3 OFFSET $4
`

type ListCreditLedgerEntriesParams struct {
	UserKeyword string `json:"user_keyword"`
	TypeFilter  string `json:"type_filter"`
	Limit       int32  `json:"limit"`
	Offset      int32  `json:"offset"`
}

func (q *Queries) ListCreditLedgerEntries(ctx context.Context, arg ListCreditLedgerEntriesParams) ([]CreditLedgerRow, error) {
	rows, err := q.db.Query(ctx, listCreditLedgerEntries, arg.UserKeyword, arg.TypeFilter, arg.Limit, arg.Offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []CreditLedgerRow{}
	for rows.Next() {
		var i CreditLedgerRow
		if err := rows.Scan(&i.ID, &i.UserID, &i.UserName, &i.UserEmail, &i.Type, &i.Amount, &i.BalanceAfter, &i.Reason, &i.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	return items, rows.Err()
}

const countCreditLedgerEntries = `
SELECT COUNT(*)
FROM credit_ledger_entries l
JOIN users u ON u.id = l.user_id
WHERE ($1 = '' OR u.name ILIKE '%' || $1 || '%' OR u.email ILIKE '%' || $1 || '%')
  AND ($2 = '' OR l.type = $2)
`

func (q *Queries) CountCreditLedgerEntries(ctx context.Context, userKeyword, typeFilter string) (int64, error) {
	var n int64
	err := q.db.QueryRow(ctx, countCreditLedgerEntries, userKeyword, typeFilter).Scan(&n)
	return n, err
}

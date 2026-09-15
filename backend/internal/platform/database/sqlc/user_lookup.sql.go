// Hand-authored user lookup for collaboration invites (invite by username /
// email). Lives outside the sqlc-generated files (same convention as
// saved_assets.sql.go) so it can be iterated without re-running sqlc generate.

package sqlc

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
)

type UserLookupRow struct {
	ID    pgtype.UUID
	Name  string
	Email string
}

const lookupUsersByNameOrEmail = `
SELECT id, name, email
FROM users
WHERE status = 'active'
  AND (lower(name) = lower($1) OR lower(email) = lower($1))
ORDER BY (lower(email) = lower($1)) DESC
LIMIT $2
`

// LookupUsersByNameOrEmail returns active users whose display name or email
// exactly matches the query (case-insensitive). Email matches rank first.
func (q *Queries) LookupUsersByNameOrEmail(ctx context.Context, query string, limit int32) ([]UserLookupRow, error) {
	rows, err := q.db.Query(ctx, lookupUsersByNameOrEmail, query, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []UserLookupRow{}
	for rows.Next() {
		var i UserLookupRow
		if err := rows.Scan(&i.ID, &i.Name, &i.Email); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	return items, rows.Err()
}

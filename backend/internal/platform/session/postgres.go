package session

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

type PostgresStore struct{ pool *pgxpool.Pool }

func NewPostgresStore(pool *pgxpool.Pool) *PostgresStore { return &PostgresStore{pool: pool} }

func limited(value string, max int) string {
	value = strings.TrimSpace(value)
	runes := []rune(value)
	if len(runes) > max {
		return string(runes[:max])
	}
	return value
}

func (s *PostgresStore) Create(ctx context.Context, entry Entry) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO login_sessions (id,user_id,user_agent,ip_address,expires_at)
		VALUES ($1,$2,$3,$4,$5)`, entry.ID, entry.UserID, limited(entry.UserAgent, 512), limited(entry.IPAddress, 64), entry.ExpiresAt)
	return err
}

func (s *PostgresStore) CreateLegacy(ctx context.Context, entry Entry, legacyKey string) (string, error) {
	var id string
	err := s.pool.QueryRow(ctx, `INSERT INTO login_sessions (id,user_id,user_agent,ip_address,expires_at,legacy_key)
		SELECT $1,$2,$3,$4,$5,$6 FROM users WHERE id=$2 AND legacy_sessions_disabled_at IS NULL
		ON CONFLICT (legacy_key) DO UPDATE SET last_seen_at=now()
		RETURNING id`, entry.ID, entry.UserID, limited(entry.UserAgent, 512), limited(entry.IPAddress, 64), entry.ExpiresAt, legacyKey).Scan(&id)
	return id, err
}

func (s *PostgresStore) Active(ctx context.Context, id, userID string) (bool, error) {
	var active bool
	err := s.pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM login_sessions
		WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now())`, id, userID).Scan(&active)
	if err != nil || !active {
		return active, err
	}
	// Throttle last-activity writes, while revocation takes effect on the next request.
	_, _ = s.pool.Exec(ctx, `UPDATE login_sessions SET last_seen_at=now()
		WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND last_seen_at<now()-interval '5 minutes'`, id, userID)
	return true, nil
}

func (s *PostgresStore) LegacyAllowed(ctx context.Context, userID, legacyKey string) (bool, error) {
	var allowed bool
	err := s.pool.QueryRow(ctx, `SELECT legacy_sessions_disabled_at IS NULL AND NOT EXISTS (
		SELECT 1 FROM login_sessions WHERE user_id=$1 AND legacy_key=$2
		AND (revoked_at IS NOT NULL OR expires_at<=now())
	) FROM users WHERE id=$1`, userID, legacyKey).Scan(&allowed)
	return allowed, err
}

func (s *PostgresStore) List(ctx context.Context, userID string) ([]Entry, error) {
	rows, err := s.pool.Query(ctx, `SELECT id,user_id,user_agent,ip_address,created_at,last_seen_at,expires_at
		FROM login_sessions WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now()
		ORDER BY last_seen_at DESC,created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	entries := []Entry{}
	for rows.Next() {
		var entry Entry
		if err := rows.Scan(&entry.ID, &entry.UserID, &entry.UserAgent, &entry.IPAddress, &entry.CreatedAt, &entry.LastSeenAt, &entry.ExpiresAt); err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	return entries, rows.Err()
}

func (s *PostgresStore) RevokeAndDisableLegacy(ctx context.Context, userID, id string) (bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	command, err := tx.Exec(ctx, `UPDATE login_sessions SET revoked_at=now()
		WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>now()`, id, userID)
	if err != nil {
		return false, err
	}
	if command.RowsAffected() == 0 {
		return false, nil
	}
	_, err = tx.Exec(ctx, `UPDATE users SET legacy_sessions_disabled_at=COALESCE(legacy_sessions_disabled_at,now()) WHERE id=$1`, userID)
	if err != nil {
		return false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return false, err
	}
	return true, nil
}

func (s *PostgresStore) RevokeCurrent(ctx context.Context, userID, id string) error {
	_, err := s.pool.Exec(ctx, `UPDATE login_sessions SET revoked_at=now()
		WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL`, id, userID)
	return err
}

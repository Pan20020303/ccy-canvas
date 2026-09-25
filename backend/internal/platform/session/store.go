package session

import (
	"context"
	"time"
)

// Entry is one browser/device login, not one request or one signed-cookie refresh.
type Entry struct {
	ID         string    `json:"id"`
	UserID     string    `json:"-"`
	UserAgent  string    `json:"user_agent"`
	IPAddress  string    `json:"ip_address"`
	CreatedAt  time.Time `json:"created_at"`
	LastSeenAt time.Time `json:"last_seen_at"`
	ExpiresAt  time.Time `json:"expires_at"`
}

type Store interface {
	Create(context.Context, Entry) error
	CreateLegacy(ctx context.Context, entry Entry, legacyKey string) (string, error)
	Active(ctx context.Context, id, userID string) (bool, error)
	LegacyAllowed(ctx context.Context, userID, legacyKey string) (bool, error)
	List(ctx context.Context, userID string) ([]Entry, error)
	RevokeAndDisableLegacy(ctx context.Context, userID, id string) (bool, error)
	RevokeCurrent(ctx context.Context, userID, id string) error
}

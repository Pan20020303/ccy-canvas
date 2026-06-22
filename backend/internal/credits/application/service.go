package application

import (
	"context"
	"errors"
)

// ErrInsufficientCredits is returned by Reserve when the user's balance
// doesn't cover the requested amount. Callers map it to a user-facing
// "积分不足" error (HTTP 402).
var ErrInsufficientCredits = errors.New("insufficient credits")

type AccountCreator interface {
	CreateInitialAccount(ctx context.Context, userID string, dailyQuota int32, createdBy *string) error
	GetSummary(ctx context.Context, userID string) (CreditSummary, error)
}

// Charger is the per-generation credit hook. Reserve atomically deducts at
// submit (returns ErrInsufficientCredits if the balance can't cover it);
// Refund returns the amount on a terminal failure. A successful generation
// keeps the reserve — no explicit "charge" call is needed.
type Charger interface {
	Reserve(ctx context.Context, userID string, amount int32, reason string) error
	Refund(ctx context.Context, userID string, amount int32, reason string) error
}

type CreditSummary struct {
	DailyQuota     int32 `json:"daily_quota"`
	CurrentBalance int32 `json:"current_balance"`
	ConsumedToday  int32 `json:"consumed_today"`
}

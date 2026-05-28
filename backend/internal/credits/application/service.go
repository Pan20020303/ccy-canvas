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

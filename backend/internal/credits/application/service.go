package application

import (
	"context"
	"errors"
)

// ErrInsufficientCredits is returned by Reserve when the user's balance
// doesn't cover the requested amount. Callers map it to a user-facing
// "积分不足" error (HTTP 402).
var ErrInsufficientCredits = errors.New("insufficient credits")

var (
	ErrInsufficientProjectCredits = errors.New("insufficient project credits")
	ErrMemberQuotaExceeded        = errors.New("project member quota exceeded")
	ErrProjectCreditAccessDenied  = errors.New("project credit access denied")
	ErrInvalidProjectCreditAmount = errors.New("invalid project credit amount")
)

const (
	ChargeScopePersonal = "personal"
	ChargeScopeProject  = "project"
)

type AccountCreator interface {
	CreateInitialAccount(ctx context.Context, userID string, dailyQuota int32, createdBy *string) error
	GetSummary(ctx context.Context, userID string) (CreditSummary, error)
}

// Charger is the per-generation credit hook. Reserve atomically deducts at
// submit (returns ErrInsufficientCredits if the balance can't cover it);
// Refund returns the amount on a terminal failure. A successful generation
// keeps the reserve — no explicit "charge" call is needed.
type Charger interface {
	Reserve(ctx context.Context, userID, projectID string, amount int32, reason string) (string, error)
	Refund(ctx context.Context, userID, projectID, scope string, amount int32, reason string) error
}

type CreditSummary struct {
	DailyQuota     int32 `json:"daily_quota"`
	CurrentBalance int32 `json:"current_balance"`
	ConsumedToday  int32 `json:"consumed_today"`
}

type ProjectCreditMember struct {
	UserID string `json:"uid"`
	Name   string `json:"name"`
	Role   string `json:"role"`
	Quota  *int64 `json:"quota"`
	Used   int64  `json:"used"`
}

type ProjectCreditSummary struct {
	ProjectID          string                `json:"project_id"`
	CurrentBalance     int64                 `json:"current_balance"`
	TotalFunded        int64                 `json:"total_funded"`
	TotalConsumed      int64                 `json:"total_consumed"`
	MyContribution     int64                 `json:"my_contribution"`
	CanManage          bool                  `json:"can_manage"`
	CanTransfer        bool                  `json:"can_transfer"`
	PersonalBalance    int32                 `json:"personal_balance"`
	PersonalDailyQuota int32                 `json:"personal_daily_quota"`
	Members            []ProjectCreditMember `json:"members"`
}

type ProjectCreditLedgerEntry struct {
	ID              string `json:"id"`
	UserID          string `json:"uid,omitempty"`
	UserName        string `json:"user_name,omitempty"`
	Type            string `json:"type"`
	Amount          int64  `json:"amount"`
	BalanceAfter    int64  `json:"balance_after"`
	MemberUsedAfter *int64 `json:"member_used_after,omitempty"`
	Reason          string `json:"reason"`
	CreatedAt       string `json:"created_at"`
}

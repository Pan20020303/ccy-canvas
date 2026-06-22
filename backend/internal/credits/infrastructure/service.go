package infrastructure

import (
	"context"
	"errors"

	creditapp "ccy-canvas/backend/internal/credits/application"
	"ccy-canvas/backend/internal/platform/database/sqlc"
	"ccy-canvas/backend/internal/platform/database/sqlctx"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

type Service struct {
	queries *sqlc.Queries
}

func NewService(queries *sqlc.Queries) Service {
	return Service{queries: queries}
}

func (s Service) CreateInitialAccount(ctx context.Context, userID string, dailyQuota int32, createdBy *string) error {
	queries := s.queries
	if scopedQueries, ok := sqlctx.FromContext(ctx); ok {
		queries = scopedQueries
	}

	userUUID, err := uuid.Parse(userID)
	if err != nil {
		return err
	}

	account, err := queries.CreateCreditAccount(ctx, sqlc.CreateCreditAccountParams{
		UserID:     pgtype.UUID{Bytes: userUUID, Valid: true},
		DailyQuota: dailyQuota,
	})
	if err != nil {
		return err
	}

	var createdByUUID pgtype.UUID
	if createdBy != nil && *createdBy != "" {
		parsed, err := uuid.Parse(*createdBy)
		if err != nil {
			return err
		}
		createdByUUID = pgtype.UUID{Bytes: parsed, Valid: true}
	}

	return queries.CreateCreditLedgerEntry(ctx, sqlc.CreateCreditLedgerEntryParams{
		UserID:       pgtype.UUID{Bytes: userUUID, Valid: true},
		AccountID:    account.ID,
		Type:         "daily_reset",
		Amount:       dailyQuota,
		BalanceAfter: dailyQuota,
		Reason:       "initial account creation",
		CreatedBy:    createdByUUID,
	})
}

// Reserve atomically deducts amount from the user's balance at generation
// submit. Returns creditapp.ErrInsufficientCredits when the balance can't
// cover it (guarded UPDATE — safe under concurrent submits, never negative).
func (s Service) Reserve(ctx context.Context, userID string, amount int32, reason string) error {
	if amount <= 0 {
		return nil
	}
	queries := s.queries
	if scopedQueries, ok := sqlctx.FromContext(ctx); ok {
		queries = scopedQueries
	}
	userUUID, err := uuid.Parse(userID)
	if err != nil {
		return err
	}
	uid := pgtype.UUID{Bytes: userUUID, Valid: true}
	row, err := queries.DeductCreditBalanceIfEnough(ctx, uid, amount)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return creditapp.ErrInsufficientCredits
		}
		return err
	}
	// Ledger is best-effort audit; the balance deduction above is authoritative.
	_ = queries.CreateCreditLedgerEntry(ctx, sqlc.CreateCreditLedgerEntryParams{
		UserID:       uid,
		AccountID:    row.ID,
		Type:         "reserve",
		Amount:       amount,
		BalanceAfter: row.CurrentBalance,
		Reason:       reason,
	})
	return nil
}

// Refund returns amount to the user's balance after a terminal generation
// failure (reverses an earlier Reserve).
func (s Service) Refund(ctx context.Context, userID string, amount int32, reason string) error {
	if amount <= 0 {
		return nil
	}
	queries := s.queries
	if scopedQueries, ok := sqlctx.FromContext(ctx); ok {
		queries = scopedQueries
	}
	userUUID, err := uuid.Parse(userID)
	if err != nil {
		return err
	}
	uid := pgtype.UUID{Bytes: userUUID, Valid: true}
	acct, err := queries.AdjustCreditBalance(ctx, sqlc.AdjustCreditBalanceParams{
		UserID:         uid,
		CurrentBalance: amount, // delta: + amount
	})
	if err != nil {
		return err
	}
	_ = queries.CreateCreditLedgerEntry(ctx, sqlc.CreateCreditLedgerEntryParams{
		UserID:       uid,
		AccountID:    acct.ID,
		Type:         "refund",
		Amount:       amount,
		BalanceAfter: acct.CurrentBalance,
		Reason:       reason,
	})
	return nil
}

func (s Service) GetSummary(ctx context.Context, userID string) (creditapp.CreditSummary, error) {
	queries := s.queries
	if scopedQueries, ok := sqlctx.FromContext(ctx); ok {
		queries = scopedQueries
	}

	userUUID, err := uuid.Parse(userID)
	if err != nil {
		return creditapp.CreditSummary{}, err
	}

	account, err := queries.GetCreditAccountByUserID(ctx, pgtype.UUID{Bytes: userUUID, Valid: true})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return creditapp.CreditSummary{}, nil
		}
		return creditapp.CreditSummary{}, err
	}

	return creditapp.CreditSummary{
		DailyQuota:     account.DailyQuota,
		CurrentBalance: account.CurrentBalance,
		ConsumedToday:  account.DailyQuota - account.CurrentBalance,
	}, nil
}

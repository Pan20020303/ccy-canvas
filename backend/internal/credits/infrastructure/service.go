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

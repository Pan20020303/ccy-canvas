package infrastructure

import (
	"context"
	"errors"
	"time"

	"ccy-canvas/backend/internal/identity/application"
	"ccy-canvas/backend/internal/identity/domain"
	"ccy-canvas/backend/internal/platform/database/sqlc"
	"ccy-canvas/backend/internal/platform/database/sqlctx"
	"ccy-canvas/backend/internal/shared/apperror"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

type Repository struct {
	pool    *pgxpool.Pool
	queries *sqlc.Queries
}

func NewRepository(pool *pgxpool.Pool, queries *sqlc.Queries) Repository {
	return Repository{pool: pool, queries: queries}
}

func (r Repository) CreateUser(ctx context.Context, input application.CreateUserInput) (application.UserDTO, error) {
	queries := r.queries
	if scopedQueries, ok := sqlctx.FromContext(ctx); ok {
		queries = scopedQueries
	}

	row, err := queries.CreateUser(ctx, sqlc.CreateUserParams{
		Email:        input.Email,
		PasswordHash: input.PasswordHash,
		Name:         input.Name,
		Role:         string(input.Role),
	})
	if err != nil {
		if isUniqueViolation(err) {
			return application.UserDTO{}, apperror.New(apperror.CodeEmailAlreadyExists, "Email already exists")
		}
		return application.UserDTO{}, apperror.Wrap(apperror.CodeInternal, "Could not create user", err)
	}
	return toUserDTO(row), nil
}

func (r Repository) GetUserByEmail(ctx context.Context, email string) (application.UserWithPasswordDTO, error) {
	row, err := r.queries.GetUserByEmail(ctx, email)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return application.UserWithPasswordDTO{}, err
		}
		return application.UserWithPasswordDTO{}, apperror.Wrap(apperror.CodeInternal, "Could not load user", err)
	}
	return application.UserWithPasswordDTO{
		UserDTO:      toUserDTO(row),
		PasswordHash: row.PasswordHash,
		Status:       row.Status,
	}, nil
}

func (r Repository) GetUserByID(ctx context.Context, id string) (application.UserDTO, error) {
	userID, err := parseUUID(id)
	if err != nil {
		return application.UserDTO{}, apperror.New(apperror.CodeInvalidInput, "Invalid user ID")
	}
	row, err := r.queries.GetUserByID(ctx, userID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return application.UserDTO{}, apperror.New(apperror.CodeUnauthenticated, "User not found")
		}
		return application.UserDTO{}, apperror.Wrap(apperror.CodeInternal, "Could not load user", err)
	}
	return toUserDTO(row), nil
}

func (r Repository) UpdateLastLogin(ctx context.Context, id string) error {
	userID, err := parseUUID(id)
	if err != nil {
		return apperror.New(apperror.CodeInvalidInput, "Invalid user ID")
	}
	if err := r.queries.UpdateUserLastLogin(ctx, userID); err != nil {
		return apperror.Wrap(apperror.CodeInternal, "Could not update last login", err)
	}
	return nil
}

func (r Repository) CreateInvitation(ctx context.Context, input application.CreateInvitationInput) (application.InvitationDTO, error) {
	createdBy, err := parseUUID(input.CreatedBy)
	if err != nil {
		return application.InvitationDTO{}, apperror.New(apperror.CodeInvalidInput, "Invalid creator ID")
	}
	row, err := r.queries.CreateInvitation(ctx, sqlc.CreateInvitationParams{
		CodeHash:          input.CodeHash,
		Role:              string(input.Role),
		InitialDailyQuota: input.InitialDailyQuota,
		MaxUses:           input.MaxUses,
		ExpiresAt:         pgtype.Timestamptz{Time: input.ExpiresAt, Valid: true},
		CreatedBy:         createdBy,
		Note:              input.Note,
	})
	if err != nil {
		return application.InvitationDTO{}, apperror.Wrap(apperror.CodeInternal, "Could not create invitation", err)
	}
	return application.InvitationDTO{
		ID:                uuidFromPg(row.ID),
		Role:              domain.Role(row.Role),
		InitialDailyQuota: row.InitialDailyQuota,
		MaxUses:           row.MaxUses,
		ExpiresAt:         row.ExpiresAt.Time,
	}, nil
}

func (r Repository) RedeemInvitation(ctx context.Context, codeHash string, email string, createUser func(ctx context.Context, role domain.Role, dailyQuota int32) (string, error)) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return apperror.Wrap(apperror.CodeInternal, "Could not start transaction", err)
	}
	defer tx.Rollback(ctx)

	qtx := r.queries.WithTx(tx)
	row, err := qtx.GetInvitationByCodeHashForUpdate(ctx, codeHash)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return apperror.New(apperror.CodeInvitationInvalid, "Invitation code is invalid")
		}
		return apperror.Wrap(apperror.CodeInternal, "Could not load invitation", err)
	}

	invitation := domain.Invitation{
		ID:                uuidFromPg(row.ID),
		CodeHash:          row.CodeHash,
		Role:              domain.Role(row.Role),
		InitialDailyQuota: row.InitialDailyQuota,
		MaxUses:           row.MaxUses,
		UsedCount:         row.UsedCount,
		ExpiresAt:         row.ExpiresAt.Time,
	}
	if row.RevokedAt.Valid {
		revokedAt := row.RevokedAt.Time
		invitation.RevokedAt = &revokedAt
	}
	if err := invitation.ValidateRedeemable(time.Now()); err != nil {
		return err
	}

	txCtx := sqlctx.WithQueries(ctx, qtx)
	userID, err := createUser(txCtx, invitation.Role, invitation.InitialDailyQuota)
	if err != nil {
		return err
	}

	if err := qtx.IncrementInvitationUse(ctx, row.ID); err != nil {
		return apperror.Wrap(apperror.CodeInternal, "Could not update invitation usage", err)
	}

	userUUID, err := parseUUID(userID)
	if err != nil {
		return apperror.New(apperror.CodeInvalidInput, "Invalid user ID")
	}
	if err := qtx.CreateInvitationRedemption(ctx, sqlc.CreateInvitationRedemptionParams{
		InvitationID: row.ID,
		UserID:       userUUID,
		Email:        email,
	}); err != nil {
		return apperror.Wrap(apperror.CodeInternal, "Could not create invitation redemption", err)
	}

	if err := tx.Commit(ctx); err != nil {
		return apperror.Wrap(apperror.CodeInternal, "Could not commit invitation redemption", err)
	}
	return nil
}

func toUserDTO(row sqlc.User) application.UserDTO {
	return application.UserDTO{
		ID:    uuidFromPg(row.ID),
		Email: row.Email,
		Name:  row.Name,
		Role:  domain.Role(row.Role),
	}
}

func parseUUID(value string) (pgtype.UUID, error) {
	parsed, err := uuid.Parse(value)
	if err != nil {
		return pgtype.UUID{}, err
	}
	return pgtype.UUID{Bytes: parsed, Valid: true}, nil
}

func uuidFromPg(value pgtype.UUID) string {
	if !value.Valid {
		return ""
	}
	uuidValue, err := uuid.FromBytes(value.Bytes[:])
	if err != nil {
		return ""
	}
	return uuidValue.String()
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

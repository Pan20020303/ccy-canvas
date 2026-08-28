package infrastructure

import (
	"context"
	"encoding/json"
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

// WithTx runs fn inside a single transaction, exposing the tx-scoped queries
// via the context (sqlctx) so repo and credits calls inside fn share the tx
// and commit/roll back together. Mirrors the wiring used by RedeemInvitation.
func (r Repository) WithTx(ctx context.Context, fn func(txCtx context.Context) error) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return apperror.Wrap(apperror.CodeInternal, "Could not start transaction", err)
	}
	defer tx.Rollback(ctx)

	txCtx := sqlctx.WithQueries(ctx, r.queries.WithTx(tx))
	if err := fn(txCtx); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return apperror.Wrap(apperror.CodeInternal, "Could not commit transaction", err)
	}
	return nil
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
			return application.UserWithPasswordDTO{}, apperror.New(apperror.CodeNotFound, "User not found")
		}
		return application.UserWithPasswordDTO{}, apperror.Wrap(apperror.CodeInternal, "Could not load user", err)
	}
	result := application.UserWithPasswordDTO{
		UserDTO:      toUserDTO(row),
		PasswordHash: row.PasswordHash,
		Status:       row.Status,
	}
	result.UserDTO, err = r.loadUserProfile(ctx, result.UserDTO)
	if err != nil {
		return application.UserWithPasswordDTO{}, err
	}
	return result, nil
}

func (r Repository) GetUserByOAuth(ctx context.Context, provider string, providerUserID string) (application.UserWithPasswordDTO, error) {
	const query = `
SELECT u.id, u.email, u.password_hash, u.name, u.role, u.status, u.email_verified_at, u.last_login_at, u.created_at, u.updated_at
FROM user_oauth_accounts oa
JOIN users u ON u.id = oa.user_id
WHERE oa.provider = $1 AND oa.provider_user_id = $2
LIMIT 1`
	var row sqlc.User
	err := r.pool.QueryRow(ctx, query, provider, providerUserID).Scan(
		&row.ID,
		&row.Email,
		&row.PasswordHash,
		&row.Name,
		&row.Role,
		&row.Status,
		&row.EmailVerifiedAt,
		&row.LastLoginAt,
		&row.CreatedAt,
		&row.UpdatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return application.UserWithPasswordDTO{}, apperror.New(apperror.CodeNotFound, "OAuth account not found")
		}
		return application.UserWithPasswordDTO{}, apperror.Wrap(apperror.CodeInternal, "Could not load OAuth account", err)
	}
	result := application.UserWithPasswordDTO{
		UserDTO:      toUserDTO(row),
		PasswordHash: row.PasswordHash,
		Status:       row.Status,
	}
	result.UserDTO, err = r.loadUserProfile(ctx, result.UserDTO)
	if err != nil {
		return application.UserWithPasswordDTO{}, err
	}
	return result, nil
}

func (r Repository) LinkOAuthAccount(ctx context.Context, userID string, provider string, providerUserID string, email string) error {
	userUUID, err := parseUUID(userID)
	if err != nil {
		return apperror.New(apperror.CodeInvalidInput, "Invalid user ID")
	}
	const query = `
INSERT INTO user_oauth_accounts (user_id, provider, provider_user_id, email)
VALUES ($1, $2, $3, $4)
ON CONFLICT (provider, provider_user_id) DO NOTHING`
	tag, err := r.pool.Exec(ctx, query, userUUID, provider, providerUserID, email)
	if err != nil {
		if isUniqueViolation(err) {
			return apperror.New(apperror.CodeEmailAlreadyExists, "OAuth account is already linked")
		}
		return apperror.Wrap(apperror.CodeInternal, "Could not link OAuth account", err)
	}
	if tag.RowsAffected() > 0 {
		return nil
	}
	existing, err := r.GetUserByOAuth(ctx, provider, providerUserID)
	if err == nil && existing.ID == userID {
		return nil
	}
	if err != nil && !isAppNotFound(err) {
		return err
	}
	return apperror.New(apperror.CodeEmailAlreadyExists, "OAuth account is already linked")
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
	return r.loadUserProfile(ctx, toUserDTO(row))
}

func (r Repository) UpdateUserProfile(ctx context.Context, input application.UpdateProfileInput) (application.UserDTO, error) {
	userID, err := parseUUID(input.UserID)
	if err != nil {
		return application.UserDTO{}, apperror.New(apperror.CodeInvalidInput, "Invalid user ID")
	}
	socials, err := json.Marshal(input.Socials)
	if err != nil {
		return application.UserDTO{}, apperror.New(apperror.CodeInvalidInput, "Invalid social links")
	}

	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return application.UserDTO{}, apperror.Wrap(apperror.CodeInternal, "Could not start profile update", err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `UPDATE users SET name = $2, updated_at = now() WHERE id = $1`, userID, input.Name); err != nil {
		return application.UserDTO{}, apperror.Wrap(apperror.CodeInternal, "Could not update profile name", err)
	}
	_, err = tx.Exec(ctx, `
INSERT INTO user_profiles (user_id, username, avatar_url, headline, bio, location, socials)
VALUES ($1, NULLIF($2, ''), $3, $4, $5, $6, $7::jsonb)
ON CONFLICT (user_id) DO UPDATE SET
    username = NULLIF(EXCLUDED.username, ''),
    avatar_url = EXCLUDED.avatar_url,
    headline = EXCLUDED.headline,
    bio = EXCLUDED.bio,
    location = EXCLUDED.location,
    socials = EXCLUDED.socials,
    updated_at = now()`, userID, input.Username, input.Avatar, input.Headline, input.Bio, input.Location, socials)
	if err != nil {
		if isUniqueViolation(err) {
			return application.UserDTO{}, apperror.New(apperror.CodeConflict, "Username is already in use")
		}
		return application.UserDTO{}, apperror.Wrap(apperror.CodeInternal, "Could not update user profile", err)
	}
	if err = tx.Commit(ctx); err != nil {
		return application.UserDTO{}, apperror.Wrap(apperror.CodeInternal, "Could not commit profile update", err)
	}
	return r.GetUserByID(ctx, input.UserID)
}

func (r Repository) loadUserProfile(ctx context.Context, user application.UserDTO) (application.UserDTO, error) {
	userID, err := parseUUID(user.ID)
	if err != nil {
		return application.UserDTO{}, apperror.New(apperror.CodeInternal, "Could not load user profile")
	}
	var socials []byte
	err = r.pool.QueryRow(ctx, `
SELECT COALESCE(username, ''), avatar_url, headline, bio, location, socials
FROM user_profiles
WHERE user_id = $1`, userID).Scan(&user.Username, &user.Avatar, &user.Headline, &user.Bio, &user.Location, &socials)
	if errors.Is(err, pgx.ErrNoRows) {
		return user, nil
	}
	if err != nil {
		return application.UserDTO{}, apperror.Wrap(apperror.CodeInternal, "Could not load user profile", err)
	}
	if len(socials) > 0 {
		if err := json.Unmarshal(socials, &user.Socials); err != nil {
			return application.UserDTO{}, apperror.Wrap(apperror.CodeInternal, "Could not decode user profile", err)
		}
	}
	return user, nil
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

func isAppNotFound(err error) bool {
	var appErr *apperror.Error
	return errors.As(err, &appErr) && appErr.Code == apperror.CodeNotFound
}

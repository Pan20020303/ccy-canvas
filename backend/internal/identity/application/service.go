package application

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	creditapp "ccy-canvas/backend/internal/credits/application"
	"ccy-canvas/backend/internal/identity/domain"
	"ccy-canvas/backend/internal/shared/apperror"
)

type PasswordHasher interface {
	Hash(raw string) (string, error)
	Compare(hash string, raw string) bool
}

type Repository interface {
	CreateUser(ctx context.Context, input CreateUserInput) (UserDTO, error)
	GetUserByEmail(ctx context.Context, email string) (UserWithPasswordDTO, error)
	GetUserByID(ctx context.Context, id string) (UserDTO, error)
	GetUserByOAuth(ctx context.Context, provider string, providerUserID string) (UserWithPasswordDTO, error)
	LinkOAuthAccount(ctx context.Context, userID string, provider string, providerUserID string, email string) error
	UpdateLastLogin(ctx context.Context, id string) error
	CreateInvitation(ctx context.Context, input CreateInvitationInput) (InvitationDTO, error)
	RedeemInvitation(ctx context.Context, codeHash string, email string, createUser func(ctx context.Context, role domain.Role, dailyQuota int32) (string, error)) error
}

const DefaultDailyQuota int32 = 100

type Service struct {
	repo              Repository
	password          PasswordHasher
	credits           creditapp.AccountCreator
	now               func() time.Time
	defaultDailyQuota int32
}

func NewService(repo Repository, password PasswordHasher, credits creditapp.AccountCreator) Service {
	return Service{repo: repo, password: password, credits: credits, now: time.Now, defaultDailyQuota: DefaultDailyQuota}
}

func (s Service) WithDefaultDailyQuota(quota int32) Service {
	if quota >= 0 {
		s.defaultDailyQuota = quota
	}
	return s
}

type CreateUserInput struct {
	Email        string
	PasswordHash string
	Name         string
	Role         domain.Role
}

type CreateInvitationInput struct {
	CodeHash          string
	Role              domain.Role
	InitialDailyQuota int32
	MaxUses           int32
	ExpiresAt         time.Time
	CreatedBy         string
	Note              string
}

type UserDTO struct {
	ID    string      `json:"id"`
	Email string      `json:"email"`
	Name  string      `json:"name"`
	Role  domain.Role `json:"role"`
}

type UserWithPasswordDTO struct {
	UserDTO
	PasswordHash string
	Status       string
}

type InvitationDTO struct {
	ID                string      `json:"id"`
	Code              string      `json:"code,omitempty"`
	Role              domain.Role `json:"role"`
	InitialDailyQuota int32       `json:"initial_daily_quota"`
	MaxUses           int32       `json:"max_uses"`
	ExpiresAt         time.Time   `json:"expires_at"`
}

type OAuthLoginInput struct {
	Provider       string
	ProviderUserID string
	Email          string
	Name           string
	EmailVerified  bool
}

func (s Service) RegisterByInvite(ctx context.Context, email string, rawPassword string, name string, code string) (UserDTO, error) {
	return s.Register(ctx, email, rawPassword, name, code)
}

func (s Service) Register(ctx context.Context, email string, rawPassword string, name string, code string) (UserDTO, error) {
	email = domain.NormalizeEmail(email)
	trimmedName := strings.TrimSpace(name)
	trimmedCode := strings.TrimSpace(code)
	if email == "" || rawPassword == "" || trimmedName == "" {
		return UserDTO{}, apperror.New(apperror.CodeInvalidInput, "Email, password, and name are required")
	}
	passwordHash, err := s.password.Hash(rawPassword)
	if err != nil {
		return UserDTO{}, apperror.Wrap(apperror.CodeInternal, "Could not hash password", err)
	}

	if trimmedCode == "" {
		user, err := s.repo.CreateUser(ctx, CreateUserInput{
			Email:        email,
			PasswordHash: passwordHash,
			Name:         trimmedName,
			Role:         domain.RoleMember,
		})
		if err != nil {
			return UserDTO{}, err
		}
		createdBy := user.ID
		if err := s.credits.CreateInitialAccount(ctx, user.ID, s.defaultDailyQuota, &createdBy); err != nil {
			return UserDTO{}, apperror.Wrap(apperror.CodeInternal, "Could not create credit account", err)
		}
		return user, nil
	}

	var created UserDTO
	codeHash := HashInvitationCode(trimmedCode)
	err = s.repo.RedeemInvitation(ctx, codeHash, email, func(txCtx context.Context, role domain.Role, dailyQuota int32) (string, error) {
		user, err := s.repo.CreateUser(txCtx, CreateUserInput{
			Email:        email,
			PasswordHash: passwordHash,
			Name:         trimmedName,
			Role:         role,
		})
		if err != nil {
			return "", err
		}
		created = user
		createdBy := user.ID
		if err := s.credits.CreateInitialAccount(txCtx, user.ID, dailyQuota, &createdBy); err != nil {
			return "", err
		}
		return user.ID, nil
	})
	if err != nil {
		return UserDTO{}, err
	}
	return created, nil
}

func (s Service) LoginWithOAuth(ctx context.Context, input OAuthLoginInput) (UserDTO, error) {
	provider := strings.ToLower(strings.TrimSpace(input.Provider))
	providerUserID := strings.TrimSpace(input.ProviderUserID)
	email := domain.NormalizeEmail(input.Email)
	name := strings.TrimSpace(input.Name)
	if provider == "" || providerUserID == "" || email == "" {
		return UserDTO{}, apperror.New(apperror.CodeInvalidInput, "OAuth provider, user ID, and email are required")
	}
	if !input.EmailVerified {
		return UserDTO{}, apperror.New(apperror.CodeInvalidInput, "OAuth email must be verified")
	}

	oauthUser, err := s.repo.GetUserByOAuth(ctx, provider, providerUserID)
	if err == nil {
		if oauthUser.Status != string(domain.UserStatusActive) {
			return UserDTO{}, apperror.New(apperror.CodeForbidden, "User is disabled")
		}
		if err := s.repo.UpdateLastLogin(ctx, oauthUser.ID); err != nil {
			return UserDTO{}, err
		}
		return oauthUser.UserDTO, nil
	}
	if !isNotFound(err) {
		return UserDTO{}, err
	}

	existing, err := s.repo.GetUserByEmail(ctx, email)
	if err == nil {
		if existing.Status != string(domain.UserStatusActive) {
			return UserDTO{}, apperror.New(apperror.CodeForbidden, "User is disabled")
		}
		if err := s.repo.LinkOAuthAccount(ctx, existing.ID, provider, providerUserID, email); err != nil {
			return UserDTO{}, err
		}
		if err := s.repo.UpdateLastLogin(ctx, existing.ID); err != nil {
			return UserDTO{}, err
		}
		return existing.UserDTO, nil
	}
	if !isNotFound(err) {
		return UserDTO{}, err
	}

	if name == "" {
		name = email
		if at := strings.IndexByte(email, '@'); at > 0 {
			name = email[:at]
		}
	}
	user, err := s.repo.CreateUser(ctx, CreateUserInput{
		Email:        email,
		PasswordHash: "oauth:" + provider,
		Name:         name,
		Role:         domain.RoleMember,
	})
	if err != nil {
		return UserDTO{}, err
	}
	createdBy := user.ID
	if err := s.credits.CreateInitialAccount(ctx, user.ID, s.defaultDailyQuota, &createdBy); err != nil {
		return UserDTO{}, apperror.Wrap(apperror.CodeInternal, "Could not create credit account", err)
	}
	if err := s.repo.LinkOAuthAccount(ctx, user.ID, provider, providerUserID, email); err != nil {
		return UserDTO{}, err
	}
	if err := s.repo.UpdateLastLogin(ctx, user.ID); err != nil {
		return UserDTO{}, err
	}
	return user, nil
}

func (s Service) Login(ctx context.Context, email string, rawPassword string) (UserDTO, error) {
	user, err := s.repo.GetUserByEmail(ctx, domain.NormalizeEmail(email))
	if err != nil {
		return UserDTO{}, apperror.New(apperror.CodeUnauthenticated, "Invalid email or password")
	}
	if user.Status != string(domain.UserStatusActive) || !s.password.Compare(user.PasswordHash, rawPassword) {
		return UserDTO{}, apperror.New(apperror.CodeUnauthenticated, "Invalid email or password")
	}
	if err := s.repo.UpdateLastLogin(ctx, user.ID); err != nil {
		return UserDTO{}, err
	}
	return user.UserDTO, nil
}

func (s Service) CurrentUser(ctx context.Context, userID string) (UserDTO, error) {
	return s.repo.GetUserByID(ctx, userID)
}

func (s Service) CreateInvitation(ctx context.Context, role domain.Role, initialDailyQuota int32, maxUses int32, expiresAt time.Time, createdBy string, note string) (InvitationDTO, error) {
	if !domain.IsValidRole(role) {
		return InvitationDTO{}, apperror.New(apperror.CodeInvalidInput, "Invalid role")
	}
	if initialDailyQuota < 0 || maxUses <= 0 || !expiresAt.After(s.now()) {
		return InvitationDTO{}, apperror.New(apperror.CodeInvalidInput, "Invalid invitation settings")
	}
	code, err := GenerateInvitationCode()
	if err != nil {
		return InvitationDTO{}, apperror.Wrap(apperror.CodeInternal, "Could not generate invitation code", err)
	}
	invitation, err := s.repo.CreateInvitation(ctx, CreateInvitationInput{
		CodeHash:          HashInvitationCode(code),
		Role:              role,
		InitialDailyQuota: initialDailyQuota,
		MaxUses:           maxUses,
		ExpiresAt:         expiresAt,
		CreatedBy:         createdBy,
		Note:              strings.TrimSpace(note),
	})
	if err != nil {
		return InvitationDTO{}, err
	}
	invitation.Code = code
	return invitation, nil
}

func GenerateInvitationCode() (string, error) {
	buf := make([]byte, 12)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return strings.ToUpper(base64.RawURLEncoding.EncodeToString(buf)), nil
}

func HashInvitationCode(code string) string {
	normalized := strings.ToUpper(strings.TrimSpace(code))
	sum := sha256.Sum256([]byte(normalized))
	return hex.EncodeToString(sum[:])
}

func isNotFound(err error) bool {
	var appErr *apperror.Error
	return errors.As(err, &appErr) && appErr.Code == apperror.CodeNotFound
}

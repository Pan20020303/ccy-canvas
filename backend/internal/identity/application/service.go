package application

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
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
	UpdateLastLogin(ctx context.Context, id string) error
	CreateInvitation(ctx context.Context, input CreateInvitationInput) (InvitationDTO, error)
	RedeemInvitation(ctx context.Context, codeHash string, email string, createUser func(ctx context.Context, role domain.Role, dailyQuota int32) (string, error)) error
}

type Service struct {
	repo     Repository
	password PasswordHasher
	credits  creditapp.AccountCreator
	now      func() time.Time
}

func NewService(repo Repository, password PasswordHasher, credits creditapp.AccountCreator) Service {
	return Service{repo: repo, password: password, credits: credits, now: time.Now}
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

func (s Service) RegisterByInvite(ctx context.Context, email string, rawPassword string, name string, code string) (UserDTO, error) {
	email = domain.NormalizeEmail(email)
	trimmedName := strings.TrimSpace(name)
	if email == "" || rawPassword == "" || trimmedName == "" || code == "" {
		return UserDTO{}, apperror.New(apperror.CodeInvalidInput, "Email, password, name, and invitation code are required")
	}
	passwordHash, err := s.password.Hash(rawPassword)
	if err != nil {
		return UserDTO{}, apperror.Wrap(apperror.CodeInternal, "Could not hash password", err)
	}

	var created UserDTO
	codeHash := HashInvitationCode(code)
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

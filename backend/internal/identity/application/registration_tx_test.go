package application

import (
	"context"
	"errors"
	"testing"

	creditapp "ccy-canvas/backend/internal/credits/application"
	"ccy-canvas/backend/internal/identity/domain"
)

// --- minimal fakes ---

type fakeHasher struct{}

func (fakeHasher) Hash(raw string) (string, error) { return "hash:" + raw, nil }
func (fakeHasher) Compare(hash, raw string) bool   { return hash == "hash:"+raw }

type fakeCreator struct {
	called int
	err    error
}

func (c *fakeCreator) CreateInitialAccount(_ context.Context, _ string, _ int32, _ *string) error {
	c.called++
	return c.err
}
func (c *fakeCreator) GetSummary(context.Context, string) (creditapp.CreditSummary, error) {
	return creditapp.CreditSummary{}, nil
}

type fakeRepo struct {
	createUserCalled int
	withTxCalled     int
	committed        bool
	rolledBack       bool
	creator          *fakeCreator // so WithTx body can invoke account creation in-tx
}

func (r *fakeRepo) CreateUser(_ context.Context, in CreateUserInput) (UserDTO, error) {
	r.createUserCalled++
	return UserDTO{ID: "u1", Email: in.Email, Name: in.Name, Role: in.Role}, nil
}
func (r *fakeRepo) GetUserByEmail(context.Context, string) (UserWithPasswordDTO, error) {
	return UserWithPasswordDTO{}, errNotFoundStub
}
func (r *fakeRepo) GetUserByID(context.Context, string) (UserDTO, error) {
	return UserDTO{}, errNotFoundStub
}
func (r *fakeRepo) GetUserByOAuth(context.Context, string, string) (UserWithPasswordDTO, error) {
	return UserWithPasswordDTO{}, errNotFoundStub
}
func (r *fakeRepo) LinkOAuthAccount(context.Context, string, string, string, string) error {
	return nil
}
func (r *fakeRepo) UpdateLastLogin(context.Context, string) error { return nil }
func (r *fakeRepo) CreateInvitation(context.Context, CreateInvitationInput) (InvitationDTO, error) {
	return InvitationDTO{}, nil
}
func (r *fakeRepo) RedeemInvitation(context.Context, string, string, func(context.Context, domain.Role, int32) (string, error)) error {
	return nil
}

// WithTx simulates a transaction: runs fn; if it errors, the "tx" rolls back
// (commit never happens), otherwise it commits.
func (r *fakeRepo) WithTx(ctx context.Context, fn func(txCtx context.Context) error) error {
	r.withTxCalled++
	if err := fn(ctx); err != nil {
		r.rolledBack = true
		return err
	}
	r.committed = true
	return nil
}

var errNotFoundStub = errors.New("not found")

// Register (non-invite) must create the user and the credit account inside one
// transaction so a failure can't leave an orphaned user with no account.
func TestRegisterCreatesUserAndAccountAtomically(t *testing.T) {
	creator := &fakeCreator{}
	repo := &fakeRepo{creator: creator}
	svc := NewService(repo, fakeHasher{}, creator)

	user, err := svc.Register(context.Background(), "a@b.com", "pw123456", "Alice", "")
	if err != nil {
		t.Fatalf("Register error: %v", err)
	}
	if user.ID != "u1" {
		t.Fatalf("user.ID = %q, want u1", user.ID)
	}
	if repo.withTxCalled != 1 {
		t.Fatalf("WithTx called %d times, want 1", repo.withTxCalled)
	}
	if !repo.committed || repo.rolledBack {
		t.Fatalf("expected commit, got committed=%v rolledBack=%v", repo.committed, repo.rolledBack)
	}
	if repo.createUserCalled != 1 || creator.called != 1 {
		t.Fatalf("createUser=%d createAccount=%d, want 1/1", repo.createUserCalled, creator.called)
	}
}

func TestRegisterRollsBackWhenAccountCreationFails(t *testing.T) {
	creator := &fakeCreator{err: errors.New("db blip")}
	repo := &fakeRepo{creator: creator}
	svc := NewService(repo, fakeHasher{}, creator)

	_, err := svc.Register(context.Background(), "a@b.com", "pw123456", "Alice", "")
	if err == nil {
		t.Fatal("expected error when account creation fails")
	}
	// The user creation and account creation both ran inside the same WithTx,
	// which rolled back — so a real DB leaves no orphaned user row.
	if repo.createUserCalled != 1 || creator.called != 1 {
		t.Fatalf("createUser=%d createAccount=%d, want both attempted", repo.createUserCalled, creator.called)
	}
	if repo.committed {
		t.Fatal("transaction must NOT commit when account creation fails")
	}
	if !repo.rolledBack {
		t.Fatal("transaction should have rolled back")
	}
}

package application

import (
	"context"
	"testing"
)

type passwordRepo struct {
	fakeRepo
	user UserWithPasswordDTO
}

func (r *passwordRepo) GetUserByID(_ context.Context, id string) (UserDTO, error) {
	if id != r.user.ID {
		return UserDTO{}, errNotFoundStub
	}
	return r.user.UserDTO, nil
}

func (r *passwordRepo) GetUserByEmail(_ context.Context, email string) (UserWithPasswordDTO, error) {
	if email != r.user.Email {
		return UserWithPasswordDTO{}, errNotFoundStub
	}
	return r.user, nil
}

func TestPasswordStatusChecksOwnerAndPassword(t *testing.T) {
	repo := &passwordRepo{user: UserWithPasswordDTO{UserDTO: UserDTO{ID: "owner", Email: "owner@example.com"}, PasswordHash: "hash:correct", Status: "active"}}
	svc := NewService(repo, fakeHasher{}, &fakeCreator{})
	available, valid, err := svc.PasswordStatus(context.Background(), "owner", "wrong")
	if err != nil || !available || valid {
		t.Fatalf("wrong password: available=%t valid=%t err=%v", available, valid, err)
	}
	available, valid, err = svc.PasswordStatus(context.Background(), "owner", "correct")
	if err != nil || !available || !valid {
		t.Fatalf("right password: available=%t valid=%t err=%v", available, valid, err)
	}
	if _, _, err := svc.PasswordStatus(context.Background(), "other", "correct"); err == nil {
		t.Fatal("other user accepted")
	}
}

func TestPasswordStatusRejectsOAuthOnlyAccount(t *testing.T) {
	repo := &passwordRepo{user: UserWithPasswordDTO{UserDTO: UserDTO{ID: "owner", Email: "owner@example.com"}, PasswordHash: "oauth:google", Status: "active"}}
	svc := NewService(repo, fakeHasher{}, &fakeCreator{})
	available, valid, err := svc.PasswordStatus(context.Background(), "owner", "anything")
	if err != nil || available || valid {
		t.Fatalf("oauth account: available=%t valid=%t err=%v", available, valid, err)
	}
}

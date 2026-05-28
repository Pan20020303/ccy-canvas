package domain

import (
	"testing"
	"time"
)

func TestInvitationCanBeRedeemed(t *testing.T) {
	invitation := Invitation{
		Role:              RoleMember,
		InitialDailyQuota: 500,
		MaxUses:           1,
		UsedCount:         0,
		ExpiresAt:         time.Now().Add(time.Hour),
	}
	if err := invitation.ValidateRedeemable(time.Now()); err != nil {
		t.Fatalf("expected invitation to be redeemable, got %v", err)
	}
}

func TestInvitationRejectsExpiredCode(t *testing.T) {
	invitation := Invitation{
		Role:              RoleMember,
		InitialDailyQuota: 500,
		MaxUses:           1,
		UsedCount:         0,
		ExpiresAt:         time.Now().Add(-time.Minute),
	}
	err := invitation.ValidateRedeemable(time.Now())
	if err == nil {
		t.Fatal("expected expired invitation to fail")
	}
}

func TestInvitationRejectsUsedUpCode(t *testing.T) {
	invitation := Invitation{
		Role:              RoleMember,
		InitialDailyQuota: 500,
		MaxUses:           1,
		UsedCount:         1,
		ExpiresAt:         time.Now().Add(time.Hour),
	}
	err := invitation.ValidateRedeemable(time.Now())
	if err == nil {
		t.Fatal("expected used-up invitation to fail")
	}
}

package domain

import (
	"time"

	"ccy-canvas/backend/internal/shared/apperror"
)

type Invitation struct {
	ID                string
	CodeHash          string
	Role              Role
	InitialDailyQuota int32
	MaxUses           int32
	UsedCount         int32
	ExpiresAt         time.Time
	RevokedAt         *time.Time
}

func (i Invitation) ValidateRedeemable(now time.Time) error {
	if i.RevokedAt != nil {
		return apperror.New(apperror.CodeInvitationInvalid, "Invitation has been revoked")
	}
	if !now.Before(i.ExpiresAt) {
		return apperror.New(apperror.CodeInvitationInvalid, "Invitation has expired")
	}
	if i.UsedCount >= i.MaxUses {
		return apperror.New(apperror.CodeInvitationInvalid, "Invitation has already been used")
	}
	if !IsValidRole(i.Role) {
		return apperror.New(apperror.CodeInvitationInvalid, "Invitation role is invalid")
	}
	if i.InitialDailyQuota < 0 {
		return apperror.New(apperror.CodeInvitationInvalid, "Invitation quota is invalid")
	}
	return nil
}

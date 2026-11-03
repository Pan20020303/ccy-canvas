package infrastructure

import (
	"testing"

	"github.com/google/uuid"
)

func TestAllocateProjectRefund(t *testing.T) {
	owner := uuid.MustParse("00000000-0000-0000-0000-000000000001")
	member := uuid.MustParse("00000000-0000-0000-0000-000000000002")
	if owner == member || owner.String() >= member.String() {
		t.Fatalf("unexpected UUID ordering: owner=%s member=%s", owner, member)
	}

	tests := []struct {
		name          string
		balance       int64
		contributions []projectCreditContribution
		want          map[uuid.UUID]int64
	}{
		{
			name:    "no contributions returns legacy balance to owner",
			balance: 17,
			want:    map[uuid.UUID]int64{owner: 17},
		},
		{
			name:    "single funder receives remaining project balance",
			balance: 40,
			contributions: []projectCreditContribution{
				{UserID: owner, Amount: 100},
			},
			want: map[uuid.UUID]int64{owner: 40},
		},
		{
			name:    "remaining balance is split proportionally with deterministic rounding",
			balance: 5,
			contributions: []projectCreditContribution{
				{UserID: owner, Amount: 20},
				{UserID: member, Amount: 10},
			},
			want: map[uuid.UUID]int64{owner: 3, member: 2},
		},
		{
			name:    "unmatched legacy balance goes to owner without exceeding another funder contribution",
			balance: 20,
			contributions: []projectCreditContribution{
				{UserID: member, Amount: 5},
			},
			want: map[uuid.UUID]int64{owner: 15, member: 5},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := allocateProjectRefund(test.balance, owner, test.contributions)
			if len(got) != len(test.want) {
				t.Fatalf("refund recipient count = %d, want %d (%v)", len(got), len(test.want), got)
			}
			for userID, wantAmount := range test.want {
				if got[userID] != wantAmount {
					t.Errorf("refund for %s = %d, want %d", userID, got[userID], wantAmount)
				}
			}
		})
	}
}

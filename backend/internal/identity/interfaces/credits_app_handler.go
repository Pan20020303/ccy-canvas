package interfaces

import (
	"context"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5/pgtype"

	"ccy-canvas/backend/internal/platform/authn"
	"ccy-canvas/backend/internal/platform/database/sqlc"
	"ccy-canvas/backend/internal/platform/httpapi"
	"ccy-canvas/backend/internal/shared/httpx"
)

// CreditsAppHandler exposes the current user's OWN credit ledger. The admin
// ledger (/api/admin/credits/ledger) spans all users and leaks names/emails;
// this one is scoped to the caller so the balance pill can show "where did my
// credits go" without any cross-user exposure.
type CreditsAppHandler struct {
	q *sqlc.Queries
}

func NewCreditsAppHandler(q *sqlc.Queries) *CreditsAppHandler {
	return &CreditsAppHandler{q: q}
}

type UserLedgerItem struct {
	ID           string `json:"id"`
	Type         string `json:"type"` // daily_reset/reserve/charge/refund/admin_adjustment
	Amount       int32  `json:"amount"`
	BalanceAfter int32  `json:"balance_after"`
	Reason       string `json:"reason"`
	CreatedAt    string `json:"created_at"`
}

type listUserLedgerInput struct {
	Limit  int `query:"limit" default:"50"`
	Offset int `query:"offset" default:"0"`
}

type listUserLedgerOutput struct {
	Body struct {
		Data      []UserLedgerItem `json:"data"`
		Total     int64            `json:"total"`
		RequestID string           `json:"request_id"`
	}
}

var creditsUserSec = []map[string][]string{{httpapi.SecuritySchemeName: {}}}

func (h *CreditsAppHandler) RegisterRoutes(api huma.API) {
	huma.Register(api, huma.Operation{
		OperationID: "list-my-credit-ledger",
		Method:      http.MethodGet,
		Path:        "/api/app/credits/ledger",
		Summary:     "List the current user's own credit ledger entries",
		Tags:        []string{"App", "Credits"},
		Security:    creditsUserSec,
	}, h.listMine)
}

func (h *CreditsAppHandler) listMine(ctx context.Context, input *listUserLedgerInput) (*listUserLedgerOutput, error) {
	claims, ok := authn.ClaimsFromContext(ctx)
	if !ok {
		return nil, huma.Error401Unauthorized("Authentication required")
	}
	var uid pgtype.UUID
	if err := uid.Scan(claims.UserID); err != nil {
		return nil, huma.Error401Unauthorized("Invalid session")
	}
	limit := int32(input.Limit)
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	offset := int32(input.Offset)
	if offset < 0 {
		offset = 0
	}
	rows, err := h.q.ListUserCreditLedger(ctx, sqlc.ListUserCreditLedgerParams{
		UserID: uid, Limit: limit, Offset: offset,
	})
	if err != nil {
		return nil, huma.Error500InternalServerError("Failed to list credit ledger")
	}
	total, _ := h.q.CountUserCreditLedger(ctx, uid)

	out := &listUserLedgerOutput{}
	out.Body.Data = make([]UserLedgerItem, 0, len(rows))
	for _, r := range rows {
		createdAt := ""
		if r.CreatedAt.Valid {
			createdAt = r.CreatedAt.Time.UTC().Format(time.RFC3339)
		}
		out.Body.Data = append(out.Body.Data, UserLedgerItem{
			ID:           formatUUID(r.ID.Bytes),
			Type:         r.Type,
			Amount:       r.Amount,
			BalanceAfter: r.BalanceAfter,
			Reason:       r.Reason,
			CreatedAt:    createdAt,
		})
	}
	out.Body.Total = total
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

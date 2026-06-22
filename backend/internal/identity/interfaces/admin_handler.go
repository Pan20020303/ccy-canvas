package interfaces

import (
	"context"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"ccy-canvas/backend/internal/platform/authn"
	"ccy-canvas/backend/internal/platform/database/sqlc"
	"ccy-canvas/backend/internal/platform/httpapi"
	"ccy-canvas/backend/internal/platform/password"
	"ccy-canvas/backend/internal/shared/httpx"

	"github.com/jackc/pgx/v5/pgtype"
)

// AdminHandler provides admin-only huma endpoints for users, invitations, stats, logs.
type AdminHandler struct {
	q        *sqlc.Queries
	password password.Service
}

func NewAdminHandler(q *sqlc.Queries, passwordSvc password.Service) *AdminHandler {
	return &AdminHandler{q: q, password: passwordSvc}
}

var adminSec = []map[string][]string{{httpapi.SecuritySchemeName: {authn.ScopeAdmin}}}

func (h *AdminHandler) RegisterRoutes(api huma.API) {
	// Users
	huma.Register(api, huma.Operation{
		OperationID: "admin-list-users",
		Method:      http.MethodGet,
		Path:        "/api/admin/users",
		Summary:     "List all users",
		Tags:        []string{"Admin", "Users"},
		Security:    adminSec,
	}, h.listUsers)

	huma.Register(api, huma.Operation{
		OperationID:   "admin-update-user-role",
		Method:        http.MethodPatch,
		Path:          "/api/admin/users/{id}/role",
		Summary:       "Update user role",
		Tags:          []string{"Admin", "Users"},
		Security:      adminSec,
		DefaultStatus: http.StatusOK,
	}, h.updateUserRole)

	huma.Register(api, huma.Operation{
		OperationID:   "admin-update-user-status",
		Method:        http.MethodPatch,
		Path:          "/api/admin/users/{id}/status",
		Summary:       "Enable or disable a user",
		Tags:          []string{"Admin", "Users"},
		Security:      adminSec,
		DefaultStatus: http.StatusOK,
	}, h.updateUserStatus)

	huma.Register(api, huma.Operation{
		OperationID:   "admin-delete-user",
		Method:        http.MethodDelete,
		Path:          "/api/admin/users/{id}",
		Summary:       "Delete a user",
		Tags:          []string{"Admin", "Users"},
		Security:      adminSec,
		DefaultStatus: http.StatusNoContent,
	}, h.deleteUser)

	huma.Register(api, huma.Operation{
		OperationID:   "admin-reset-user-password",
		Method:        http.MethodPost,
		Path:          "/api/admin/users/{id}/password",
		Summary:       "Reset a user's password",
		Tags:          []string{"Admin", "Users"},
		Security:      adminSec,
		DefaultStatus: http.StatusOK,
	}, h.resetUserPassword)

	huma.Register(api, huma.Operation{
		OperationID:   "admin-adjust-credits",
		Method:        http.MethodPost,
		Path:          "/api/admin/users/{id}/credits",
		Summary:       "Adjust user credits (top-up or set quota)",
		Tags:          []string{"Admin", "Users"},
		Security:      adminSec,
		DefaultStatus: http.StatusOK,
	}, h.adjustCredits)

	huma.Register(api, huma.Operation{
		OperationID: "admin-list-credit-ledger",
		Method:      http.MethodGet,
		Path:        "/api/admin/credits/ledger",
		Summary:     "List credit ledger entries (reserve/refund/charge/admin)",
		Tags:        []string{"Admin", "Credits"},
		Security:    adminSec,
	}, h.listCreditLedger)

	// Invitations
	huma.Register(api, huma.Operation{
		OperationID: "admin-list-invitations",
		Method:      http.MethodGet,
		Path:        "/api/admin/invitations",
		Summary:     "List all invitations",
		Tags:        []string{"Admin", "Invitations"},
		Security:    adminSec,
	}, h.listInvitations)

	huma.Register(api, huma.Operation{
		OperationID:   "admin-revoke-invitation",
		Method:        http.MethodPost,
		Path:          "/api/admin/invitations/{id}/revoke",
		Summary:       "Revoke an invitation",
		Tags:          []string{"Admin", "Invitations"},
		Security:      adminSec,
		DefaultStatus: http.StatusOK,
	}, h.revokeInvitation)

	// Stats
	huma.Register(api, huma.Operation{
		OperationID: "admin-stats",
		Method:      http.MethodGet,
		Path:        "/api/admin/stats",
		Summary:     "Get admin dashboard stats",
		Tags:        []string{"Admin", "Stats"},
		Security:    adminSec,
	}, h.getStats)

	// Generation logs
	huma.Register(api, huma.Operation{
		OperationID: "admin-list-logs",
		Method:      http.MethodGet,
		Path:        "/api/admin/logs",
		Summary:     "List generation logs",
		Tags:        []string{"Admin", "Logs"},
		Security:    adminSec,
	}, h.listLogs)
}

// ─── Types ───────────────────────────────────────────────────────────────────

func pgUUIDStr(u pgtype.UUID) string {
	if !u.Valid {
		return ""
	}
	return formatUUID(u.Bytes)
}

// Simple UUID formatter to avoid importing uuid package here.
func formatUUID(b [16]byte) string {
	const hex = "0123456789abcdef"
	buf := make([]byte, 36)
	pos := 0
	for i, v := range b {
		if i == 4 || i == 6 || i == 8 || i == 10 {
			buf[pos] = '-'
			pos++
		}
		buf[pos] = hex[v>>4]
		buf[pos+1] = hex[v&0x0f]
		pos += 2
	}
	return string(buf)
}

func timePtr(t pgtype.Timestamptz) *time.Time {
	if !t.Valid {
		return nil
	}
	v := t.Time
	return &v
}

// ─── Users ──────────────────────────────────────────────────────────────────

type UserItem struct {
	ID             string     `json:"id"`
	Email          string     `json:"email"`
	Name           string     `json:"name"`
	Role           string     `json:"role"`
	Status         string     `json:"status"`
	LastLoginAt    *time.Time `json:"last_login_at"`
	CreatedAt      string     `json:"created_at"`
	DailyQuota     int32      `json:"daily_quota"`
	CurrentBalance int32      `json:"current_balance"`
}

type listUsersOutput struct {
	Body struct {
		Data      []UserItem `json:"data"`
		RequestID string     `json:"request_id"`
	}
}

func (h *AdminHandler) listUsers(ctx context.Context, _ *struct{}) (*listUsersOutput, error) {
	rows, err := h.q.ListUsers(ctx)
	if err != nil {
		return nil, huma.Error500InternalServerError("Failed to list users")
	}
	items := make([]UserItem, 0, len(rows))
	for _, r := range rows {
		items = append(items, UserItem{
			ID:             formatUUID(r.ID.Bytes),
			Email:          r.Email,
			Name:           r.Name,
			Role:           r.Role,
			Status:         r.Status,
			LastLoginAt:    timePtr(r.LastLoginAt),
			CreatedAt:      r.CreatedAt.Time.Format(time.RFC3339),
			DailyQuota:     r.DailyQuota,
			CurrentBalance: r.CurrentBalance,
		})
	}
	out := &listUsersOutput{}
	out.Body.Data = items
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type updateUserRoleInput struct {
	ID   string `path:"id"`
	Body struct {
		Role string `json:"role" enum:"admin,member"`
	}
}

type userOutput struct {
	Body struct {
		Data      UserItem `json:"data"`
		RequestID string   `json:"request_id"`
	}
}

func (h *AdminHandler) updateUserRole(ctx context.Context, input *updateUserRoleInput) (*userOutput, error) {
	pgID, err := parseUUID(input.ID)
	if err != nil {
		return nil, huma.Error400BadRequest("Invalid user ID")
	}
	u, err := h.q.UpdateUserRole(ctx, sqlc.UpdateUserRoleParams{ID: pgID, Role: input.Body.Role})
	if err != nil {
		return nil, huma.Error500InternalServerError("Failed to update role")
	}
	out := &userOutput{}
	out.Body.Data = UserItem{ID: formatUUID(u.ID.Bytes), Email: u.Email, Name: u.Name, Role: u.Role, Status: u.Status, LastLoginAt: timePtr(u.LastLoginAt), CreatedAt: u.CreatedAt.Time.Format(time.RFC3339)}
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type updateUserStatusInput struct {
	ID   string `path:"id"`
	Body struct {
		Status string `json:"status" enum:"active,disabled"`
	}
}

func (h *AdminHandler) updateUserStatus(ctx context.Context, input *updateUserStatusInput) (*userOutput, error) {
	pgID, err := parseUUID(input.ID)
	if err != nil {
		return nil, huma.Error400BadRequest("Invalid user ID")
	}
	u, err := h.q.UpdateUserStatus(ctx, sqlc.UpdateUserStatusParams{ID: pgID, Status: input.Body.Status})
	if err != nil {
		return nil, huma.Error500InternalServerError("Failed to update status")
	}
	out := &userOutput{}
	out.Body.Data = UserItem{ID: formatUUID(u.ID.Bytes), Email: u.Email, Name: u.Name, Role: u.Role, Status: u.Status, LastLoginAt: timePtr(u.LastLoginAt), CreatedAt: u.CreatedAt.Time.Format(time.RFC3339)}
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type deleteUserInput struct {
	ID string `path:"id"`
}

func (h *AdminHandler) deleteUser(ctx context.Context, input *deleteUserInput) (*struct{}, error) {
	pgID, err := parseUUID(input.ID)
	if err != nil {
		return nil, huma.Error400BadRequest("Invalid user ID")
	}
	if err := h.q.DeleteUser(ctx, pgID); err != nil {
		return nil, huma.Error500InternalServerError("Failed to delete user")
	}
	return nil, nil
}

type resetUserPasswordInput struct {
	ID   string `path:"id"`
	Body struct {
		Password string `json:"password" minLength:"6" doc:"New password (min 6 chars)"`
	}
}

type resetUserPasswordOutput struct {
	Body struct {
		Data      resetUserPasswordData `json:"data"`
		RequestID string                `json:"request_id"`
	}
}

type resetUserPasswordData struct {
	UserID string `json:"user_id"`
}

func (h *AdminHandler) resetUserPassword(ctx context.Context, input *resetUserPasswordInput) (*resetUserPasswordOutput, error) {
	pgID, err := parseUUID(input.ID)
	if err != nil {
		return nil, huma.Error400BadRequest("Invalid user ID")
	}
	hash, err := h.password.Hash(input.Body.Password)
	if err != nil {
		return nil, huma.Error500InternalServerError("Failed to hash password")
	}
	if err := h.q.UpdateUserPassword(ctx, sqlc.UpdateUserPasswordParams{ID: pgID, PasswordHash: hash}); err != nil {
		return nil, huma.Error500InternalServerError("Failed to update password")
	}
	out := &resetUserPasswordOutput{}
	out.Body.Data.UserID = input.ID
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

// ─── Credits ────────────────────────────────────────────────────────────────

type adjustCreditsInput struct {
	ID   string `path:"id"`
	Body struct {
		AddBalance *int32 `json:"add_balance,omitempty" doc:"Amount to add to current balance (can be negative)"`
		SetQuota   *int32 `json:"set_quota,omitempty" doc:"Set daily quota to this value"`
		Reason     string `json:"reason,omitempty" doc:"Reason for adjustment"`
	}
}

type creditsOutput struct {
	Body struct {
		Data      creditsData `json:"data"`
		RequestID string      `json:"request_id"`
	}
}

type creditsData struct {
	UserID         string `json:"user_id"`
	DailyQuota     int32  `json:"daily_quota"`
	CurrentBalance int32  `json:"current_balance"`
}

func (h *AdminHandler) adjustCredits(ctx context.Context, input *adjustCreditsInput) (*creditsOutput, error) {
	pgID, err := parseUUID(input.ID)
	if err != nil {
		return nil, huma.Error400BadRequest("Invalid user ID")
	}

	// Ensure credit account exists (auto-create if missing, e.g. for admin users).
	if _, err := h.q.GetCreditAccountByUserID(ctx, pgID); err != nil {
		_, _ = h.q.CreateCreditAccount(ctx, sqlc.CreateCreditAccountParams{
			UserID:     pgID,
			DailyQuota: 100,
		})
	}

	// Adjust balance if requested.
	if input.Body.AddBalance != nil && *input.Body.AddBalance != 0 {
		_, err := h.q.AdjustCreditBalance(ctx, sqlc.AdjustCreditBalanceParams{
			UserID:         pgID,
			CurrentBalance: *input.Body.AddBalance,
		})
		if err != nil {
			return nil, huma.Error500InternalServerError("Failed to adjust balance")
		}

		// Record ledger entry.
		acct, _ := h.q.GetCreditAccountByUserID(ctx, pgID)
		if acct.ID.Valid {
			reason := input.Body.Reason
			if reason == "" {
				reason = "admin adjustment"
			}
			claims, _ := authn.ClaimsFromContext(ctx)
			adminID, _ := parseUUID(claims.UserID)
			_ = h.q.CreateCreditLedgerEntry(ctx, sqlc.CreateCreditLedgerEntryParams{
				UserID:       pgID,
				AccountID:    acct.ID,
				Type:         "admin_adjustment",
				Amount:       *input.Body.AddBalance,
				BalanceAfter: acct.CurrentBalance,
				Reason:       reason,
				CreatedBy:    adminID,
			})
		}
	}

	// Set quota if requested.
	if input.Body.SetQuota != nil {
		_, err := h.q.AdjustCreditQuota(ctx, sqlc.AdjustCreditQuotaParams{
			UserID:     pgID,
			DailyQuota: *input.Body.SetQuota,
		})
		if err != nil {
			return nil, huma.Error500InternalServerError("Failed to set quota")
		}
	}

	// Return updated values.
	acct, err := h.q.GetCreditAccountByUserID(ctx, pgID)
	if err != nil {
		return nil, huma.Error500InternalServerError("Failed to read credit account")
	}

	out := &creditsOutput{}
	out.Body.Data.UserID = input.ID
	out.Body.Data.DailyQuota = acct.DailyQuota
	out.Body.Data.CurrentBalance = acct.CurrentBalance
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

// ─── Invitations ────────────────────────────────────────────────────────────

type InvitationItem struct {
	ID           string     `json:"id"`
	Role         string     `json:"role"`
	InitialQuota int32      `json:"initial_daily_quota"`
	MaxUses      int32      `json:"max_uses"`
	UsedCount    int32      `json:"used_count"`
	ExpiresAt    string     `json:"expires_at"`
	CreatedBy    string     `json:"created_by"`
	CreatorName  string     `json:"creator_name"`
	Note         string     `json:"note"`
	CreatedAt    string     `json:"created_at"`
	RevokedAt    *time.Time `json:"revoked_at"`
	Status       string     `json:"status"` // active / used / expired / revoked
}

func invitationStatus(row sqlc.ListInvitationsRow) string {
	if row.RevokedAt.Valid {
		return "revoked"
	}
	if row.UsedCount >= row.MaxUses {
		return "used"
	}
	if row.ExpiresAt.Time.Before(time.Now()) {
		return "expired"
	}
	return "active"
}

type listInvitationsOutput struct {
	Body struct {
		Data      []InvitationItem `json:"data"`
		RequestID string           `json:"request_id"`
	}
}

func (h *AdminHandler) listInvitations(ctx context.Context, _ *struct{}) (*listInvitationsOutput, error) {
	rows, err := h.q.ListInvitations(ctx)
	if err != nil {
		return nil, huma.Error500InternalServerError("Failed to list invitations")
	}
	items := make([]InvitationItem, 0, len(rows))
	for _, r := range rows {
		name := ""
		if r.CreatorName.Valid {
			name = r.CreatorName.String
		}
		items = append(items, InvitationItem{
			ID:           formatUUID(r.ID.Bytes),
			Role:         r.Role,
			InitialQuota: r.InitialDailyQuota,
			MaxUses:      r.MaxUses,
			UsedCount:    r.UsedCount,
			ExpiresAt:    r.ExpiresAt.Time.Format(time.RFC3339),
			CreatedBy:    formatUUID(r.CreatedBy.Bytes),
			CreatorName:  name,
			Note:         r.Note,
			CreatedAt:    r.CreatedAt.Time.Format(time.RFC3339),
			RevokedAt:    timePtr(r.RevokedAt),
			Status:       invitationStatus(r),
		})
	}
	out := &listInvitationsOutput{}
	out.Body.Data = items
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type revokeInvitationInput struct {
	ID string `path:"id"`
}

type revokeInvitationOutput struct {
	Body struct {
		Data      InvitationItem `json:"data"`
		RequestID string         `json:"request_id"`
	}
}

func (h *AdminHandler) revokeInvitation(ctx context.Context, input *revokeInvitationInput) (*revokeInvitationOutput, error) {
	pgID, err := parseUUID(input.ID)
	if err != nil {
		return nil, huma.Error400BadRequest("Invalid invitation ID")
	}
	r, err := h.q.RevokeInvitation(ctx, pgID)
	if err != nil {
		return nil, huma.Error404NotFound("Invitation not found or already revoked")
	}
	out := &revokeInvitationOutput{}
	out.Body.Data = InvitationItem{
		ID: formatUUID(r.ID.Bytes), Role: r.Role, InitialQuota: r.InitialDailyQuota,
		MaxUses: r.MaxUses, UsedCount: r.UsedCount, ExpiresAt: r.ExpiresAt.Time.Format(time.RFC3339),
		CreatedBy: formatUUID(r.CreatedBy.Bytes), Note: r.Note, CreatedAt: r.CreatedAt.Time.Format(time.RFC3339),
		RevokedAt: timePtr(r.RevokedAt), Status: "revoked",
	}
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

// ─── Stats ──────────────────────────────────────────────────────────────────

type StatsData struct {
	TotalUsers       int32 `json:"total_users"`
	AdminUsers       int32 `json:"admin_users"`
	ActiveUsers      int32 `json:"active_users"`
	TotalProviders   int32 `json:"total_providers"`
	EnabledProviders int32 `json:"enabled_providers"`
	GenerationsToday int32 `json:"generations_today"`
	SuccessToday     int32 `json:"success_today"`
	ErrorsToday      int32 `json:"errors_today"`
	CreditsConsumed  int32 `json:"credits_consumed_today"`
}

type statsOutput struct {
	Body struct {
		Data      StatsData `json:"data"`
		RequestID string    `json:"request_id"`
	}
}

func (h *AdminHandler) getStats(ctx context.Context, _ *struct{}) (*statsOutput, error) {
	users, _ := h.q.CountUsers(ctx)
	providers, _ := h.q.CountProviderConfigs(ctx)
	gens, _ := h.q.CountGenerationsToday(ctx)
	credits, _ := h.q.SumCreditsConsumedToday(ctx)

	out := &statsOutput{}
	out.Body.Data = StatsData{
		TotalUsers:       users.Total,
		AdminUsers:       users.Admins,
		ActiveUsers:      users.Active,
		TotalProviders:   providers.Total,
		EnabledProviders: providers.Enabled,
		GenerationsToday: gens.Total,
		SuccessToday:     gens.Success,
		ErrorsToday:      gens.Errors,
		CreditsConsumed:  credits,
	}
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

// ─── Logs ───────────────────────────────────────────────────────────────────

type LogItem struct {
	ID          string `json:"id"`
	UserID      string `json:"user_id"`
	UserEmail   string `json:"user_email"`
	UserName    string `json:"user_name"`
	NodeID      string `json:"node_id"`
	ServiceType string `json:"service_type"`
	Model       string `json:"model"`
	Prompt      string `json:"prompt"`
	Status      string `json:"status"`
	ResultURL   string `json:"result_url"`
	ErrorMsg    string `json:"error_msg"`
	DurationMs  int32  `json:"duration_ms"`
	CreatedAt   string `json:"created_at"`
}

type listLogsInput struct {
	Limit  int32  `query:"limit" minimum:"1" maximum:"100" default:"50"`
	Offset int32  `query:"offset" minimum:"0" default:"0"`
	Status string `query:"status"`
	User   string `query:"user"`
	Model  string `query:"model"`
}

type listLogsOutput struct {
	Body struct {
		Data      []LogItem `json:"data"`
		Total     int32     `json:"total"`
		RequestID string    `json:"request_id"`
	}
}

func (h *AdminHandler) listLogs(ctx context.Context, input *listLogsInput) (*listLogsOutput, error) {
	rows, err := h.q.ListGenerationLogsWithUser(ctx, sqlc.ListGenerationLogsWithUserParams{
		Column1: input.Status,
		Column2: input.User,
		Column3: input.Model,
		Limit:   input.Limit,
		Offset:  input.Offset,
	})
	if err != nil {
		return nil, huma.Error500InternalServerError("Failed to list logs")
	}
	total, _ := h.q.CountGenerationLogsWithFilter(ctx, sqlc.CountGenerationLogsWithFilterParams{
		Column1: input.Status,
		Column2: input.User,
		Column3: input.Model,
	})

	items := make([]LogItem, 0, len(rows))
	for _, r := range rows {
		items = append(items, LogItem{
			ID:          formatUUID(r.ID.Bytes),
			UserID:      formatUUID(r.UserID.Bytes),
			UserEmail:   r.UserEmail,
			UserName:    r.UserName,
			NodeID:      r.NodeID,
			ServiceType: r.ServiceType,
			Model:       r.Model,
			Prompt:      r.Prompt,
			Status:      r.Status,
			ResultURL:   r.ResultUrl,
			ErrorMsg:    r.ErrorMsg,
			DurationMs:  r.DurationMs,
			CreatedAt:   r.CreatedAt.Time.Format(time.RFC3339),
		})
	}
	out := &listLogsOutput{}
	out.Body.Data = items
	out.Body.Total = int32(total)
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

// ─── helpers ────────────────────────────────────────────────────────────────

func parseUUID(s string) (pgtype.UUID, error) {
	var u pgtype.UUID
	if len(s) != 36 {
		return u, huma.Error400BadRequest("Invalid UUID format")
	}
	// Parse hex nibbles from "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
	hex := s[0:8] + s[9:13] + s[14:18] + s[19:23] + s[24:36]
	if len(hex) != 32 {
		return u, huma.Error400BadRequest("Invalid UUID format")
	}
	for i := 0; i < 16; i++ {
		hi := hexVal(hex[i*2])
		lo := hexVal(hex[i*2+1])
		if hi == 0xFF || lo == 0xFF {
			return u, huma.Error400BadRequest("Invalid UUID format")
		}
		u.Bytes[i] = hi<<4 | lo
	}
	u.Valid = true
	return u, nil
}

func hexVal(c byte) byte {
	switch {
	case c >= '0' && c <= '9':
		return c - '0'
	case c >= 'a' && c <= 'f':
		return c - 'a' + 10
	case c >= 'A' && c <= 'F':
		return c - 'A' + 10
	default:
		return 0xFF
	}
}

// ─── Credit ledger (扣费流水) ─────────────────────────────────────────

type listCreditLedgerInput struct {
	User   string `query:"user" doc:"Filter by user name/email keyword"`
	Type   string `query:"type" doc:"Filter by entry type (reserve/refund/charge/admin_adjustment/daily_reset)"`
	Limit  int    `query:"limit" default:"100"`
	Offset int    `query:"offset" default:"0"`
}

type CreditLedgerItem struct {
	ID           string `json:"id"`
	UserID       string `json:"user_id"`
	UserName     string `json:"user_name"`
	UserEmail    string `json:"user_email"`
	Type         string `json:"type"`
	Amount       int32  `json:"amount"`
	BalanceAfter int32  `json:"balance_after"`
	Reason       string `json:"reason"`
	CreatedAt    string `json:"created_at"`
}

type listCreditLedgerOutput struct {
	Body struct {
		Data      []CreditLedgerItem `json:"data"`
		Total     int64              `json:"total"`
		RequestID string             `json:"request_id"`
	}
}

func (h *AdminHandler) listCreditLedger(ctx context.Context, input *listCreditLedgerInput) (*listCreditLedgerOutput, error) {
	limit := int32(input.Limit)
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	offset := int32(input.Offset)
	if offset < 0 {
		offset = 0
	}
	rows, err := h.q.ListCreditLedgerEntries(ctx, sqlc.ListCreditLedgerEntriesParams{
		UserKeyword: input.User,
		TypeFilter:  input.Type,
		Limit:       limit,
		Offset:      offset,
	})
	if err != nil {
		return nil, huma.Error500InternalServerError(err.Error())
	}
	total, _ := h.q.CountCreditLedgerEntries(ctx, input.User, input.Type)

	out := &listCreditLedgerOutput{}
	out.Body.Data = make([]CreditLedgerItem, 0, len(rows))
	for _, r := range rows {
		createdAt := ""
		if r.CreatedAt.Valid {
			createdAt = r.CreatedAt.Time.UTC().Format(time.RFC3339)
		}
		out.Body.Data = append(out.Body.Data, CreditLedgerItem{
			ID:           formatUUID(r.ID.Bytes),
			UserID:       formatUUID(r.UserID.Bytes),
			UserName:     r.UserName,
			UserEmail:    r.UserEmail,
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

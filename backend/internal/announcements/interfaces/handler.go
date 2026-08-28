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

// Handler 提供公告端点:管理端发布/删除 + 全体登录用户只读列表(铃铛)。
type Handler struct {
	q *sqlc.Queries
}

func NewHandler(q *sqlc.Queries) *Handler {
	return &Handler{q: q}
}

var (
	adminSec = []map[string][]string{{httpapi.SecuritySchemeName: {authn.ScopeAdmin}}}
	userSec  = []map[string][]string{{httpapi.SecuritySchemeName: {}}}
)

func (h *Handler) RegisterRoutes(api huma.API) {
	huma.Register(api, huma.Operation{
		OperationID: "app-list-announcements",
		Method:      http.MethodGet,
		Path:        "/api/app/announcements",
		Summary:     "List announcements (all signed-in users)",
		Tags:        []string{"Announcements"},
		Security:    userSec,
	}, h.listAnnouncements)

	huma.Register(api, huma.Operation{
		OperationID: "admin-list-announcements",
		Method:      http.MethodGet,
		Path:        "/api/admin/announcements",
		Summary:     "List announcements (admin)",
		Tags:        []string{"Admin", "Announcements"},
		Security:    adminSec,
	}, h.listAnnouncements)

	huma.Register(api, huma.Operation{
		OperationID:   "admin-create-announcement",
		Method:        http.MethodPost,
		Path:          "/api/admin/announcements",
		Summary:       "Publish an announcement",
		Tags:          []string{"Admin", "Announcements"},
		Security:      adminSec,
		DefaultStatus: http.StatusCreated,
	}, h.createAnnouncement)

	huma.Register(api, huma.Operation{
		OperationID:   "admin-delete-announcement",
		Method:        http.MethodDelete,
		Path:          "/api/admin/announcements/{id}",
		Summary:       "Delete an announcement",
		Tags:          []string{"Admin", "Announcements"},
		Security:      adminSec,
		DefaultStatus: http.StatusNoContent,
	}, h.deleteAnnouncement)
}

type AnnouncementItem struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Content     string `json:"content"`
	CreatorName string `json:"creator_name"`
	CreatedAt   string `json:"created_at"`
}

type listAnnouncementsInput struct {
	Limit int `query:"limit" default:"50" minimum:"1" maximum:"200"`
}

type listAnnouncementsOutput struct {
	Body struct {
		Data      []AnnouncementItem `json:"data"`
		RequestID string             `json:"request_id"`
	}
}

func (h *Handler) listAnnouncements(ctx context.Context, input *listAnnouncementsInput) (*listAnnouncementsOutput, error) {
	limit := int32(input.Limit)
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := h.q.ListAnnouncements(ctx, limit)
	if err != nil {
		return nil, huma.Error500InternalServerError("Failed to list announcements")
	}
	items := make([]AnnouncementItem, 0, len(rows))
	for _, r := range rows {
		items = append(items, AnnouncementItem{
			ID:          formatUUID(r.ID.Bytes),
			Title:       r.Title,
			Content:     r.Content,
			CreatorName: r.CreatorName,
			CreatedAt:   r.CreatedAt.Time.Format(time.RFC3339),
		})
	}
	out := &listAnnouncementsOutput{}
	out.Body.Data = items
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type createAnnouncementInput struct {
	Body struct {
		Title   string `json:"title" minLength:"1" maxLength:"200"`
		Content string `json:"content" minLength:"1" maxLength:"5000"`
	}
}

type announcementOutput struct {
	Body struct {
		Data      AnnouncementItem `json:"data"`
		RequestID string           `json:"request_id"`
	}
}

func (h *Handler) createAnnouncement(ctx context.Context, input *createAnnouncementInput) (*announcementOutput, error) {
	// created_by 尽力而为:claims 缺失或解析失败时留空(列可空)。
	var createdBy pgtype.UUID
	if claims, ok := authn.ClaimsFromContext(ctx); ok {
		if id, err := parseUUID(claims.UserID); err == nil {
			createdBy = id
		}
	}
	row, err := h.q.InsertAnnouncement(ctx, sqlc.InsertAnnouncementParams{
		Title:     input.Body.Title,
		Content:   input.Body.Content,
		CreatedBy: createdBy,
	})
	if err != nil {
		return nil, huma.Error500InternalServerError("Failed to create announcement")
	}
	out := &announcementOutput{}
	out.Body.Data = AnnouncementItem{
		ID:        formatUUID(row.ID.Bytes),
		Title:     row.Title,
		Content:   row.Content,
		CreatedAt: row.CreatedAt.Time.Format(time.RFC3339),
	}
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type deleteAnnouncementInput struct {
	ID string `path:"id"`
}

func (h *Handler) deleteAnnouncement(ctx context.Context, input *deleteAnnouncementInput) (*struct{}, error) {
	pgID, err := parseUUID(input.ID)
	if err != nil {
		return nil, huma.Error400BadRequest("Invalid announcement ID")
	}
	if err := h.q.DeleteAnnouncement(ctx, pgID); err != nil {
		return nil, huma.Error500InternalServerError("Failed to delete announcement")
	}
	return nil, nil
}

// ─── helpers(与 identity/skills 包内同名工具一致,包私有无法复用)──────

func formatUUID(b [16]byte) string {
	const hexdigits = "0123456789abcdef"
	buf := make([]byte, 36)
	pos := 0
	for i, v := range b {
		if i == 4 || i == 6 || i == 8 || i == 10 {
			buf[pos] = '-'
			pos++
		}
		buf[pos] = hexdigits[v>>4]
		buf[pos+1] = hexdigits[v&0x0F]
		pos += 2
	}
	return string(buf)
}

func parseUUID(s string) (pgtype.UUID, error) {
	var u pgtype.UUID
	if len(s) != 36 {
		return u, huma.Error400BadRequest("Invalid UUID format")
	}
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

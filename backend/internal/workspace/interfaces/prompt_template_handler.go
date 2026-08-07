package interfaces

import (
	"context"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5/pgtype"

	"ccy-canvas/backend/internal/platform/authn"
	"ccy-canvas/backend/internal/platform/database/sqlc"
	"ccy-canvas/backend/internal/platform/httpapi"
	"ccy-canvas/backend/internal/shared/httpx"
)

// PromptTemplateHandler:提示词模板库。
// 文本节点全屏编辑器的「提示词库」:所有登录用户共享一个模板池,任何人可
// 上传(即公开)、点赞/踩(一人一票,再点同键取消);上传者可删自己的。
// 管理端提供上传记录列表 + 违规删除。
type PromptTemplateHandler struct {
	q *sqlc.Queries
}

func NewPromptTemplateHandler(q *sqlc.Queries) *PromptTemplateHandler {
	return &PromptTemplateHandler{q: q}
}

type PromptTemplateItem struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Content   string    `json:"content"`
	OwnerName string    `json:"owner_name"`
	// 管理端才回填,用户端留空(不暴露他人邮箱)。
	OwnerEmail string    `json:"owner_email,omitempty"`
	IsMine     bool      `json:"is_mine"`
	Upvotes    int32     `json:"upvotes"`
	Downvotes  int32     `json:"downvotes"`
	MyVote     int32     `json:"my_vote"` // 1 赞 / -1 踩 / 0 未投
	CreatedAt  time.Time `json:"created_at"`
}

type listPromptTemplatesOutput struct {
	Body struct {
		Data      []PromptTemplateItem `json:"data"`
		RequestID string               `json:"request_id"`
	}
}

type createPromptTemplateInput struct {
	Body struct {
		Title   string `json:"title" minLength:"1" maxLength:"80" doc:"模板标题"`
		Content string `json:"content" minLength:"1" maxLength:"20000" doc:"模板正文(提示词)"`
	}
}

type promptTemplateOutput struct {
	Body struct {
		Data      PromptTemplateItem `json:"data"`
		RequestID string             `json:"request_id"`
	}
}

type promptTemplateIDInput struct {
	ID string `path:"id"`
}

type votePromptTemplateInput struct {
	ID   string `path:"id"`
	Body struct {
		// 1 = 赞,-1 = 踩,0 = 取消投票。
		Vote int32 `json:"vote" minimum:"-1" maximum:"1"`
	}
}

var promptTplUserSec = []map[string][]string{{httpapi.SecuritySchemeName: {}}}
var promptTplAdminSec = []map[string][]string{{httpapi.SecuritySchemeName: {authn.ScopeAdmin}}}

func (h *PromptTemplateHandler) RegisterRoutes(api huma.API) {
	huma.Register(api, huma.Operation{
		OperationID: "list-prompt-templates",
		Method:      http.MethodGet,
		Path:        "/api/app/prompt-templates",
		Summary:     "List shared prompt templates (with vote counts)",
		Tags:        []string{"App", "PromptTemplates"},
		Security:    promptTplUserSec,
	}, h.list)
	huma.Register(api, huma.Operation{
		OperationID:   "create-prompt-template",
		Method:        http.MethodPost,
		Path:          "/api/app/prompt-templates",
		Summary:       "Upload a prompt template (visible to everyone)",
		Tags:          []string{"App", "PromptTemplates"},
		Security:      promptTplUserSec,
		DefaultStatus: http.StatusCreated,
	}, h.create)
	huma.Register(api, huma.Operation{
		OperationID:   "delete-prompt-template",
		Method:        http.MethodDelete,
		Path:          "/api/app/prompt-templates/{id}",
		Summary:       "Delete an owned prompt template",
		Tags:          []string{"App", "PromptTemplates"},
		Security:      promptTplUserSec,
		DefaultStatus: http.StatusNoContent,
	}, h.deleteOwn)
	huma.Register(api, huma.Operation{
		OperationID: "vote-prompt-template",
		Method:      http.MethodPost,
		Path:        "/api/app/prompt-templates/{id}/vote",
		Summary:     "Upvote/downvote a template (0 clears the vote)",
		Tags:        []string{"App", "PromptTemplates"},
		Security:    promptTplUserSec,
	}, h.vote)

	// 管理端:上传记录(含上传者邮箱)+ 违规删除。
	huma.Register(api, huma.Operation{
		OperationID: "admin-list-prompt-templates",
		Method:      http.MethodGet,
		Path:        "/api/admin/prompt-templates",
		Summary:     "List all uploaded prompt templates (audit view)",
		Tags:        []string{"Admin", "PromptTemplates"},
		Security:    promptTplAdminSec,
	}, h.adminList)
	huma.Register(api, huma.Operation{
		OperationID:   "admin-delete-prompt-template",
		Method:        http.MethodDelete,
		Path:          "/api/admin/prompt-templates/{id}",
		Summary:       "Delete any prompt template",
		Tags:          []string{"Admin", "PromptTemplates"},
		Security:      promptTplAdminSec,
		DefaultStatus: http.StatusNoContent,
	}, h.adminDelete)
}

func promptTplUserID(ctx context.Context) (pgtype.UUID, error) {
	claims, ok := authn.ClaimsFromContext(ctx)
	if !ok {
		return pgtype.UUID{}, huma.Error401Unauthorized("Authentication required")
	}
	var u pgtype.UUID
	if err := u.Scan(claims.UserID); err != nil {
		return pgtype.UUID{}, huma.Error401Unauthorized("Invalid session")
	}
	return u, nil
}

func (h *PromptTemplateHandler) listRows(ctx context.Context, uid pgtype.UUID, includeEmail bool) ([]PromptTemplateItem, error) {
	rows, err := h.q.ListPromptTemplates(ctx, uid)
	if err != nil {
		return nil, huma.Error500InternalServerError("Failed to list prompt templates")
	}
	items := make([]PromptTemplateItem, 0, len(rows))
	for _, r := range rows {
		item := PromptTemplateItem{
			ID:        uuidString(r.ID),
			Title:     r.Title,
			Content:   r.Content,
			OwnerName: r.OwnerName,
			IsMine:    uuidString(r.OwnerID) == uuidString(uid),
			Upvotes:   r.Upvotes,
			Downvotes: r.Downvotes,
			MyVote:    r.MyVote,
			CreatedAt: r.CreatedAt.Time,
		}
		if includeEmail {
			item.OwnerEmail = r.OwnerEmail
		}
		items = append(items, item)
	}
	return items, nil
}

func (h *PromptTemplateHandler) list(ctx context.Context, _ *struct{}) (*listPromptTemplatesOutput, error) {
	uid, err := promptTplUserID(ctx)
	if err != nil {
		return nil, err
	}
	items, err := h.listRows(ctx, uid, false)
	if err != nil {
		return nil, err
	}
	out := &listPromptTemplatesOutput{}
	out.Body.Data = items
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

func (h *PromptTemplateHandler) adminList(ctx context.Context, _ *struct{}) (*listPromptTemplatesOutput, error) {
	uid, err := promptTplUserID(ctx)
	if err != nil {
		return nil, err
	}
	items, err := h.listRows(ctx, uid, true)
	if err != nil {
		return nil, err
	}
	out := &listPromptTemplatesOutput{}
	out.Body.Data = items
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

func (h *PromptTemplateHandler) create(ctx context.Context, input *createPromptTemplateInput) (*promptTemplateOutput, error) {
	uid, err := promptTplUserID(ctx)
	if err != nil {
		return nil, err
	}
	title := strings.TrimSpace(input.Body.Title)
	content := strings.TrimSpace(input.Body.Content)
	if title == "" || content == "" {
		return nil, huma.Error422UnprocessableEntity("Title and content are required")
	}
	row, err := h.q.InsertPromptTemplate(ctx, sqlc.InsertPromptTemplateParams{
		OwnerID: uid, Title: title, Content: content,
	})
	if err != nil {
		return nil, huma.Error500InternalServerError("Failed to save prompt template")
	}
	out := &promptTemplateOutput{}
	out.Body.Data = PromptTemplateItem{
		ID: uuidString(row.ID), Title: row.Title, Content: row.Content,
		IsMine: true, CreatedAt: row.CreatedAt.Time,
	}
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

func (h *PromptTemplateHandler) deleteOwn(ctx context.Context, input *promptTemplateIDInput) (*struct{}, error) {
	uid, err := promptTplUserID(ctx)
	if err != nil {
		return nil, err
	}
	var id pgtype.UUID
	if err := id.Scan(input.ID); err != nil {
		return nil, huma.Error422UnprocessableEntity("Invalid template id")
	}
	affected, err := h.q.DeletePromptTemplateByOwner(ctx, sqlc.DeletePromptTemplateByOwnerParams{ID: id, OwnerID: uid})
	if err != nil {
		return nil, huma.Error500InternalServerError("Failed to delete prompt template")
	}
	if affected == 0 {
		return nil, huma.Error404NotFound("Template not found or not yours")
	}
	return nil, nil
}

func (h *PromptTemplateHandler) adminDelete(ctx context.Context, input *promptTemplateIDInput) (*struct{}, error) {
	var id pgtype.UUID
	if err := id.Scan(input.ID); err != nil {
		return nil, huma.Error422UnprocessableEntity("Invalid template id")
	}
	if err := h.q.DeletePromptTemplateAdmin(ctx, id); err != nil {
		return nil, huma.Error500InternalServerError("Failed to delete prompt template")
	}
	return nil, nil
}

func (h *PromptTemplateHandler) vote(ctx context.Context, input *votePromptTemplateInput) (*struct{}, error) {
	uid, err := promptTplUserID(ctx)
	if err != nil {
		return nil, err
	}
	var id pgtype.UUID
	if err := id.Scan(input.ID); err != nil {
		return nil, huma.Error422UnprocessableEntity("Invalid template id")
	}
	if input.Body.Vote == 0 {
		if err := h.q.DeletePromptTemplateVote(ctx, sqlc.DeletePromptTemplateVoteParams{TemplateID: id, UserID: uid}); err != nil {
			return nil, huma.Error500InternalServerError("Failed to clear vote")
		}
		return nil, nil
	}
	if err := h.q.UpsertPromptTemplateVote(ctx, sqlc.UpsertPromptTemplateVoteParams{
		TemplateID: id, UserID: uid, Vote: int16(input.Body.Vote),
	}); err != nil {
		return nil, huma.Error500InternalServerError("Failed to vote")
	}
	return nil, nil
}

// uuidString formats a pgtype.UUID as the canonical string (empty when invalid).
func uuidString(u pgtype.UUID) string {
	if !u.Valid {
		return ""
	}
	b := u.Bytes
	const hexdigits = "0123456789abcdef"
	buf := make([]byte, 36)
	idx := 0
	for i, v := range b {
		if i == 4 || i == 6 || i == 8 || i == 10 {
			buf[idx] = '-'
			idx++
		}
		buf[idx] = hexdigits[v>>4]
		buf[idx+1] = hexdigits[v&0x0f]
		idx += 2
	}
	return string(buf)
}

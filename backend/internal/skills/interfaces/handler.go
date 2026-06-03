// Package interfaces holds the HTTP handlers for Skills & Agents.
package interfaces

import (
	"context"
	"encoding/json"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5/pgtype"

	"ccy-canvas/backend/internal/platform/authn"
	"ccy-canvas/backend/internal/platform/database/sqlc"
	"ccy-canvas/backend/internal/platform/httpapi"
	"ccy-canvas/backend/internal/shared/httpx"
)

// Handler wires Skills + Agents user-facing endpoints.
type Handler struct {
	q *sqlc.Queries
}

func NewHandler(q *sqlc.Queries) *Handler { return &Handler{q: q} }

var userSec = []map[string][]string{{httpapi.SecuritySchemeName: {}}}

func (h *Handler) RegisterRoutes(api huma.API) {
	// User-facing skills.
	huma.Register(api, huma.Operation{
		OperationID: "list-visible-skills",
		Method:      http.MethodGet,
		Path:        "/api/app/skills",
		Summary:     "List skills visible to the caller (global + own personal)",
		Tags:        []string{"App", "Skills"},
		Security:    userSec,
	}, h.listVisibleSkills)
	huma.Register(api, huma.Operation{
		OperationID:   "create-personal-skill",
		Method:        http.MethodPost,
		Path:          "/api/app/skills",
		Summary:       "Create a personal skill",
		Tags:          []string{"App", "Skills"},
		Security:      userSec,
		DefaultStatus: http.StatusCreated,
	}, h.createPersonalSkill)
	huma.Register(api, huma.Operation{
		OperationID: "update-personal-skill",
		Method:      http.MethodPut,
		Path:        "/api/app/skills/{id}",
		Summary:     "Update an owned personal skill",
		Tags:        []string{"App", "Skills"},
		Security:    userSec,
	}, h.updatePersonalSkill)
	huma.Register(api, huma.Operation{
		OperationID:   "delete-personal-skill",
		Method:        http.MethodDelete,
		Path:          "/api/app/skills/{id}",
		Summary:       "Delete an owned personal skill",
		Tags:          []string{"App", "Skills"},
		Security:      userSec,
		DefaultStatus: http.StatusNoContent,
	}, h.deletePersonalSkill)

	// User-facing agents.
	huma.Register(api, huma.Operation{
		OperationID: "list-visible-agents",
		Method:      http.MethodGet,
		Path:        "/api/app/agents",
		Tags:        []string{"App", "Agents"},
		Security:    userSec,
	}, h.listVisibleAgents)
	huma.Register(api, huma.Operation{
		OperationID:   "create-personal-agent",
		Method:        http.MethodPost,
		Path:          "/api/app/agents",
		Tags:          []string{"App", "Agents"},
		Security:      userSec,
		DefaultStatus: http.StatusCreated,
	}, h.createPersonalAgent)
	huma.Register(api, huma.Operation{
		OperationID: "update-personal-agent",
		Method:      http.MethodPut,
		Path:        "/api/app/agents/{id}",
		Tags:        []string{"App", "Agents"},
		Security:    userSec,
	}, h.updatePersonalAgent)
	huma.Register(api, huma.Operation{
		OperationID:   "delete-personal-agent",
		Method:        http.MethodDelete,
		Path:          "/api/app/agents/{id}",
		Tags:          []string{"App", "Agents"},
		Security:      userSec,
		DefaultStatus: http.StatusNoContent,
	}, h.deletePersonalAgent)
}

// ─── Types ───────────────────────────────────────────────────────────────────

type SkillItem struct {
	ID           string          `json:"id"`
	Scope        string          `json:"scope"`
	OwnerID      string          `json:"owner_id,omitempty"`
	Name         string          `json:"name"`
	Description  string          `json:"description"`
	Category     string          `json:"category"`
	Icon         string          `json:"icon"`
	Kind         string          `json:"kind"`
	Spec         json.RawMessage `json:"spec"`
	InputSchema  json.RawMessage `json:"input_schema"`
	OutputSchema json.RawMessage `json:"output_schema"`
	Enabled      bool            `json:"enabled"`
	CreatedAt    string          `json:"created_at"`
	UpdatedAt    string          `json:"updated_at"`
}

type SkillUpsertBody struct {
	Name         string          `json:"name" minLength:"1"`
	Description  string          `json:"description,omitempty"`
	Category     string          `json:"category,omitempty"`
	Icon         string          `json:"icon,omitempty"`
	Kind         string          `json:"kind" enum:"http,prompt,code"`
	Spec         json.RawMessage `json:"spec"`
	InputSchema  json.RawMessage `json:"input_schema,omitempty"`
	OutputSchema json.RawMessage `json:"output_schema,omitempty"`
	Enabled      bool            `json:"enabled"`
}

type AgentItem struct {
	ID           string   `json:"id"`
	Scope        string   `json:"scope"`
	OwnerID      string   `json:"owner_id,omitempty"`
	Name         string   `json:"name"`
	Description  string   `json:"description"`
	Avatar       string   `json:"avatar"`
	SystemPrompt string   `json:"system_prompt"`
	Model        string   `json:"model"`
	SkillIDs     []string `json:"skill_ids"`
	CanvasTools  bool     `json:"canvas_tools"`
	Strategy     string   `json:"strategy"`
	Enabled      bool     `json:"enabled"`
	CreatedAt    string   `json:"created_at"`
	UpdatedAt    string   `json:"updated_at"`
}

type AgentUpsertBody struct {
	Name         string   `json:"name" minLength:"1"`
	Description  string   `json:"description,omitempty"`
	Avatar       string   `json:"avatar,omitempty"`
	SystemPrompt string   `json:"system_prompt"`
	Model        string   `json:"model" minLength:"1"`
	SkillIDs     []string `json:"skill_ids,omitempty"`
	CanvasTools  bool     `json:"canvas_tools"`
	Strategy     string   `json:"strategy,omitempty" enum:"reactive,scripted"`
	Enabled      bool     `json:"enabled"`
}

// ─── Skill handlers ──────────────────────────────────────────────────────────

type listSkillsOutput struct {
	Body struct {
		Data      []SkillItem `json:"data"`
		RequestID string      `json:"request_id"`
	}
}

func (h *Handler) listVisibleSkills(ctx context.Context, _ *struct{}) (*listSkillsOutput, error) {
	uid := mustUserID(ctx)
	rows, err := h.q.ListVisibleSkills(ctx, uid)
	if err != nil {
		return nil, huma.Error500InternalServerError("Failed to list skills")
	}
	out := &listSkillsOutput{}
	for _, r := range rows {
		out.Body.Data = append(out.Body.Data, toSkillItem(r))
	}
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type createSkillInput struct {
	Body SkillUpsertBody
}
type skillOutput struct {
	Body struct {
		Data      SkillItem `json:"data"`
		RequestID string    `json:"request_id"`
	}
}

func (h *Handler) createPersonalSkill(ctx context.Context, input *createSkillInput) (*skillOutput, error) {
	uid := mustUserID(ctx)
	row, err := h.q.InsertSkill(ctx, sqlc.InsertSkillParams{
		Scope:        "personal",
		OwnerID:      uid,
		Name:         input.Body.Name,
		Description:  input.Body.Description,
		Category:     defaulted(input.Body.Category, "other"),
		Icon:         input.Body.Icon,
		Kind:         input.Body.Kind,
		Spec:         jsonOrEmpty(input.Body.Spec),
		InputSchema:  jsonOrEmpty(input.Body.InputSchema),
		OutputSchema: jsonOrEmpty(input.Body.OutputSchema),
		Enabled:      input.Body.Enabled,
	})
	if err != nil {
		return nil, huma.Error500InternalServerError("Failed to insert skill: " + err.Error())
	}
	return wrapSkill(ctx, row), nil
}

type updateSkillInput struct {
	ID   string `path:"id"`
	Body SkillUpsertBody
}

func (h *Handler) updatePersonalSkill(ctx context.Context, input *updateSkillInput) (*skillOutput, error) {
	pgID, err := parseUUID(input.ID)
	if err != nil {
		return nil, err
	}
	existing, err := h.q.GetSkill(ctx, pgID)
	if err != nil {
		return nil, huma.Error404NotFound("Skill not found")
	}
	if err := guardMutation(ctx, existing.Scope, existing.OwnerID); err != nil {
		return nil, err
	}
	row, err := h.q.UpdateSkill(ctx, sqlc.UpdateSkillParams{
		ID:           pgID,
		Name:         input.Body.Name,
		Description:  input.Body.Description,
		Category:     defaulted(input.Body.Category, existing.Category),
		Icon:         input.Body.Icon,
		Kind:         input.Body.Kind,
		Spec:         jsonOrEmpty(input.Body.Spec),
		InputSchema:  jsonOrEmpty(input.Body.InputSchema),
		OutputSchema: jsonOrEmpty(input.Body.OutputSchema),
		Enabled:      input.Body.Enabled,
	})
	if err != nil {
		return nil, huma.Error500InternalServerError("Failed to update skill")
	}
	return wrapSkill(ctx, row), nil
}

type deleteSkillInput struct {
	ID string `path:"id"`
}

func (h *Handler) deletePersonalSkill(ctx context.Context, input *deleteSkillInput) (*struct{}, error) {
	pgID, err := parseUUID(input.ID)
	if err != nil {
		return nil, err
	}
	existing, err := h.q.GetSkill(ctx, pgID)
	if err != nil {
		return nil, huma.Error404NotFound("Skill not found")
	}
	if err := guardMutation(ctx, existing.Scope, existing.OwnerID); err != nil {
		return nil, err
	}
	if err := h.q.DeleteSkill(ctx, pgID); err != nil {
		return nil, huma.Error500InternalServerError("Failed to delete skill")
	}
	return nil, nil
}

// ─── Agent handlers ──────────────────────────────────────────────────────────

type listAgentsOutput struct {
	Body struct {
		Data      []AgentItem `json:"data"`
		RequestID string      `json:"request_id"`
	}
}

func (h *Handler) listVisibleAgents(ctx context.Context, _ *struct{}) (*listAgentsOutput, error) {
	uid := mustUserID(ctx)
	rows, err := h.q.ListVisibleAgents(ctx, uid)
	if err != nil {
		return nil, huma.Error500InternalServerError("Failed to list agents")
	}
	out := &listAgentsOutput{}
	for _, r := range rows {
		out.Body.Data = append(out.Body.Data, toAgentItem(r))
	}
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type createAgentInput struct {
	Body AgentUpsertBody
}
type agentOutput struct {
	Body struct {
		Data      AgentItem `json:"data"`
		RequestID string    `json:"request_id"`
	}
}

func (h *Handler) createPersonalAgent(ctx context.Context, input *createAgentInput) (*agentOutput, error) {
	uid := mustUserID(ctx)
	skillIDs, err := parseUUIDList(input.Body.SkillIDs)
	if err != nil {
		return nil, err
	}
	row, err := h.q.InsertAgent(ctx, sqlc.InsertAgentParams{
		Scope:        "personal",
		OwnerID:      uid,
		Name:         input.Body.Name,
		Description:  input.Body.Description,
		Avatar:       input.Body.Avatar,
		SystemPrompt: input.Body.SystemPrompt,
		Model:        input.Body.Model,
		SkillIDs:     skillIDs,
		CanvasTools:  input.Body.CanvasTools,
		Strategy:     defaulted(input.Body.Strategy, "reactive"),
		Enabled:      input.Body.Enabled,
	})
	if err != nil {
		return nil, huma.Error500InternalServerError("Failed to insert agent: " + err.Error())
	}
	return wrapAgent(ctx, row), nil
}

type updateAgentInput struct {
	ID   string `path:"id"`
	Body AgentUpsertBody
}

func (h *Handler) updatePersonalAgent(ctx context.Context, input *updateAgentInput) (*agentOutput, error) {
	pgID, err := parseUUID(input.ID)
	if err != nil {
		return nil, err
	}
	existing, err := h.q.GetAgent(ctx, pgID)
	if err != nil {
		return nil, huma.Error404NotFound("Agent not found")
	}
	if err := guardMutation(ctx, existing.Scope, existing.OwnerID); err != nil {
		return nil, err
	}
	skillIDs, err := parseUUIDList(input.Body.SkillIDs)
	if err != nil {
		return nil, err
	}
	row, err := h.q.UpdateAgent(ctx, sqlc.UpdateAgentParams{
		ID:           pgID,
		Name:         input.Body.Name,
		Description:  input.Body.Description,
		Avatar:       input.Body.Avatar,
		SystemPrompt: input.Body.SystemPrompt,
		Model:        input.Body.Model,
		SkillIDs:     skillIDs,
		CanvasTools:  input.Body.CanvasTools,
		Strategy:     defaulted(input.Body.Strategy, existing.Strategy),
		Enabled:      input.Body.Enabled,
	})
	if err != nil {
		return nil, huma.Error500InternalServerError("Failed to update agent")
	}
	return wrapAgent(ctx, row), nil
}

type deleteAgentInput struct {
	ID string `path:"id"`
}

func (h *Handler) deletePersonalAgent(ctx context.Context, input *deleteAgentInput) (*struct{}, error) {
	pgID, err := parseUUID(input.ID)
	if err != nil {
		return nil, err
	}
	existing, err := h.q.GetAgent(ctx, pgID)
	if err != nil {
		return nil, huma.Error404NotFound("Agent not found")
	}
	if err := guardMutation(ctx, existing.Scope, existing.OwnerID); err != nil {
		return nil, err
	}
	if err := h.q.DeleteAgent(ctx, pgID); err != nil {
		return nil, huma.Error500InternalServerError("Failed to delete agent")
	}
	return nil, nil
}

// ─── helpers ────────────────────────────────────────────────────────────────

func wrapSkill(ctx context.Context, row sqlc.Skill) *skillOutput {
	out := &skillOutput{}
	out.Body.Data = toSkillItem(row)
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out
}

func wrapAgent(ctx context.Context, row sqlc.Agent) *agentOutput {
	out := &agentOutput{}
	out.Body.Data = toAgentItem(row)
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out
}

func toSkillItem(r sqlc.Skill) SkillItem {
	item := SkillItem{
		ID:           formatUUID(r.ID),
		Scope:        r.Scope,
		Name:         r.Name,
		Description:  r.Description,
		Category:     r.Category,
		Icon:         r.Icon,
		Kind:         r.Kind,
		Spec:         json.RawMessage(r.Spec),
		InputSchema:  json.RawMessage(r.InputSchema),
		OutputSchema: json.RawMessage(r.OutputSchema),
		Enabled:      r.Enabled,
		CreatedAt:    formatTime(r.CreatedAt),
		UpdatedAt:    formatTime(r.UpdatedAt),
	}
	if r.OwnerID.Valid {
		item.OwnerID = formatUUID(r.OwnerID)
	}
	return item
}

func toAgentItem(r sqlc.Agent) AgentItem {
	item := AgentItem{
		ID:           formatUUID(r.ID),
		Scope:        r.Scope,
		Name:         r.Name,
		Description:  r.Description,
		Avatar:       r.Avatar,
		SystemPrompt: r.SystemPrompt,
		Model:        r.Model,
		CanvasTools:  r.CanvasTools,
		Strategy:     r.Strategy,
		Enabled:      r.Enabled,
		CreatedAt:    formatTime(r.CreatedAt),
		UpdatedAt:    formatTime(r.UpdatedAt),
	}
	if r.OwnerID.Valid {
		item.OwnerID = formatUUID(r.OwnerID)
	}
	item.SkillIDs = make([]string, 0, len(r.SkillIDs))
	for _, sid := range r.SkillIDs {
		item.SkillIDs = append(item.SkillIDs, formatUUID(sid))
	}
	return item
}

// guardMutation rejects edits/deletes when the caller doesn't own the row.
// Personal rows must match owner; global rows can only be mutated by admin handlers.
func guardMutation(ctx context.Context, scope string, ownerID pgtype.UUID) error {
	claims, ok := authn.ClaimsFromContext(ctx)
	if !ok {
		return huma.Error401Unauthorized("Authentication required")
	}
	switch scope {
	case "global":
		// User endpoint never accepts mutations on globals.
		return huma.Error403Forbidden("Cannot modify a global resource via the user API")
	case "personal":
		var callerUUID pgtype.UUID
		_ = callerUUID.Scan(claims.UserID)
		if !ownerID.Valid || formatUUID(ownerID) != claims.UserID {
			return huma.Error403Forbidden("You can only modify your own resources")
		}
	}
	return nil
}

func mustUserID(ctx context.Context) pgtype.UUID {
	var u pgtype.UUID
	if claims, ok := authn.ClaimsFromContext(ctx); ok {
		_ = u.Scan(claims.UserID)
	}
	return u
}

func defaulted(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

func jsonOrEmpty(raw json.RawMessage) []byte {
	if len(raw) == 0 {
		return []byte("{}")
	}
	return []byte(raw)
}

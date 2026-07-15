// Package interfaces holds the HTTP handlers for Skills & Agents.
package interfaces

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"ccy-canvas/backend/internal/platform/authn"
	"ccy-canvas/backend/internal/platform/database/sqlc"
	"ccy-canvas/backend/internal/platform/httpapi"
	"ccy-canvas/backend/internal/shared/httpx"
	skillsapp "ccy-canvas/backend/internal/skills/application"
)

// Handler wires Skills + Agents user-facing endpoints.
type Handler struct {
	q        *sqlc.Queries
	executor *skillsapp.Executor
}

func NewHandler(q *sqlc.Queries, executor *skillsapp.Executor) *Handler {
	return &Handler{q: q, executor: executor}
}

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
	huma.Register(api, huma.Operation{
		OperationID: "invoke-skill",
		Method:      http.MethodPost,
		Path:        "/api/app/skills/{id}/invoke",
		Summary:     "Run a skill with the given JSON inputs",
		Tags:        []string{"App", "Skills"},
		Security:    userSec,
	}, h.invokeSkill)

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
	huma.Register(api, huma.Operation{
		OperationID: "list-agent-conversation-history",
		Method:      http.MethodGet,
		Path:        "/api/app/agents/{id}/conversation",
		Tags:        []string{"App", "Agents"},
		Security:    userSec,
	}, h.listAgentConversationHistory)
	huma.Register(api, huma.Operation{
		OperationID:   "clear-agent-conversation-history",
		Method:        http.MethodDelete,
		Path:          "/api/app/agents/{id}/conversation",
		Tags:          []string{"App", "Agents"},
		Security:      userSec,
		DefaultStatus: http.StatusNoContent,
	}, h.clearAgentConversationHistory)

	// Multi-thread conversations: list / create / delete individual threads.
	huma.Register(api, huma.Operation{
		OperationID: "list-agent-conversations",
		Method:      http.MethodGet,
		Path:        "/api/app/agents/{id}/conversations",
		Tags:        []string{"App", "Agents"},
		Security:    userSec,
	}, h.listAgentConversations)
	huma.Register(api, huma.Operation{
		OperationID:   "create-agent-conversation",
		Method:        http.MethodPost,
		Path:          "/api/app/agents/{id}/conversations",
		Tags:          []string{"App", "Agents"},
		Security:      userSec,
		DefaultStatus: http.StatusCreated,
	}, h.createAgentConversation)
	huma.Register(api, huma.Operation{
		OperationID:   "delete-agent-conversation",
		Method:        http.MethodDelete,
		Path:          "/api/app/agents/{id}/conversations/{conversation_id}",
		Tags:          []string{"App", "Agents"},
		Security:      userSec,
		DefaultStatus: http.StatusNoContent,
	}, h.deleteAgentConversation)
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
	ID              string          `json:"id"`
	Scope           string          `json:"scope"`
	OwnerID         string          `json:"owner_id,omitempty"`
	Name            string          `json:"name"`
	Description     string          `json:"description"`
	Avatar          string          `json:"avatar"`
	SystemPrompt    string          `json:"system_prompt"`
	Model           string          `json:"model"`
	SkillIDs        []string        `json:"skill_ids"`
	CanvasTools     bool            `json:"canvas_tools"`
	Strategy        string          `json:"strategy"`
	Enabled         bool            `json:"enabled"`
	CreatedAt       string          `json:"created_at"`
	UpdatedAt       string          `json:"updated_at"`
	DeployKey       string          `json:"deploy_key,omitempty"`
	ParentDeployKey string          `json:"parent_deploy_key,omitempty"`
	ModelName       string          `json:"model_name,omitempty"`
	ProviderID      string          `json:"provider_id,omitempty"`
	Temperature     float64         `json:"temperature,omitempty"`
	MaxOutputTokens int32           `json:"max_output_tokens,omitempty"`
	Runtime         string          `json:"runtime,omitempty"`
	Metadata        json.RawMessage `json:"metadata,omitempty"`
}

type AgentUpsertBody struct {
	Name            string          `json:"name" minLength:"1"`
	Description     string          `json:"description,omitempty"`
	Avatar          string          `json:"avatar,omitempty"`
	SystemPrompt    string          `json:"system_prompt"`
	Model           string          `json:"model"`
	SkillIDs        []string        `json:"skill_ids,omitempty"`
	CanvasTools     bool            `json:"canvas_tools"`
	Strategy        string          `json:"strategy,omitempty" enum:"reactive,scripted"`
	Enabled         bool            `json:"enabled"`
	DeployKey       string          `json:"deploy_key,omitempty"`
	ParentDeployKey string          `json:"parent_deploy_key,omitempty"`
	ModelName       string          `json:"model_name,omitempty"`
	ProviderID      string          `json:"provider_id,omitempty"`
	Temperature     float64         `json:"temperature,omitempty"`
	MaxOutputTokens int32           `json:"max_output_tokens,omitempty"`
	Runtime         string          `json:"runtime,omitempty"`
	Metadata        json.RawMessage `json:"metadata,omitempty"`
}

type AgentConversationItem struct {
	UserInput  string `json:"user_input"`
	FinalReply string `json:"final_reply"`
	CreatedAt  string `json:"created_at"`
}

type listAgentConversationInput struct {
	ID             string `path:"id"`
	ConversationID string `query:"conversation_id"`
	Limit          int32  `query:"limit" minimum:"1" maximum:"50" default:"12"`
}

type listAgentConversationOutput struct {
	Body struct {
		Data      []AgentConversationItem `json:"data"`
		RequestID string                  `json:"request_id"`
	}
}

// Per-thread conversation summary returned by listAgentConversations.
type AgentConversationSummary struct {
	ID            string `json:"id"`
	Title         string `json:"title"`
	MessageCount  int32  `json:"message_count"`
	LastMessageAt string `json:"last_message_at"`
	CreatedAt     string `json:"created_at"`
	UpdatedAt     string `json:"updated_at"`
}

type listAgentConversationsInput struct {
	ID string `path:"id"`
}

type listAgentConversationsOutput struct {
	Body struct {
		Data      []AgentConversationSummary `json:"data"`
		RequestID string                     `json:"request_id"`
	}
}

type createAgentConversationInput struct {
	ID   string `path:"id"`
	Body struct {
		Title string `json:"title,omitempty"`
	}
}

type createAgentConversationOutput struct {
	Body struct {
		Data      AgentConversationSummary `json:"data"`
		RequestID string                   `json:"request_id"`
	}
}

type deleteAgentConversationInput struct {
	ID             string `path:"id"`
	ConversationID string `path:"conversation_id"`
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
	out.Body.Data = make([]SkillItem, 0, len(rows))
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

// ─── Skill invocation ────────────────────────────────────────────────────────

type invokeSkillInput struct {
	ID   string `path:"id"`
	Body struct {
		Inputs json.RawMessage `json:"inputs,omitempty"`
	}
}

type invokeSkillOutput struct {
	Body struct {
		Data struct {
			Type       string          `json:"type"`
			Content    string          `json:"content"`
			Raw        json.RawMessage `json:"raw,omitempty"`
			RunID      string          `json:"run_id"`
			DurationMs int32           `json:"duration_ms"`
		} `json:"data"`
		RequestID string `json:"request_id"`
	}
}

func (h *Handler) invokeSkill(ctx context.Context, input *invokeSkillInput) (*invokeSkillOutput, error) {
	pgID, err := parseUUID(input.ID)
	if err != nil {
		return nil, err
	}
	skill, err := h.q.GetSkill(ctx, pgID)
	if err != nil {
		return nil, huma.Error404NotFound("Skill not found")
	}
	// Anyone can use a global skill; personal skills only by their owner.
	uid := mustUserID(ctx)
	if skill.Scope == "personal" {
		if !skill.OwnerID.Valid || formatUUID(skill.OwnerID) != formatUUID(uid) {
			return nil, huma.Error403Forbidden("Not allowed to invoke this skill")
		}
	}

	// Insert a pending log row up front so the run is tracked even if the
	// upstream call hangs / panics.
	rawInputs := input.Body.Inputs
	if len(rawInputs) == 0 {
		rawInputs = json.RawMessage("{}")
	}
	startedAt := time.Now()
	runRow, _ := h.q.InsertSkillRun(ctx, sqlc.InsertSkillRunParams{
		UserID: uid, SkillID: pgID,
		Inputs: rawInputs, Outputs: []byte("{}"),
		Status: "pending",
	})

	result, runErr := h.executor.Invoke(ctx, skill, rawInputs)
	durationMs := int32(time.Since(startedAt).Milliseconds())

	if runErr != nil {
		_ = h.q.UpdateSkillRunResult(ctx, sqlc.UpdateSkillRunResultParams{
			ID: runRow.ID, Outputs: []byte("{}"),
			Status: "error", ErrorMsg: runErr.Error(), DurationMs: durationMs,
		})
		return nil, huma.Error500InternalServerError("Skill execution failed: " + runErr.Error())
	}

	out := &invokeSkillOutput{}
	out.Body.Data.Type = result.Type
	out.Body.Data.Content = result.Content
	out.Body.Data.Raw = result.Raw
	out.Body.Data.RunID = formatUUID(runRow.ID)
	out.Body.Data.DurationMs = durationMs
	out.Body.RequestID = httpx.RequestIDFrom(ctx)

	outputsJSON, _ := json.Marshal(map[string]any{"type": result.Type, "content": result.Content})
	_ = h.q.UpdateSkillRunResult(ctx, sqlc.UpdateSkillRunResultParams{
		ID: runRow.ID, Outputs: outputsJSON,
		Status: "success", ErrorMsg: "", DurationMs: durationMs,
	})
	return out, nil
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
	out.Body.Data = make([]AgentItem, 0, len(rows))
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
		Scope:           "personal",
		OwnerID:         uid,
		Name:            input.Body.Name,
		Description:     input.Body.Description,
		Avatar:          input.Body.Avatar,
		SystemPrompt:    input.Body.SystemPrompt,
		Model:           input.Body.Model,
		SkillIDs:        skillIDs,
		CanvasTools:     input.Body.CanvasTools,
		Strategy:        defaulted(input.Body.Strategy, "reactive"),
		Enabled:         input.Body.Enabled,
		DeployKey:       input.Body.DeployKey,
		ParentDeployKey: input.Body.ParentDeployKey,
		ModelName:       input.Body.ModelName,
		ProviderID:      input.Body.ProviderID,
		Temperature:     defaultFloat(input.Body.Temperature, 1),
		MaxOutputTokens: input.Body.MaxOutputTokens,
		Runtime:         defaulted(input.Body.Runtime, "generic"),
		Metadata:        jsonOrEmpty(input.Body.Metadata),
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
		ID:              pgID,
		Name:            input.Body.Name,
		Description:     input.Body.Description,
		Avatar:          input.Body.Avatar,
		SystemPrompt:    input.Body.SystemPrompt,
		Model:           input.Body.Model,
		SkillIDs:        skillIDs,
		CanvasTools:     input.Body.CanvasTools,
		Strategy:        defaulted(input.Body.Strategy, existing.Strategy),
		Enabled:         input.Body.Enabled,
		DeployKey:       defaulted(input.Body.DeployKey, existing.DeployKey),
		ParentDeployKey: input.Body.ParentDeployKey,
		ModelName:       input.Body.ModelName,
		ProviderID:      input.Body.ProviderID,
		Temperature:     defaultFloat(input.Body.Temperature, 1),
		MaxOutputTokens: input.Body.MaxOutputTokens,
		Runtime:         defaulted(input.Body.Runtime, "generic"),
		Metadata:        jsonOrEmpty(input.Body.Metadata),
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

func (h *Handler) listAgentConversationHistory(ctx context.Context, input *listAgentConversationInput) (*listAgentConversationOutput, error) {
	agent, uid, err := h.loadReadableAgent(ctx, input.ID)
	if err != nil {
		return nil, err
	}

	conversation, err := h.resolveConversation(ctx, uid, agent.ID, input.ConversationID)
	if err != nil {
		if err == pgx.ErrNoRows {
			out := &listAgentConversationOutput{}
			out.Body.Data = []AgentConversationItem{}
			out.Body.RequestID = httpx.RequestIDFrom(ctx)
			return out, nil
		}
		return nil, huma.Error500InternalServerError("Failed to load conversation history")
	}

	// 一轮 run 最多写 3 行(user / tool_log / assistant),×3 保证 limit 轮完整。
	messages, err := h.q.ListAgentConversationMessages(ctx, sqlc.ListAgentConversationMessagesParams{
		ConversationID: conversation.ID,
		Limit:          input.Limit * 3,
	})
	if err != nil {
		return nil, huma.Error500InternalServerError("Failed to list conversation history")
	}

	out := &listAgentConversationOutput{}
	out.Body.Data = make([]AgentConversationItem, 0, len(messages)/2+1)
	out.Body.Data = append(out.Body.Data, toConversationItems(messages)...)
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

func (h *Handler) clearAgentConversationHistory(ctx context.Context, input *deleteAgentInput) (*struct{}, error) {
	agent, uid, err := h.loadReadableAgent(ctx, input.ID)
	if err != nil {
		return nil, err
	}

	if err := h.q.DeleteAgentConversationByUserAndAgent(ctx, sqlc.DeleteAgentConversationByUserAndAgentParams{
		UserID:  uid,
		AgentID: agent.ID,
	}); err != nil {
		return nil, huma.Error500InternalServerError("Failed to clear conversation history")
	}
	return nil, nil
}

// listAgentConversations returns all chat threads the user owns with this agent,
// most recently updated first. Powers the conversation switcher in the UI.
func (h *Handler) listAgentConversations(ctx context.Context, input *listAgentConversationsInput) (*listAgentConversationsOutput, error) {
	agent, uid, err := h.loadReadableAgent(ctx, input.ID)
	if err != nil {
		return nil, err
	}
	rows, err := h.q.ListUserAgentConversations(ctx, sqlc.ListUserAgentConversationsParams{
		UserID:  uid,
		AgentID: agent.ID,
	})
	if err != nil {
		return nil, huma.Error500InternalServerError("Failed to list conversations")
	}
	out := &listAgentConversationsOutput{}
	out.Body.Data = make([]AgentConversationSummary, 0, len(rows))
	for _, r := range rows {
		out.Body.Data = append(out.Body.Data, AgentConversationSummary{
			ID:            formatUUID(r.ID),
			Title:         r.Title,
			MessageCount:  r.MessageCount,
			LastMessageAt: formatTime(r.LastMessageAt),
			CreatedAt:     formatTime(r.CreatedAt),
			UpdatedAt:     formatTime(r.UpdatedAt),
		})
	}
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

// createAgentConversation starts a fresh chat thread. The title is optional —
// if blank, the runner will auto-populate it from the first user message.
func (h *Handler) createAgentConversation(ctx context.Context, input *createAgentConversationInput) (*createAgentConversationOutput, error) {
	agent, uid, err := h.loadReadableAgent(ctx, input.ID)
	if err != nil {
		return nil, err
	}
	row, err := h.q.InsertAgentConversation(ctx, sqlc.InsertAgentConversationParams{
		UserID:  uid,
		AgentID: agent.ID,
		Title:   input.Body.Title,
	})
	if err != nil {
		return nil, huma.Error500InternalServerError("Failed to create conversation")
	}
	out := &createAgentConversationOutput{}
	out.Body.Data = AgentConversationSummary{
		ID:            formatUUID(row.ID),
		Title:         row.Title,
		MessageCount:  0,
		LastMessageAt: formatTime(row.LastMessageAt),
		CreatedAt:     formatTime(row.CreatedAt),
		UpdatedAt:     formatTime(row.UpdatedAt),
	}
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

func (h *Handler) deleteAgentConversation(ctx context.Context, input *deleteAgentConversationInput) (*struct{}, error) {
	agent, uid, err := h.loadReadableAgent(ctx, input.ID)
	if err != nil {
		return nil, err
	}
	cid, err := parseUUID(input.ConversationID)
	if err != nil {
		return nil, err
	}
	if err := h.q.DeleteAgentConversationByID(ctx, sqlc.DeleteAgentConversationByIDParams{
		ID:      cid,
		UserID:  uid,
		AgentID: agent.ID,
	}); err != nil {
		return nil, huma.Error500InternalServerError("Failed to delete conversation")
	}
	return nil, nil
}

// resolveConversation returns the conversation row identified by conversationID,
// or — when conversationID is empty — the most recently updated conversation
// for the (user, agent) pair. Returns pgx.ErrNoRows when nothing exists yet.
func (h *Handler) resolveConversation(ctx context.Context, uid, agentID pgtype.UUID, conversationID string) (sqlc.AgentConversation, error) {
	if conversationID != "" {
		cid, err := parseUUID(conversationID)
		if err != nil {
			return sqlc.AgentConversation{}, err
		}
		return h.q.GetAgentConversationByID(ctx, sqlc.GetAgentConversationByIDParams{
			ID:      cid,
			UserID:  uid,
			AgentID: agentID,
		})
	}
	return h.q.GetAgentConversationByUserAndAgent(ctx, sqlc.GetAgentConversationByUserAndAgentParams{
		UserID:  uid,
		AgentID: agentID,
	})
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

func toAdminAgentItem(r sqlc.Agent) AgentItem {
	item := toAgentItem(r)
	item.DeployKey = r.DeployKey
	item.ParentDeployKey = r.ParentDeployKey
	item.ModelName = r.ModelName
	item.ProviderID = r.ProviderID
	item.Temperature = r.Temperature
	item.MaxOutputTokens = r.MaxOutputTokens
	item.Runtime = r.Runtime
	if len(r.Metadata) > 0 {
		item.Metadata = json.RawMessage(r.Metadata)
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

func defaultFloat(value, fallback float64) float64 {
	if value == 0 {
		return fallback
	}
	return value
}

// agentAccessibleBy reports whether userID may read/run the agent. Personal-scope
// agents are owner-only; other scopes are open to any authenticated user. Shared
// by BOTH the huma CRUD path (loadReadableAgent) and the chi-direct SSE run path
// (runAgent) so the two can never drift on this authorization rule.
func agentAccessibleBy(agent sqlc.Agent, userID pgtype.UUID) bool {
	if agent.Scope != "personal" {
		return true
	}
	return agent.OwnerID.Valid && formatUUID(agent.OwnerID) == formatUUID(userID)
}

func (h *Handler) loadReadableAgent(ctx context.Context, agentID string) (sqlc.Agent, pgtype.UUID, error) {
	pgID, err := parseUUID(agentID)
	if err != nil {
		return sqlc.Agent{}, pgtype.UUID{}, err
	}
	agent, err := h.q.GetAgent(ctx, pgID)
	if err != nil {
		return sqlc.Agent{}, pgtype.UUID{}, huma.Error404NotFound("Agent not found")
	}
	uid := mustUserID(ctx)
	if !agentAccessibleBy(agent, uid) {
		return sqlc.Agent{}, pgtype.UUID{}, huma.Error403Forbidden("Not allowed to access this agent")
	}
	return agent, uid, nil
}

// toConversationItems 把按时间序的消息行折叠成 (user_input, final_reply) 轮次。
// 按角色扫描配对,而不是固定步长 2:一轮 run 会写 user / tool_log / assistant
// 三行,内部角色(tool_log)不进 UI 历史,硬配对会让所有后续轮次错位。
func toConversationItems(messages []sqlc.AgentConversationMessage) []AgentConversationItem {
	items := make([]AgentConversationItem, 0, len(messages)/2+1)
	open := -1 // 等待 assistant 回复的未闭合轮次下标
	for _, m := range messages {
		switch m.Role {
		case "user":
			items = append(items, AgentConversationItem{
				UserInput: m.Content,
				CreatedAt: formatTime(m.CreatedAt),
			})
			open = len(items) - 1
		case "assistant":
			if open >= 0 && items[open].FinalReply == "" {
				items[open].FinalReply = m.Content
			} else {
				items = append(items, AgentConversationItem{
					FinalReply: m.Content,
					CreatedAt:  formatTime(m.CreatedAt),
				})
			}
			open = -1
		default:
			// tool_log 等内部记录:仅供下一轮 system prompt 注入,不进 UI。
		}
	}
	return items
}

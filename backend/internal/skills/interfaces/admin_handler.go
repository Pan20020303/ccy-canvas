package interfaces

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/jackc/pgx/v5/pgtype"

	"ccy-canvas/backend/internal/platform/authn"
	"ccy-canvas/backend/internal/platform/database/sqlc"
	"ccy-canvas/backend/internal/platform/httpapi"
	"ccy-canvas/backend/internal/shared/httpx"
	skillsapp "ccy-canvas/backend/internal/skills/application"
)

// AdminHandler exposes admin-side CRUD on global skills + agents.
type AdminHandler struct {
	q *sqlc.Queries
}

func NewAdminHandler(q *sqlc.Queries) *AdminHandler { return &AdminHandler{q: q} }

var adminSec = []map[string][]string{{httpapi.SecuritySchemeName: {authn.ScopeAdmin}}}

func (h *AdminHandler) RegisterRoutes(api huma.API) {
	huma.Register(api, huma.Operation{
		OperationID: "admin-list-skills",
		Method:      http.MethodGet,
		Path:        "/api/admin/skills",
		Summary:     "List all skills across scopes",
		Tags:        []string{"Admin", "Skills"},
		Security:    adminSec,
	}, h.listAllSkills)
	huma.Register(api, huma.Operation{
		OperationID:   "admin-create-skill",
		Method:        http.MethodPost,
		Path:          "/api/admin/skills",
		Summary:       "Create a global skill (admin-managed, visible to all)",
		Tags:          []string{"Admin", "Skills"},
		Security:      adminSec,
		DefaultStatus: http.StatusCreated,
	}, h.createGlobalSkill)
	huma.Register(api, huma.Operation{
		OperationID: "admin-update-skill",
		Method:      http.MethodPut,
		Path:        "/api/admin/skills/{id}",
		Tags:        []string{"Admin", "Skills"},
		Security:    adminSec,
	}, h.updateAnySkill)
	huma.Register(api, huma.Operation{
		OperationID:   "admin-delete-skill",
		Method:        http.MethodDelete,
		Path:          "/api/admin/skills/{id}",
		Tags:          []string{"Admin", "Skills"},
		Security:      adminSec,
		DefaultStatus: http.StatusNoContent,
	}, h.deleteAnySkill)

	huma.Register(api, huma.Operation{
		OperationID: "admin-list-agents",
		Method:      http.MethodGet,
		Path:        "/api/admin/agents",
		Tags:        []string{"Admin", "Agents"},
		Security:    adminSec,
	}, h.listAllAgents)
	huma.Register(api, huma.Operation{
		OperationID:   "admin-create-agent",
		Method:        http.MethodPost,
		Path:          "/api/admin/agents",
		Tags:          []string{"Admin", "Agents"},
		Security:      adminSec,
		DefaultStatus: http.StatusCreated,
	}, h.createGlobalAgent)
	huma.Register(api, huma.Operation{
		OperationID: "admin-update-agent",
		Method:      http.MethodPut,
		Path:        "/api/admin/agents/{id}",
		Tags:        []string{"Admin", "Agents"},
		Security:    adminSec,
	}, h.updateAnyAgent)
	huma.Register(api, huma.Operation{
		OperationID:   "admin-delete-agent",
		Method:        http.MethodDelete,
		Path:          "/api/admin/agents/{id}",
		Tags:          []string{"Admin", "Agents"},
		Security:      adminSec,
		DefaultStatus: http.StatusNoContent,
	}, h.deleteAnyAgent)

	huma.Register(api, huma.Operation{
		OperationID: "admin-list-agent-runs",
		Method:      http.MethodGet,
		Path:        "/api/admin/agent-runs",
		Summary:     "List agent run history",
		Tags:        []string{"Admin", "Agents"},
		Security:    adminSec,
	}, h.listAgentRuns)
	huma.Register(api, huma.Operation{
		OperationID: "admin-get-agent-use-mode",
		Method:      http.MethodGet,
		Path:        "/api/admin/agent-settings/use-mode",
		Tags:        []string{"Admin", "Agents"},
		Security:    adminSec,
	}, h.getAgentUseMode)
	huma.Register(api, huma.Operation{
		OperationID: "admin-update-agent-use-mode",
		Method:      http.MethodPut,
		Path:        "/api/admin/agent-settings/use-mode",
		Tags:        []string{"Admin", "Agents"},
		Security:    adminSec,
	}, h.updateAgentUseMode)
	huma.Register(api, huma.Operation{
		OperationID: "admin-get-agent-memory-settings",
		Method:      http.MethodGet,
		Path:        "/api/admin/agent-memory-settings",
		Tags:        []string{"Admin", "Agents"},
		Security:    adminSec,
	}, h.getAgentMemorySettings)
	huma.Register(api, huma.Operation{
		OperationID: "admin-update-agent-memory-settings",
		Method:      http.MethodPut,
		Path:        "/api/admin/agent-memory-settings",
		Tags:        []string{"Admin", "Agents"},
		Security:    adminSec,
	}, h.updateAgentMemorySettings)
	huma.Register(api, huma.Operation{
		OperationID:   "admin-seed-creator-suite-agents",
		Method:        http.MethodPost,
		Path:          "/api/admin/agents/seed-suite",
		Tags:          []string{"Admin", "Agents"},
		Security:      adminSec,
		DefaultStatus: http.StatusCreated,
	}, h.seedCreatorSuiteAgents)
}

// ─── Agent runs ──────────────────────────────────────────────────────────────

type listAgentRunsInput struct {
	Limit  int32 `query:"limit" minimum:"1" maximum:"200" default:"100"`
	Offset int32 `query:"offset" minimum:"0" default:"0"`
}

type AgentRunItem struct {
	ID         string `json:"id"`
	UserID     string `json:"user_id"`
	UserName   string `json:"user_name"`
	UserEmail  string `json:"user_email"`
	AgentID    string `json:"agent_id"`
	AgentName  string `json:"agent_name"`
	UserInput  string `json:"user_input"`
	FinalReply string `json:"final_reply"`
	ToolCalls  int32  `json:"tool_calls"`
	Steps      int32  `json:"steps"`
	Status     string `json:"status"`
	ErrorMsg   string `json:"error_msg"`
	DurationMs int32  `json:"duration_ms"`
	CreatedAt  string `json:"created_at"`
}

type listAgentRunsOutput struct {
	Body struct {
		Data      []AgentRunItem `json:"data"`
		RequestID string         `json:"request_id"`
	}
}

func (h *AdminHandler) listAgentRuns(ctx context.Context, input *listAgentRunsInput) (*listAgentRunsOutput, error) {
	rows, err := h.q.ListAgentRuns(ctx, sqlc.ListAgentRunsParams{Limit: input.Limit, Offset: input.Offset})
	if err != nil {
		return nil, huma.Error500InternalServerError("Failed to list agent runs")
	}
	out := &listAgentRunsOutput{}
	out.Body.Data = make([]AgentRunItem, 0, len(rows))
	for _, r := range rows {
		out.Body.Data = append(out.Body.Data, AgentRunItem{
			ID: formatUUID(r.ID), UserID: formatUUID(r.UserID), UserName: r.UserName, UserEmail: r.UserEmail,
			AgentID: formatUUID(r.AgentID), AgentName: r.AgentName, UserInput: r.UserInput, FinalReply: r.FinalReply,
			ToolCalls: r.ToolCalls, Steps: r.Steps, Status: r.Status, ErrorMsg: r.ErrorMsg, DurationMs: r.DurationMs,
			CreatedAt: formatTime(r.CreatedAt),
		})
	}
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

func (h *AdminHandler) listAllSkills(ctx context.Context, _ *struct{}) (*listSkillsOutput, error) {
	rows, err := h.q.ListAllSkills(ctx)
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

func (h *AdminHandler) createGlobalSkill(ctx context.Context, input *createSkillInput) (*skillOutput, error) {
	var noOwner pgtype.UUID // invalid, NULL
	row, err := h.q.InsertSkill(ctx, sqlc.InsertSkillParams{
		Scope:        "global",
		OwnerID:      noOwner,
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
		return nil, huma.Error500InternalServerError("Failed to insert global skill: " + err.Error())
	}
	return wrapSkill(ctx, row), nil
}

func (h *AdminHandler) updateAnySkill(ctx context.Context, input *updateSkillInput) (*skillOutput, error) {
	pgID, err := parseUUID(input.ID)
	if err != nil {
		return nil, err
	}
	existing, err := h.q.GetSkill(ctx, pgID)
	if err != nil {
		return nil, huma.Error404NotFound("Skill not found")
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

func (h *AdminHandler) deleteAnySkill(ctx context.Context, input *deleteSkillInput) (*struct{}, error) {
	pgID, err := parseUUID(input.ID)
	if err != nil {
		return nil, err
	}
	if err := h.q.DeleteSkill(ctx, pgID); err != nil {
		return nil, huma.Error500InternalServerError("Failed to delete skill")
	}
	return nil, nil
}

func (h *AdminHandler) listAllAgents(ctx context.Context, _ *struct{}) (*listAgentsOutput, error) {
	rows, err := h.q.ListAllAgents(ctx)
	if err != nil {
		return nil, huma.Error500InternalServerError("Failed to list agents")
	}
	out := &listAgentsOutput{}
	out.Body.Data = make([]AgentItem, 0, len(rows))
	for _, r := range rows {
		out.Body.Data = append(out.Body.Data, toAdminAgentItem(r))
	}
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

func (h *AdminHandler) createGlobalAgent(ctx context.Context, input *createAgentInput) (*agentOutput, error) {
	var noOwner pgtype.UUID
	skillIDs, err := parseUUIDList(input.Body.SkillIDs)
	if err != nil {
		return nil, err
	}
	row, err := h.q.InsertAgent(ctx, sqlc.InsertAgentParams{
		Scope:           "global",
		OwnerID:         noOwner,
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
		return nil, huma.Error500InternalServerError("Failed to insert global agent: " + err.Error())
	}
	return wrapAdminAgent(ctx, row), nil
}

func (h *AdminHandler) updateAnyAgent(ctx context.Context, input *updateAgentInput) (*agentOutput, error) {
	pgID, err := parseUUID(input.ID)
	if err != nil {
		return nil, err
	}
	existing, err := h.q.GetAgent(ctx, pgID)
	if err != nil {
		return nil, huma.Error404NotFound("Agent not found")
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
	return wrapAdminAgent(ctx, row), nil
}

func (h *AdminHandler) deleteAnyAgent(ctx context.Context, input *deleteAgentInput) (*struct{}, error) {
	pgID, err := parseUUID(input.ID)
	if err != nil {
		return nil, err
	}
	if err := h.q.DeleteAgent(ctx, pgID); err != nil {
		return nil, huma.Error500InternalServerError("Failed to delete agent")
	}
	return nil, nil
}

// keep time package linked (used by uuid helper file ordering); silenced.
var _ = time.Now

func wrapAdminAgent(ctx context.Context, row sqlc.Agent) *agentOutput {
	out := &agentOutput{}
	out.Body.Data = toAdminAgentItem(row)
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out
}

type agentUseModeOutput struct {
	Body struct {
		Data struct {
			Mode int32 `json:"mode"`
		} `json:"data"`
		RequestID string `json:"request_id"`
	}
}

type updateAgentUseModeInput struct {
	Body struct {
		Mode int32 `json:"mode"`
	}
}

func (h *AdminHandler) getAgentUseMode(ctx context.Context, _ *struct{}) (*agentUseModeOutput, error) {
	mode := skillsapp.AgentUseModeSimple
	if row, err := h.q.GetAgentSetting(ctx, skillsapp.AgentUseModeSettingKey); err == nil {
		var payload struct {
			Mode int32 `json:"mode"`
		}
		if err := json.Unmarshal(row.Value, &payload); err == nil && payload.Mode == skillsapp.AgentUseModeAdvanced {
			mode = skillsapp.AgentUseModeAdvanced
		}
	}
	out := &agentUseModeOutput{}
	out.Body.Data.Mode = mode
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

func (h *AdminHandler) updateAgentUseMode(ctx context.Context, input *updateAgentUseModeInput) (*agentUseModeOutput, error) {
	mode := input.Body.Mode
	if mode != skillsapp.AgentUseModeAdvanced {
		mode = skillsapp.AgentUseModeSimple
	}
	payload, _ := json.Marshal(map[string]int32{"mode": mode})
	if _, err := h.q.UpsertAgentSetting(ctx, sqlc.UpsertAgentSettingParams{Key: skillsapp.AgentUseModeSettingKey, Value: payload}); err != nil {
		return nil, huma.Error500InternalServerError("Failed to save agent use mode")
	}
	out := &agentUseModeOutput{}
	out.Body.Data.Mode = mode
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type memorySettingsOutput struct {
	Body struct {
		Data      json.RawMessage `json:"data"`
		RequestID string          `json:"request_id"`
	}
}

type updateMemorySettingsInput struct {
	Body json.RawMessage
}

var defaultAgentMemorySettings = json.RawMessage(`{"messagesPerSummary":3,"shortTermLimit":5,"summaryMaxLength":500,"summaryLimit":10,"ragLimit":3,"deepRetrieveSummaryLimit":5,"modelOnnxFile":"all-MiniLM-L6-v2/onnx/model_fp16.onnx","modelDtype":"fp16"}`)

func (h *AdminHandler) getAgentMemorySettings(ctx context.Context, _ *struct{}) (*memorySettingsOutput, error) {
	data := defaultAgentMemorySettings
	if row, err := h.q.GetAgentSetting(ctx, skillsapp.AgentMemorySettingsKey); err == nil && len(row.Value) > 0 {
		data = json.RawMessage(row.Value)
	}
	out := &memorySettingsOutput{}
	out.Body.Data = data
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

func (h *AdminHandler) updateAgentMemorySettings(ctx context.Context, input *updateMemorySettingsInput) (*memorySettingsOutput, error) {
	payload := jsonOrEmpty(input.Body)
	if _, err := h.q.UpsertAgentSetting(ctx, sqlc.UpsertAgentSettingParams{Key: skillsapp.AgentMemorySettingsKey, Value: payload}); err != nil {
		return nil, huma.Error500InternalServerError("Failed to save memory settings")
	}
	out := &memorySettingsOutput{}
	out.Body.Data = json.RawMessage(payload)
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type seedSuiteOutput struct {
	Body struct {
		Data      skillsapp.CreatorSuiteAgentSeedReport `json:"data"`
		RequestID string                                `json:"request_id"`
	}
}

func (h *AdminHandler) seedCreatorSuiteAgents(ctx context.Context, _ *struct{}) (*seedSuiteOutput, error) {
	report, err := skillsapp.EnsureCreatorSuiteAgentSeeds(ctx, h.q)
	if err != nil {
		return nil, huma.Error500InternalServerError("Failed to seed creator suite agents: " + err.Error())
	}
	out := &seedSuiteOutput{}
	out.Body.Data = report
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

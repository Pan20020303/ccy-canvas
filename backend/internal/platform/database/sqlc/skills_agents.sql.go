// Hand-authored sqlc-style bindings for skills + agents.
// Mirrors the conventions used by the generated files; safe to regenerate
// later with `sqlc generate` if/when the toolchain is wired up.

package sqlc

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
)

// ────────────────────────── Skill model ──────────────────────────

type Skill struct {
	ID           pgtype.UUID        `json:"id"`
	Scope        string             `json:"scope"`
	OwnerID      pgtype.UUID        `json:"owner_id"`
	Name         string             `json:"name"`
	Description  string             `json:"description"`
	Category     string             `json:"category"`
	Icon         string             `json:"icon"`
	Kind         string             `json:"kind"`
	Spec         []byte             `json:"spec"`
	InputSchema  []byte             `json:"input_schema"`
	OutputSchema []byte             `json:"output_schema"`
	Enabled      bool               `json:"enabled"`
	CreatedAt    pgtype.Timestamptz `json:"created_at"`
	UpdatedAt    pgtype.Timestamptz `json:"updated_at"`
}

const listVisibleSkills = `-- name: ListVisibleSkills :many
SELECT id, scope, owner_id, name, description, category, icon, kind, spec, input_schema, output_schema, enabled, created_at, updated_at
FROM skills
WHERE enabled = TRUE
  AND (scope = 'global' OR (scope = 'personal' AND owner_id = $1))
ORDER BY scope ASC, created_at DESC
`

func (q *Queries) ListVisibleSkills(ctx context.Context, ownerID pgtype.UUID) ([]Skill, error) {
	rows, err := q.db.Query(ctx, listVisibleSkills, ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Skill{}
	for rows.Next() {
		var i Skill
		if err := rows.Scan(&i.ID, &i.Scope, &i.OwnerID, &i.Name, &i.Description, &i.Category, &i.Icon, &i.Kind, &i.Spec, &i.InputSchema, &i.OutputSchema, &i.Enabled, &i.CreatedAt, &i.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	return items, rows.Err()
}

const listAllSkills = `-- name: ListAllSkills :many
SELECT id, scope, owner_id, name, description, category, icon, kind, spec, input_schema, output_schema, enabled, created_at, updated_at
FROM skills
ORDER BY scope ASC, created_at DESC
`

func (q *Queries) ListAllSkills(ctx context.Context) ([]Skill, error) {
	rows, err := q.db.Query(ctx, listAllSkills)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Skill{}
	for rows.Next() {
		var i Skill
		if err := rows.Scan(&i.ID, &i.Scope, &i.OwnerID, &i.Name, &i.Description, &i.Category, &i.Icon, &i.Kind, &i.Spec, &i.InputSchema, &i.OutputSchema, &i.Enabled, &i.CreatedAt, &i.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	return items, rows.Err()
}

const getSkill = `-- name: GetSkill :one
SELECT id, scope, owner_id, name, description, category, icon, kind, spec, input_schema, output_schema, enabled, created_at, updated_at
FROM skills WHERE id = $1
`

func (q *Queries) GetSkill(ctx context.Context, id pgtype.UUID) (Skill, error) {
	row := q.db.QueryRow(ctx, getSkill, id)
	var i Skill
	err := row.Scan(&i.ID, &i.Scope, &i.OwnerID, &i.Name, &i.Description, &i.Category, &i.Icon, &i.Kind, &i.Spec, &i.InputSchema, &i.OutputSchema, &i.Enabled, &i.CreatedAt, &i.UpdatedAt)
	return i, err
}

type InsertSkillParams struct {
	Scope        string      `json:"scope"`
	OwnerID      pgtype.UUID `json:"owner_id"`
	Name         string      `json:"name"`
	Description  string      `json:"description"`
	Category     string      `json:"category"`
	Icon         string      `json:"icon"`
	Kind         string      `json:"kind"`
	Spec         []byte      `json:"spec"`
	InputSchema  []byte      `json:"input_schema"`
	OutputSchema []byte      `json:"output_schema"`
	Enabled      bool        `json:"enabled"`
}

const insertSkill = `-- name: InsertSkill :one
INSERT INTO skills (scope, owner_id, name, description, category, icon, kind, spec, input_schema, output_schema, enabled)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
RETURNING id, scope, owner_id, name, description, category, icon, kind, spec, input_schema, output_schema, enabled, created_at, updated_at
`

func (q *Queries) InsertSkill(ctx context.Context, arg InsertSkillParams) (Skill, error) {
	row := q.db.QueryRow(ctx, insertSkill,
		arg.Scope, arg.OwnerID, arg.Name, arg.Description, arg.Category, arg.Icon, arg.Kind, arg.Spec, arg.InputSchema, arg.OutputSchema, arg.Enabled)
	var i Skill
	err := row.Scan(&i.ID, &i.Scope, &i.OwnerID, &i.Name, &i.Description, &i.Category, &i.Icon, &i.Kind, &i.Spec, &i.InputSchema, &i.OutputSchema, &i.Enabled, &i.CreatedAt, &i.UpdatedAt)
	return i, err
}

type UpdateSkillParams struct {
	ID           pgtype.UUID `json:"id"`
	Name         string      `json:"name"`
	Description  string      `json:"description"`
	Category     string      `json:"category"`
	Icon         string      `json:"icon"`
	Kind         string      `json:"kind"`
	Spec         []byte      `json:"spec"`
	InputSchema  []byte      `json:"input_schema"`
	OutputSchema []byte      `json:"output_schema"`
	Enabled      bool        `json:"enabled"`
}

const updateSkill = `-- name: UpdateSkill :one
UPDATE skills
SET name = $2, description = $3, category = $4, icon = $5, kind = $6,
    spec = $7, input_schema = $8, output_schema = $9, enabled = $10,
    updated_at = now()
WHERE id = $1
RETURNING id, scope, owner_id, name, description, category, icon, kind, spec, input_schema, output_schema, enabled, created_at, updated_at
`

func (q *Queries) UpdateSkill(ctx context.Context, arg UpdateSkillParams) (Skill, error) {
	row := q.db.QueryRow(ctx, updateSkill,
		arg.ID, arg.Name, arg.Description, arg.Category, arg.Icon, arg.Kind,
		arg.Spec, arg.InputSchema, arg.OutputSchema, arg.Enabled)
	var i Skill
	err := row.Scan(&i.ID, &i.Scope, &i.OwnerID, &i.Name, &i.Description, &i.Category, &i.Icon, &i.Kind, &i.Spec, &i.InputSchema, &i.OutputSchema, &i.Enabled, &i.CreatedAt, &i.UpdatedAt)
	return i, err
}

const deleteSkill = `-- name: DeleteSkill :exec
DELETE FROM skills WHERE id = $1
`

func (q *Queries) DeleteSkill(ctx context.Context, id pgtype.UUID) error {
	_, err := q.db.Exec(ctx, deleteSkill, id)
	return err
}

// ────────────────────────── Agent model ──────────────────────────

type Agent struct {
	ID           pgtype.UUID        `json:"id"`
	Scope        string             `json:"scope"`
	OwnerID      pgtype.UUID        `json:"owner_id"`
	Name         string             `json:"name"`
	Description  string             `json:"description"`
	Avatar       string             `json:"avatar"`
	SystemPrompt string             `json:"system_prompt"`
	Model        string             `json:"model"`
	SkillIDs     []pgtype.UUID      `json:"skill_ids"`
	CanvasTools  bool               `json:"canvas_tools"`
	Strategy     string             `json:"strategy"`
	Enabled      bool               `json:"enabled"`
	CreatedAt    pgtype.Timestamptz `json:"created_at"`
	UpdatedAt    pgtype.Timestamptz `json:"updated_at"`
}

const listVisibleAgents = `-- name: ListVisibleAgents :many
SELECT id, scope, owner_id, name, description, avatar, system_prompt, model, skill_ids, canvas_tools, strategy, enabled, created_at, updated_at
FROM agents
WHERE enabled = TRUE
  AND (scope = 'global' OR (scope = 'personal' AND owner_id = $1))
ORDER BY scope ASC, created_at DESC
`

func (q *Queries) ListVisibleAgents(ctx context.Context, ownerID pgtype.UUID) ([]Agent, error) {
	rows, err := q.db.Query(ctx, listVisibleAgents, ownerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Agent{}
	for rows.Next() {
		var i Agent
		if err := rows.Scan(&i.ID, &i.Scope, &i.OwnerID, &i.Name, &i.Description, &i.Avatar, &i.SystemPrompt, &i.Model, &i.SkillIDs, &i.CanvasTools, &i.Strategy, &i.Enabled, &i.CreatedAt, &i.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	return items, rows.Err()
}

const listAllAgents = `-- name: ListAllAgents :many
SELECT id, scope, owner_id, name, description, avatar, system_prompt, model, skill_ids, canvas_tools, strategy, enabled, created_at, updated_at
FROM agents
ORDER BY scope ASC, created_at DESC
`

func (q *Queries) ListAllAgents(ctx context.Context) ([]Agent, error) {
	rows, err := q.db.Query(ctx, listAllAgents)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Agent{}
	for rows.Next() {
		var i Agent
		if err := rows.Scan(&i.ID, &i.Scope, &i.OwnerID, &i.Name, &i.Description, &i.Avatar, &i.SystemPrompt, &i.Model, &i.SkillIDs, &i.CanvasTools, &i.Strategy, &i.Enabled, &i.CreatedAt, &i.UpdatedAt); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	return items, rows.Err()
}

const getAgent = `-- name: GetAgent :one
SELECT id, scope, owner_id, name, description, avatar, system_prompt, model, skill_ids, canvas_tools, strategy, enabled, created_at, updated_at
FROM agents WHERE id = $1
`

func (q *Queries) GetAgent(ctx context.Context, id pgtype.UUID) (Agent, error) {
	row := q.db.QueryRow(ctx, getAgent, id)
	var i Agent
	err := row.Scan(&i.ID, &i.Scope, &i.OwnerID, &i.Name, &i.Description, &i.Avatar, &i.SystemPrompt, &i.Model, &i.SkillIDs, &i.CanvasTools, &i.Strategy, &i.Enabled, &i.CreatedAt, &i.UpdatedAt)
	return i, err
}

type InsertAgentParams struct {
	Scope        string        `json:"scope"`
	OwnerID      pgtype.UUID   `json:"owner_id"`
	Name         string        `json:"name"`
	Description  string        `json:"description"`
	Avatar       string        `json:"avatar"`
	SystemPrompt string        `json:"system_prompt"`
	Model        string        `json:"model"`
	SkillIDs     []pgtype.UUID `json:"skill_ids"`
	CanvasTools  bool          `json:"canvas_tools"`
	Strategy     string        `json:"strategy"`
	Enabled      bool          `json:"enabled"`
}

const insertAgent = `-- name: InsertAgent :one
INSERT INTO agents (scope, owner_id, name, description, avatar, system_prompt, model, skill_ids, canvas_tools, strategy, enabled)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
RETURNING id, scope, owner_id, name, description, avatar, system_prompt, model, skill_ids, canvas_tools, strategy, enabled, created_at, updated_at
`

func (q *Queries) InsertAgent(ctx context.Context, arg InsertAgentParams) (Agent, error) {
	row := q.db.QueryRow(ctx, insertAgent,
		arg.Scope, arg.OwnerID, arg.Name, arg.Description, arg.Avatar,
		arg.SystemPrompt, arg.Model, arg.SkillIDs, arg.CanvasTools, arg.Strategy, arg.Enabled)
	var i Agent
	err := row.Scan(&i.ID, &i.Scope, &i.OwnerID, &i.Name, &i.Description, &i.Avatar, &i.SystemPrompt, &i.Model, &i.SkillIDs, &i.CanvasTools, &i.Strategy, &i.Enabled, &i.CreatedAt, &i.UpdatedAt)
	return i, err
}

type UpdateAgentParams struct {
	ID           pgtype.UUID   `json:"id"`
	Name         string        `json:"name"`
	Description  string        `json:"description"`
	Avatar       string        `json:"avatar"`
	SystemPrompt string        `json:"system_prompt"`
	Model        string        `json:"model"`
	SkillIDs     []pgtype.UUID `json:"skill_ids"`
	CanvasTools  bool          `json:"canvas_tools"`
	Strategy     string        `json:"strategy"`
	Enabled      bool          `json:"enabled"`
}

const updateAgent = `-- name: UpdateAgent :one
UPDATE agents
SET name = $2, description = $3, avatar = $4, system_prompt = $5, model = $6,
    skill_ids = $7, canvas_tools = $8, strategy = $9, enabled = $10,
    updated_at = now()
WHERE id = $1
RETURNING id, scope, owner_id, name, description, avatar, system_prompt, model, skill_ids, canvas_tools, strategy, enabled, created_at, updated_at
`

func (q *Queries) UpdateAgent(ctx context.Context, arg UpdateAgentParams) (Agent, error) {
	row := q.db.QueryRow(ctx, updateAgent,
		arg.ID, arg.Name, arg.Description, arg.Avatar, arg.SystemPrompt, arg.Model,
		arg.SkillIDs, arg.CanvasTools, arg.Strategy, arg.Enabled)
	var i Agent
	err := row.Scan(&i.ID, &i.Scope, &i.OwnerID, &i.Name, &i.Description, &i.Avatar, &i.SystemPrompt, &i.Model, &i.SkillIDs, &i.CanvasTools, &i.Strategy, &i.Enabled, &i.CreatedAt, &i.UpdatedAt)
	return i, err
}

const deleteAgent = `-- name: DeleteAgent :exec
DELETE FROM agents WHERE id = $1
`

func (q *Queries) DeleteAgent(ctx context.Context, id pgtype.UUID) error {
	_, err := q.db.Exec(ctx, deleteAgent, id)
	return err
}

// ────────────────────────── SkillRun model ──────────────────────────

type SkillRun struct {
	ID         pgtype.UUID        `json:"id"`
	UserID     pgtype.UUID        `json:"user_id"`
	AgentID    pgtype.UUID        `json:"agent_id"`
	SkillID    pgtype.UUID        `json:"skill_id"`
	Inputs     []byte             `json:"inputs"`
	Outputs    []byte             `json:"outputs"`
	Status     string             `json:"status"`
	ErrorMsg   string             `json:"error_msg"`
	DurationMs int32              `json:"duration_ms"`
	CreatedAt  pgtype.Timestamptz `json:"created_at"`
}

type InsertSkillRunParams struct {
	UserID     pgtype.UUID `json:"user_id"`
	AgentID    pgtype.UUID `json:"agent_id"`
	SkillID    pgtype.UUID `json:"skill_id"`
	Inputs     []byte      `json:"inputs"`
	Outputs    []byte      `json:"outputs"`
	Status     string      `json:"status"`
	ErrorMsg   string      `json:"error_msg"`
	DurationMs int32       `json:"duration_ms"`
}

const insertSkillRun = `-- name: InsertSkillRun :one
INSERT INTO skill_runs (user_id, agent_id, skill_id, inputs, outputs, status, error_msg, duration_ms)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
RETURNING id, user_id, agent_id, skill_id, inputs, outputs, status, error_msg, duration_ms, created_at
`

func (q *Queries) InsertSkillRun(ctx context.Context, arg InsertSkillRunParams) (SkillRun, error) {
	row := q.db.QueryRow(ctx, insertSkillRun,
		arg.UserID, arg.AgentID, arg.SkillID, arg.Inputs, arg.Outputs, arg.Status, arg.ErrorMsg, arg.DurationMs)
	var i SkillRun
	err := row.Scan(&i.ID, &i.UserID, &i.AgentID, &i.SkillID, &i.Inputs, &i.Outputs, &i.Status, &i.ErrorMsg, &i.DurationMs, &i.CreatedAt)
	return i, err
}

type UpdateSkillRunResultParams struct {
	ID         pgtype.UUID `json:"id"`
	Outputs    []byte      `json:"outputs"`
	Status     string      `json:"status"`
	ErrorMsg   string      `json:"error_msg"`
	DurationMs int32       `json:"duration_ms"`
}

const updateSkillRunResult = `-- name: UpdateSkillRunResult :exec
UPDATE skill_runs SET outputs = $2, status = $3, error_msg = $4, duration_ms = $5 WHERE id = $1
`

func (q *Queries) UpdateSkillRunResult(ctx context.Context, arg UpdateSkillRunResultParams) error {
	_, err := q.db.Exec(ctx, updateSkillRunResult, arg.ID, arg.Outputs, arg.Status, arg.ErrorMsg, arg.DurationMs)
	return err
}

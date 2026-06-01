// Package interfaces provides HTTP API handlers for the workspace context.
package interfaces

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"ccy-canvas/backend/internal/platform/authn"
	"ccy-canvas/backend/internal/platform/httpapi"
	"ccy-canvas/backend/internal/shared/apperror"
	"ccy-canvas/backend/internal/shared/httpx"
	"ccy-canvas/backend/internal/workspace/domain"
	"ccy-canvas/backend/internal/workspace/infrastructure"
)

// Handler provides workspace HTTP operations.
type Handler struct {
	repo *infrastructure.Repository
}

// NewHandler creates a new workspace Handler.
func NewHandler(repo *infrastructure.Repository) *Handler {
	return &Handler{repo: repo}
}

// --- response types ---

type ProjectItem struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type CanvasData struct {
	ProjectID string          `json:"project_id"`
	Nodes     json.RawMessage `json:"nodes"`
	Edges     json.RawMessage `json:"edges"`
	Version   int32           `json:"version"`
}

func toProjectItem(p domain.Project) ProjectItem {
	return ProjectItem{ID: p.ID, Name: p.Name, CreatedAt: p.CreatedAt, UpdatedAt: p.UpdatedAt}
}

func toCanvasData(s domain.CanvasSnapshot) CanvasData {
	return CanvasData{ProjectID: s.ProjectID, Nodes: s.Nodes, Edges: s.Edges, Version: s.Version}
}

var userSecurity = []map[string][]string{{httpapi.SecuritySchemeName: {}}}

// RegisterRoutes registers workspace operations on the huma API.
func (h *Handler) RegisterRoutes(api huma.API) {
	huma.Register(api, huma.Operation{
		OperationID: "list-projects",
		Method:      http.MethodGet,
		Path:        "/api/app/projects",
		Summary:     "List projects for the current user",
		Tags:        []string{"App", "Projects"},
		Security:    userSecurity,
	}, h.listProjects)

	huma.Register(api, huma.Operation{
		OperationID:   "create-project",
		Method:        http.MethodPost,
		Path:          "/api/app/projects",
		Summary:       "Create a new project",
		Tags:          []string{"App", "Projects"},
		Security:      userSecurity,
		DefaultStatus: http.StatusCreated,
	}, h.createProject)

	huma.Register(api, huma.Operation{
		OperationID: "get-canvas",
		Method:      http.MethodGet,
		Path:        "/api/app/projects/{id}/canvas",
		Summary:     "Get canvas snapshot for a project",
		Tags:        []string{"App", "Canvas"},
		Security:    userSecurity,
	}, h.getCanvas)

	huma.Register(api, huma.Operation{
		OperationID:   "save-canvas",
		Method:        http.MethodPut,
		Path:          "/api/app/projects/{id}/canvas",
		Summary:       "Save canvas snapshot for a project",
		Tags:          []string{"App", "Canvas"},
		Security:      userSecurity,
		DefaultStatus: http.StatusOK,
	}, h.saveCanvas)
}

// --- handlers ---

type listProjectsOutput struct {
	Body struct {
		Data      []ProjectItem `json:"data"`
		RequestID string        `json:"request_id"`
	}
}

func (h *Handler) listProjects(ctx context.Context, _ *struct{}) (*listProjectsOutput, error) {
	claims, ok := authn.ClaimsFromContext(ctx)
	if !ok {
		return nil, huma.Error401Unauthorized("Authentication required")
	}

	// Ensure user always has at least one project.
	if _, err := h.repo.EnsureFirstProject(ctx, claims.UserID); err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to ensure project", err)
	}

	projects, err := h.repo.ListProjectsByOwner(ctx, claims.UserID)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to list projects", err)
	}

	items := make([]ProjectItem, 0, len(projects))
	for _, p := range projects {
		items = append(items, toProjectItem(p))
	}

	out := &listProjectsOutput{}
	out.Body.Data = items
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type createProjectInput struct {
	Body struct {
		Name string `json:"name" minLength:"1" maxLength:"100" doc:"Project name"`
	}
}

type createProjectOutput struct {
	Body struct {
		Data      ProjectItem `json:"data"`
		RequestID string      `json:"request_id"`
	}
}

func (h *Handler) createProject(ctx context.Context, input *createProjectInput) (*createProjectOutput, error) {
	claims, ok := authn.ClaimsFromContext(ctx)
	if !ok {
		return nil, huma.Error401Unauthorized("Authentication required")
	}

	name := input.Body.Name
	if name == "" {
		name = "Untitled"
	}

	p, err := h.repo.CreateProject(ctx, claims.UserID, name)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to create project", err)
	}

	out := &createProjectOutput{}
	out.Body.Data = toProjectItem(*p)
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type getCanvasInput struct {
	ID string `path:"id" doc:"Project UUID"`
}

type getCanvasOutput struct {
	Body struct {
		Data      CanvasData `json:"data"`
		RequestID string     `json:"request_id"`
	}
}

func (h *Handler) getCanvas(ctx context.Context, input *getCanvasInput) (*getCanvasOutput, error) {
	claims, ok := authn.ClaimsFromContext(ctx)
	if !ok {
		return nil, huma.Error401Unauthorized("Authentication required")
	}

	// Verify project ownership.
	proj, err := h.repo.GetProjectByID(ctx, input.ID)
	if err != nil || proj == nil {
		return nil, huma.Error404NotFound("Project not found")
	}
	if proj.OwnerID != claims.UserID {
		return nil, huma.Error403Forbidden("Access denied")
	}

	snap, err := h.repo.GetCanvasSnapshot(ctx, input.ID)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to load canvas", err)
	}

	out := &getCanvasOutput{}
	if snap == nil {
		// Return empty canvas for new projects.
		out.Body.Data = CanvasData{ProjectID: input.ID, Nodes: json.RawMessage("[]"), Edges: json.RawMessage("[]"), Version: 0}
	} else {
		out.Body.Data = toCanvasData(*snap)
	}
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type saveCanvasInput struct {
	ID   string `path:"id" doc:"Project UUID"`
	Body struct {
		Nodes json.RawMessage `json:"nodes" doc:"ReactFlow nodes array"`
		Edges json.RawMessage `json:"edges" doc:"ReactFlow edges array"`
	}
}

type saveCanvasOutput struct {
	Body struct {
		Data      CanvasData `json:"data"`
		RequestID string     `json:"request_id"`
	}
}

func (h *Handler) saveCanvas(ctx context.Context, input *saveCanvasInput) (*saveCanvasOutput, error) {
	claims, ok := authn.ClaimsFromContext(ctx)
	if !ok {
		return nil, huma.Error401Unauthorized("Authentication required")
	}

	// Verify project ownership.
	proj, err := h.repo.GetProjectByID(ctx, input.ID)
	if err != nil || proj == nil {
		return nil, huma.Error404NotFound("Project not found")
	}
	if proj.OwnerID != claims.UserID {
		return nil, huma.Error403Forbidden("Access denied")
	}

	snap, err := h.repo.UpsertCanvasSnapshot(ctx, input.ID, claims.UserID, input.Body.Nodes, input.Body.Edges)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to save canvas", err)
	}

	out := &saveCanvasOutput{}
	out.Body.Data = toCanvasData(*snap)
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

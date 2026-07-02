// Package interfaces provides HTTP API handlers for the workspace context.
package interfaces

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
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
	CoverURL  string    `json:"cover_url"`
	FolderID  string    `json:"folder_id"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type FolderItem struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
}

type CanvasData struct {
	ProjectID string          `json:"project_id"`
	Nodes     json.RawMessage `json:"nodes"`
	Edges     json.RawMessage `json:"edges"`
	Groups    json.RawMessage `json:"groups"`
	Version   int32           `json:"version"`
}

func toProjectItem(p domain.Project) ProjectItem {
	return ProjectItem{ID: p.ID, Name: p.Name, CoverURL: p.CoverURL, FolderID: p.FolderID, CreatedAt: p.CreatedAt, UpdatedAt: p.UpdatedAt}
}

func toFolderItem(f domain.Folder) FolderItem {
	return FolderItem{ID: f.ID, Name: f.Name, CreatedAt: f.CreatedAt}
}

func toCanvasData(s domain.CanvasSnapshot) CanvasData {
	groups := s.Groups
	if len(groups) == 0 {
		groups = json.RawMessage("[]")
	}
	return CanvasData{ProjectID: s.ProjectID, Nodes: s.Nodes, Edges: s.Edges, Groups: groups, Version: s.Version}
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

	huma.Register(api, huma.Operation{
		OperationID: "update-project",
		Method:      http.MethodPatch,
		Path:        "/api/app/projects/{id}",
		Summary:     "Update project metadata (name / cover / folder)",
		Tags:        []string{"App", "Projects"},
		Security:    userSecurity,
	}, h.updateProject)

	huma.Register(api, huma.Operation{
		OperationID:   "delete-project",
		Method:        http.MethodDelete,
		Path:          "/api/app/projects/{id}",
		Summary:       "Delete a project (canvas cascades)",
		Tags:          []string{"App", "Projects"},
		Security:      userSecurity,
		DefaultStatus: http.StatusOK,
	}, h.deleteProject)

	huma.Register(api, huma.Operation{
		OperationID:   "duplicate-project",
		Method:        http.MethodPost,
		Path:          "/api/app/projects/{id}/duplicate",
		Summary:       "Duplicate a project together with its canvas",
		Tags:          []string{"App", "Projects"},
		Security:      userSecurity,
		DefaultStatus: http.StatusCreated,
	}, h.duplicateProject)

	huma.Register(api, huma.Operation{
		OperationID: "list-folders",
		Method:      http.MethodGet,
		Path:        "/api/app/folders",
		Summary:     "List project folders",
		Tags:        []string{"App", "Projects"},
		Security:    userSecurity,
	}, h.listFolders)

	huma.Register(api, huma.Operation{
		OperationID:   "create-folder",
		Method:        http.MethodPost,
		Path:          "/api/app/folders",
		Summary:       "Create a project folder",
		Tags:          []string{"App", "Projects"},
		Security:      userSecurity,
		DefaultStatus: http.StatusCreated,
	}, h.createFolder)

	huma.Register(api, huma.Operation{
		OperationID:   "delete-folder",
		Method:        http.MethodDelete,
		Path:          "/api/app/folders/{id}",
		Summary:       "Delete a project folder (projects fall back to root)",
		Tags:          []string{"App", "Projects"},
		Security:      userSecurity,
		DefaultStatus: http.StatusOK,
	}, h.deleteFolder)
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
		out.Body.Data = CanvasData{ProjectID: input.ID, Nodes: json.RawMessage("[]"), Edges: json.RawMessage("[]"), Groups: json.RawMessage("[]"), Version: 0}
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
		// Optional for backward compatibility: older clients don't send it.
		Groups json.RawMessage `json:"groups,omitempty" doc:"Canvas group rectangles"`
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

	snap, err := h.repo.UpsertCanvasSnapshot(ctx, input.ID, claims.UserID, input.Body.Nodes, input.Body.Edges, input.Body.Groups)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to save canvas", err)
	}

	out := &saveCanvasOutput{}
	out.Body.Data = toCanvasData(*snap)
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

// --- Project management (homepage) ---

type updateProjectInput struct {
	ID   string `path:"id" doc:"Project UUID"`
	Body struct {
		// Pointer fields: nil = leave untouched; empty string = clear
		// (cover removed / project moved back to root).
		Name     *string `json:"name,omitempty" maxLength:"100" doc:"New project name"`
		CoverURL *string `json:"cover_url,omitempty" doc:"Cover image url ('' clears)"`
		FolderID *string `json:"folder_id,omitempty" doc:"Folder UUID ('' moves to root)"`
	}
}

type updateProjectOutput struct {
	Body struct {
		Data      ProjectItem `json:"data"`
		RequestID string      `json:"request_id"`
	}
}

func (h *Handler) updateProject(ctx context.Context, input *updateProjectInput) (*updateProjectOutput, error) {
	claims, ok := authn.ClaimsFromContext(ctx)
	if !ok {
		return nil, huma.Error401Unauthorized("Authentication required")
	}

	proj, err := h.repo.GetProjectByID(ctx, input.ID)
	if err != nil || proj == nil {
		return nil, huma.Error404NotFound("Project not found")
	}
	if proj.OwnerID != claims.UserID {
		return nil, huma.Error403Forbidden("Access denied")
	}

	current := proj
	if input.Body.Name != nil {
		name := strings.TrimSpace(*input.Body.Name)
		if name == "" {
			name = "Untitled"
		}
		current, err = h.repo.UpdateProjectName(ctx, input.ID, claims.UserID, name)
		if err != nil {
			return nil, apperror.Wrap(apperror.CodeInternal, "Failed to rename project", err)
		}
	}
	if input.Body.CoverURL != nil {
		current, err = h.repo.UpdateProjectCover(ctx, input.ID, claims.UserID, strings.TrimSpace(*input.Body.CoverURL))
		if err != nil {
			return nil, apperror.Wrap(apperror.CodeInternal, "Failed to update cover", err)
		}
	}
	if input.Body.FolderID != nil {
		folderID := strings.TrimSpace(*input.Body.FolderID)
		if folderID != "" {
			// Folder must exist and belong to the user.
			folders, ferr := h.repo.ListFolders(ctx, claims.UserID)
			if ferr != nil {
				return nil, apperror.Wrap(apperror.CodeInternal, "Failed to verify folder", ferr)
			}
			found := false
			for _, f := range folders {
				if f.ID == folderID {
					found = true
					break
				}
			}
			if !found {
				return nil, huma.Error404NotFound("Folder not found")
			}
		}
		current, err = h.repo.UpdateProjectFolder(ctx, input.ID, claims.UserID, folderID)
		if err != nil {
			return nil, apperror.Wrap(apperror.CodeInternal, "Failed to move project", err)
		}
	}

	out := &updateProjectOutput{}
	out.Body.Data = toProjectItem(*current)
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type deleteProjectInput struct {
	ID string `path:"id" doc:"Project UUID"`
}

type deleteProjectOutput struct {
	Body struct {
		Data      map[string]bool `json:"data"`
		RequestID string          `json:"request_id"`
	}
}

func (h *Handler) deleteProject(ctx context.Context, input *deleteProjectInput) (*deleteProjectOutput, error) {
	claims, ok := authn.ClaimsFromContext(ctx)
	if !ok {
		return nil, huma.Error401Unauthorized("Authentication required")
	}

	deleted, err := h.repo.DeleteProject(ctx, input.ID, claims.UserID)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to delete project", err)
	}
	if !deleted {
		return nil, huma.Error404NotFound("Project not found")
	}

	out := &deleteProjectOutput{}
	out.Body.Data = map[string]bool{"deleted": true}
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type duplicateProjectInput struct {
	ID string `path:"id" doc:"Project UUID"`
}

type duplicateProjectOutput struct {
	Body struct {
		Data      ProjectItem `json:"data"`
		RequestID string      `json:"request_id"`
	}
}

func (h *Handler) duplicateProject(ctx context.Context, input *duplicateProjectInput) (*duplicateProjectOutput, error) {
	claims, ok := authn.ClaimsFromContext(ctx)
	if !ok {
		return nil, huma.Error401Unauthorized("Authentication required")
	}

	source, err := h.repo.GetProjectByID(ctx, input.ID)
	if err != nil || source == nil {
		return nil, huma.Error404NotFound("Project not found")
	}
	if source.OwnerID != claims.UserID {
		return nil, huma.Error403Forbidden("Access denied")
	}

	copyName := source.Name + " 副本"
	created, err := h.repo.CreateProject(ctx, claims.UserID, copyName)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to duplicate project", err)
	}
	// Carry over cover + folder so the copy lands beside the original.
	if source.CoverURL != "" {
		if updated, cerr := h.repo.UpdateProjectCover(ctx, created.ID, claims.UserID, source.CoverURL); cerr == nil {
			created = updated
		}
	}
	if source.FolderID != "" {
		if updated, ferr := h.repo.UpdateProjectFolder(ctx, created.ID, claims.UserID, source.FolderID); ferr == nil {
			created = updated
		}
	}
	// Copy the canvas snapshot (best-effort: an empty source canvas is fine).
	if snap, serr := h.repo.GetCanvasSnapshot(ctx, input.ID); serr == nil && snap != nil {
		if _, uerr := h.repo.UpsertCanvasSnapshot(ctx, created.ID, claims.UserID, snap.Nodes, snap.Edges, snap.Groups); uerr != nil {
			return nil, apperror.Wrap(apperror.CodeInternal, "Failed to copy canvas", uerr)
		}
	}

	out := &duplicateProjectOutput{}
	out.Body.Data = toProjectItem(*created)
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type listFoldersOutput struct {
	Body struct {
		Data      []FolderItem `json:"data"`
		RequestID string       `json:"request_id"`
	}
}

func (h *Handler) listFolders(ctx context.Context, _ *struct{}) (*listFoldersOutput, error) {
	claims, ok := authn.ClaimsFromContext(ctx)
	if !ok {
		return nil, huma.Error401Unauthorized("Authentication required")
	}

	folders, err := h.repo.ListFolders(ctx, claims.UserID)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to list folders", err)
	}

	items := make([]FolderItem, 0, len(folders))
	for _, f := range folders {
		items = append(items, toFolderItem(f))
	}

	out := &listFoldersOutput{}
	out.Body.Data = items
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type createFolderInput struct {
	Body struct {
		Name string `json:"name" minLength:"1" maxLength:"100" doc:"Folder name"`
	}
}

type createFolderOutput struct {
	Body struct {
		Data      FolderItem `json:"data"`
		RequestID string     `json:"request_id"`
	}
}

func (h *Handler) createFolder(ctx context.Context, input *createFolderInput) (*createFolderOutput, error) {
	claims, ok := authn.ClaimsFromContext(ctx)
	if !ok {
		return nil, huma.Error401Unauthorized("Authentication required")
	}

	name := strings.TrimSpace(input.Body.Name)
	if name == "" {
		name = "未命名文件夹"
	}
	folder, err := h.repo.CreateFolder(ctx, claims.UserID, name)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to create folder", err)
	}

	out := &createFolderOutput{}
	out.Body.Data = toFolderItem(*folder)
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type deleteFolderInput struct {
	ID string `path:"id" doc:"Folder UUID"`
}

type deleteFolderOutput struct {
	Body struct {
		Data      map[string]bool `json:"data"`
		RequestID string          `json:"request_id"`
	}
}

func (h *Handler) deleteFolder(ctx context.Context, input *deleteFolderInput) (*deleteFolderOutput, error) {
	claims, ok := authn.ClaimsFromContext(ctx)
	if !ok {
		return nil, huma.Error401Unauthorized("Authentication required")
	}

	deleted, err := h.repo.DeleteFolder(ctx, input.ID, claims.UserID)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to delete folder", err)
	}
	if !deleted {
		return nil, huma.Error404NotFound("Folder not found")
	}

	out := &deleteFolderOutput{}
	out.Body.Data = map[string]bool{"deleted": true}
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

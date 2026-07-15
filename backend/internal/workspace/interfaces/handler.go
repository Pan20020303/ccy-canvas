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
	ID              string    `json:"id"`
	Name            string    `json:"name"`
	CoverURL        string    `json:"cover_url"`
	FolderID        string    `json:"folder_id"`
	IsCollaborative bool      `json:"is_collaborative"`
	MyRole          string    `json:"my_role"` // creator | admin | collaborator | visitor
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}

type MemberItem struct {
	UID  string `json:"uid"`
	Name string `json:"name"`
	Role string `json:"role"`
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

// toProjectItem is used for owner-scoped responses (create/update/duplicate) —
// the caller is always the owner there, so my_role = creator.
func toProjectItem(p domain.Project) ProjectItem {
	return ProjectItem{ID: p.ID, Name: p.Name, CoverURL: p.CoverURL, FolderID: p.FolderID, MyRole: "creator", CreatedAt: p.CreatedAt, UpdatedAt: p.UpdatedAt}
}

func toProjectItemAccess(p domain.ProjectAccess) ProjectItem {
	return ProjectItem{
		ID: p.ID, Name: p.Name, CoverURL: p.CoverURL, FolderID: p.FolderID,
		IsCollaborative: p.IsCollaborative, MyRole: p.MyRole,
		CreatedAt: p.CreatedAt, UpdatedAt: p.UpdatedAt,
	}
}

func canManageMembers(role string) bool { return role == "creator" || role == "admin" }
func canEditCanvas(role string) bool     { return role == "creator" || role == "admin" || role == "collaborator" }

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
var adminSecurity = []map[string][]string{{httpapi.SecuritySchemeName: {authn.ScopeAdmin}}}

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
		OperationID: "list-templates",
		Method:      http.MethodGet,
		Path:        "/api/app/templates",
		Summary:     "List public canvas templates for the homepage",
		Tags:        []string{"App", "Projects"},
		Security:    userSecurity,
	}, h.listTemplates)

	huma.Register(api, huma.Operation{
		OperationID: "set-project-template",
		Method:      http.MethodPatch,
		Path:        "/api/admin/projects/{id}/template",
		Summary:     "Mark/unmark a project as a public template",
		Tags:        []string{"Admin", "Projects"},
		Security:    adminSecurity,
	}, h.setProjectTemplate)

	huma.Register(api, huma.Operation{
		OperationID: "list-comments",
		Method:      http.MethodGet,
		Path:        "/api/app/projects/{id}/comments",
		Summary:     "List canvas comments for a project",
		Tags:        []string{"App", "Comments"},
		Security:    userSecurity,
	}, h.listComments)

	huma.Register(api, huma.Operation{
		OperationID:   "create-comment",
		Method:        http.MethodPost,
		Path:          "/api/app/projects/{id}/comments",
		Summary:       "Add a canvas comment (or reply)",
		Tags:          []string{"App", "Comments"},
		Security:      userSecurity,
		DefaultStatus: http.StatusCreated,
	}, h.createComment)

	huma.Register(api, huma.Operation{
		OperationID: "resolve-comment",
		Method:      http.MethodPatch,
		Path:        "/api/app/comments/{id}/resolve",
		Summary:     "Toggle a comment's resolved state",
		Tags:        []string{"App", "Comments"},
		Security:    userSecurity,
	}, h.resolveComment)

	huma.Register(api, huma.Operation{
		OperationID:   "delete-comment",
		Method:        http.MethodDelete,
		Path:          "/api/app/comments/{id}",
		Summary:       "Delete a comment (author or project owner)",
		Tags:          []string{"App", "Comments"},
		Security:      userSecurity,
		DefaultStatus: http.StatusNoContent,
	}, h.deleteComment)

	huma.Register(api, huma.Operation{
		OperationID: "list-versions",
		Method:      http.MethodGet,
		Path:        "/api/app/projects/{id}/versions",
		Summary:     "List saved canvas versions (restore points)",
		Tags:        []string{"App", "Versions"},
		Security:    userSecurity,
	}, h.listVersions)

	huma.Register(api, huma.Operation{
		OperationID:   "save-version",
		Method:        http.MethodPost,
		Path:          "/api/app/projects/{id}/versions",
		Summary:       "Save the current canvas as a version",
		Tags:          []string{"App", "Versions"},
		Security:      userSecurity,
		DefaultStatus: http.StatusCreated,
	}, h.saveVersion)

	huma.Register(api, huma.Operation{
		OperationID: "restore-version",
		Method:      http.MethodPost,
		Path:        "/api/app/versions/{id}/restore",
		Summary:     "Restore a canvas version (auto-backs up current first)",
		Tags:        []string{"App", "Versions"},
		Security:    userSecurity,
	}, h.restoreVersion)

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

	// --- collaboration ---

	huma.Register(api, huma.Operation{
		OperationID: "set-collaboration",
		Method:      http.MethodPut,
		Path:        "/api/app/projects/{id}/collaboration",
		Summary:     "Toggle a project between private and collaborative (owner only)",
		Tags:        []string{"App", "Collaboration"},
		Security:    userSecurity,
	}, h.setCollaboration)

	huma.Register(api, huma.Operation{
		OperationID: "list-members",
		Method:      http.MethodGet,
		Path:        "/api/app/projects/{id}/members",
		Summary:     "List collaboration members of a project",
		Tags:        []string{"App", "Collaboration"},
		Security:    userSecurity,
	}, h.listMembers)

	huma.Register(api, huma.Operation{
		OperationID:   "add-member",
		Method:        http.MethodPost,
		Path:          "/api/app/projects/{id}/members",
		Summary:       "Invite a member to a collaborative project (owner/admin)",
		Tags:          []string{"App", "Collaboration"},
		Security:      userSecurity,
		DefaultStatus: http.StatusCreated,
	}, h.addMember)

	huma.Register(api, huma.Operation{
		OperationID: "update-member",
		Method:      http.MethodPatch,
		Path:        "/api/app/projects/{id}/members/{uid}",
		Summary:     "Change a member's role (owner/admin)",
		Tags:        []string{"App", "Collaboration"},
		Security:    userSecurity,
	}, h.updateMember)

	huma.Register(api, huma.Operation{
		OperationID:   "remove-member",
		Method:        http.MethodDelete,
		Path:          "/api/app/projects/{id}/members/{uid}",
		Summary:       "Remove a member from a project (owner/admin, or leave self)",
		Tags:          []string{"App", "Collaboration"},
		Security:      userSecurity,
		DefaultStatus: http.StatusOK,
	}, h.removeMember)
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

	// Ensure user always has at least one project of their own.
	if _, err := h.repo.EnsureFirstProject(ctx, claims.UserID); err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to ensure project", err)
	}

	// Owned projects PLUS projects the user was invited to (collaborative).
	projects, err := h.repo.ListProjectsForUser(ctx, claims.UserID)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to list projects", err)
	}

	items := make([]ProjectItem, 0, len(projects))
	for _, p := range projects {
		items = append(items, toProjectItemAccess(p))
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

	// Owner OR any invited member (访问者及以上都可读)。
	role, err := h.repo.AccessRole(ctx, input.ID, claims.UserID)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to check access", err)
	}
	if role == "" {
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

	// 编辑权限:创建者 / 管理者 / 协作者可写;访问者只读。
	role, err := h.repo.AccessRole(ctx, input.ID, claims.UserID)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to check access", err)
	}
	if role == "" {
		return nil, huma.Error403Forbidden("Access denied")
	}
	if !canEditCanvas(role) {
		return nil, huma.Error403Forbidden("访问者为只读，无法保存画布")
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
	// You can duplicate your own project OR any public template (that's how
	// "start from a template" works — the source is owned by an admin/curator).
	if source.OwnerID != claims.UserID {
		if isTpl, terr := h.repo.IsProjectTemplate(ctx, input.ID); terr != nil || !isTpl {
			return nil, huma.Error403Forbidden("Access denied")
		}
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

type TemplateItem struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	CoverURL  string    `json:"cover_url"`
	CreatedAt time.Time `json:"created_at"`
}

type listTemplatesOutput struct {
	Body struct {
		Data      []TemplateItem `json:"data"`
		RequestID string         `json:"request_id"`
	}
}

func (h *Handler) listTemplates(ctx context.Context, _ *struct{}) (*listTemplatesOutput, error) {
	if _, ok := authn.ClaimsFromContext(ctx); !ok {
		return nil, huma.Error401Unauthorized("Authentication required")
	}
	tpls, err := h.repo.ListTemplates(ctx)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to list templates", err)
	}
	out := &listTemplatesOutput{}
	out.Body.Data = make([]TemplateItem, 0, len(tpls))
	for _, t := range tpls {
		out.Body.Data = append(out.Body.Data, TemplateItem{
			ID: t.ID, Name: t.Name, CoverURL: t.CoverURL, CreatedAt: t.CreatedAt,
		})
	}
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type setProjectTemplateInput struct {
	ID   string `path:"id" doc:"Project UUID"`
	Body struct {
		IsTemplate bool `json:"is_template"`
	}
}

// Named type (not an anonymous struct) so huma derives a unique schema name —
// an inline `Data struct{...}` gets auto-named "DataStruct" and collides with
// other handlers' anonymous Data structs, panicking at route registration.
type SetTemplateResult struct {
	ID         string `json:"id"`
	IsTemplate bool   `json:"is_template"`
}

type setProjectTemplateOutput struct {
	Body struct {
		Data      SetTemplateResult `json:"data"`
		RequestID string            `json:"request_id"`
	}
}

func (h *Handler) setProjectTemplate(ctx context.Context, input *setProjectTemplateInput) (*setProjectTemplateOutput, error) {
	// Admin scope is enforced by the route Security; still confirm the project exists.
	if source, err := h.repo.GetProjectByID(ctx, input.ID); err != nil || source == nil {
		return nil, huma.Error404NotFound("Project not found")
	}
	if err := h.repo.SetProjectTemplate(ctx, input.ID, input.Body.IsTemplate); err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to update template flag", err)
	}
	out := &setProjectTemplateOutput{}
	out.Body.Data.ID = input.ID
	out.Body.Data.IsTemplate = input.Body.IsTemplate
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

// ─── Comments(画布评论批注)────────────────────────────────────────────

type CommentItem struct {
	ID         string    `json:"id"`
	NodeID     string    `json:"node_id"`
	AuthorID   string    `json:"author_id"`
	AuthorName string    `json:"author_name"`
	ParentID   string    `json:"parent_id"`
	Body       string    `json:"body"`
	Resolved   bool      `json:"resolved"`
	CreatedAt  time.Time `json:"created_at"`
}

func toCommentItem(c domain.Comment) CommentItem {
	return CommentItem{
		ID: c.ID, NodeID: c.NodeID, AuthorID: c.AuthorID, AuthorName: c.AuthorName,
		ParentID: c.ParentID, Body: c.Body, Resolved: c.Resolved, CreatedAt: c.CreatedAt,
	}
}

// requireProjectAccess resolves the caller and confirms they can access the
// project; returns the user id or a huma error.
func (h *Handler) requireProjectAccess(ctx context.Context, projectID string) (string, error) {
	claims, ok := authn.ClaimsFromContext(ctx)
	if !ok {
		return "", huma.Error401Unauthorized("Authentication required")
	}
	allowed, err := h.repo.HasProjectAccess(ctx, projectID, claims.UserID)
	if err != nil {
		return "", apperror.Wrap(apperror.CodeInternal, "Failed to check access", err)
	}
	if !allowed {
		return "", huma.Error403Forbidden("No access to this project")
	}
	return claims.UserID, nil
}

type listCommentsInput struct {
	ID string `path:"id" doc:"Project UUID"`
}

type listCommentsOutput struct {
	Body struct {
		Data      []CommentItem `json:"data"`
		RequestID string        `json:"request_id"`
	}
}

func (h *Handler) listComments(ctx context.Context, input *listCommentsInput) (*listCommentsOutput, error) {
	if _, err := h.requireProjectAccess(ctx, input.ID); err != nil {
		return nil, err
	}
	comments, err := h.repo.ListComments(ctx, input.ID)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to list comments", err)
	}
	out := &listCommentsOutput{}
	out.Body.Data = make([]CommentItem, 0, len(comments))
	for _, c := range comments {
		out.Body.Data = append(out.Body.Data, toCommentItem(c))
	}
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type createCommentInput struct {
	ID   string `path:"id" doc:"Project UUID"`
	Body struct {
		NodeID   string `json:"node_id"`
		Body     string `json:"body" minLength:"1" maxLength:"4000"`
		ParentID string `json:"parent_id"`
	}
}

type createCommentOutput struct {
	Body struct {
		Data      CommentItem `json:"data"`
		RequestID string      `json:"request_id"`
	}
}

func (h *Handler) createComment(ctx context.Context, input *createCommentInput) (*createCommentOutput, error) {
	userID, err := h.requireProjectAccess(ctx, input.ID)
	if err != nil {
		return nil, err
	}
	body := strings.TrimSpace(input.Body.Body)
	if body == "" {
		return nil, huma.Error422UnprocessableEntity("Comment body is required")
	}
	c, err := h.repo.CreateComment(ctx, input.ID, input.Body.NodeID, userID, input.Body.ParentID, body)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to create comment", err)
	}
	out := &createCommentOutput{}
	out.Body.Data = toCommentItem(*c)
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type resolveCommentInput struct {
	ID   string `path:"id" doc:"Comment UUID"`
	Body struct {
		Resolved bool `json:"resolved"`
	}
}

func (h *Handler) resolveComment(ctx context.Context, input *resolveCommentInput) (*struct{}, error) {
	projectID, _, ok := h.repo.GetCommentMeta(ctx, input.ID)
	if !ok {
		return nil, huma.Error404NotFound("Comment not found")
	}
	if _, err := h.requireProjectAccess(ctx, projectID); err != nil {
		return nil, err
	}
	if err := h.repo.SetCommentResolved(ctx, input.ID, input.Body.Resolved); err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to update comment", err)
	}
	return nil, nil
}

type deleteCommentInput struct {
	ID string `path:"id" doc:"Comment UUID"`
}

func (h *Handler) deleteComment(ctx context.Context, input *deleteCommentInput) (*struct{}, error) {
	claims, ok := authn.ClaimsFromContext(ctx)
	if !ok {
		return nil, huma.Error401Unauthorized("Authentication required")
	}
	projectID, authorID, found := h.repo.GetCommentMeta(ctx, input.ID)
	if !found {
		return nil, huma.Error404NotFound("Comment not found")
	}
	// Author can delete their own; the project owner can moderate any.
	owner := false
	if source, err := h.repo.GetProjectByID(ctx, projectID); err == nil && source != nil {
		owner = source.OwnerID == claims.UserID
	}
	if authorID != claims.UserID && !owner {
		return nil, huma.Error403Forbidden("Only the author or project owner can delete this comment")
	}
	if err := h.repo.DeleteComment(ctx, input.ID); err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to delete comment", err)
	}
	return nil, nil
}

// ─── Versions(画布版本历史)──────────────────────────────────────────────

type VersionItem struct {
	ID         string    `json:"id"`
	Label      string    `json:"label"`
	AuthorName string    `json:"author_name"`
	CreatedAt  time.Time `json:"created_at"`
}

type listVersionsInput struct {
	ID string `path:"id" doc:"Project UUID"`
}

type listVersionsOutput struct {
	Body struct {
		Data      []VersionItem `json:"data"`
		RequestID string        `json:"request_id"`
	}
}

func (h *Handler) listVersions(ctx context.Context, input *listVersionsInput) (*listVersionsOutput, error) {
	if _, err := h.requireProjectAccess(ctx, input.ID); err != nil {
		return nil, err
	}
	versions, err := h.repo.ListVersions(ctx, input.ID)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to list versions", err)
	}
	out := &listVersionsOutput{}
	out.Body.Data = make([]VersionItem, 0, len(versions))
	for _, v := range versions {
		out.Body.Data = append(out.Body.Data, VersionItem{ID: v.ID, Label: v.Label, AuthorName: v.AuthorName, CreatedAt: v.CreatedAt})
	}
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type saveVersionInput struct {
	ID   string `path:"id" doc:"Project UUID"`
	Body struct {
		Label string `json:"label" maxLength:"120"`
	}
}

type SaveVersionResult struct {
	ID string `json:"id"`
}

type saveVersionOutput struct {
	Body struct {
		Data      SaveVersionResult `json:"data"`
		RequestID string            `json:"request_id"`
	}
}

func (h *Handler) saveVersion(ctx context.Context, input *saveVersionInput) (*saveVersionOutput, error) {
	userID, err := h.requireProjectAccess(ctx, input.ID)
	if err != nil {
		return nil, err
	}
	id, err := h.repo.SaveVersion(ctx, input.ID, strings.TrimSpace(input.Body.Label), userID)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to save version", err)
	}
	out := &saveVersionOutput{}
	out.Body.Data.ID = id
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type restoreVersionInput struct {
	ID string `path:"id" doc:"Version UUID"`
}

func (h *Handler) restoreVersion(ctx context.Context, input *restoreVersionInput) (*struct{}, error) {
	projectID, nodes, edges, groups, ok := h.repo.GetVersionCanvas(ctx, input.ID)
	if !ok {
		return nil, huma.Error404NotFound("Version not found")
	}
	userID, err := h.requireProjectAccess(ctx, projectID)
	if err != nil {
		return nil, err
	}
	// Auto-backup the current canvas first, so a restore is itself undoable.
	_, _ = h.repo.SaveVersion(ctx, projectID, "恢复前自动备份", userID)
	if _, err := h.repo.UpsertCanvasSnapshot(ctx, projectID, userID, nodes, edges, groups); err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to restore version", err)
	}
	return nil, nil
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

// --- collaboration handlers ---

func normalizeMemberRole(role string) string {
	switch role {
	case "admin", "collaborator", "visitor":
		return role
	default:
		return "visitor"
	}
}

type setCollaborationInput struct {
	ID   string `path:"id" doc:"Project UUID"`
	Body struct {
		Collaborative bool `json:"collaborative"`
	}
}

type setCollaborationOutput struct {
	Body struct {
		Data      map[string]bool `json:"data"`
		RequestID string          `json:"request_id"`
	}
}

func (h *Handler) setCollaboration(ctx context.Context, input *setCollaborationInput) (*setCollaborationOutput, error) {
	claims, ok := authn.ClaimsFromContext(ctx)
	if !ok {
		return nil, huma.Error401Unauthorized("Authentication required")
	}

	// Owner-only: SetProjectCollaborative matches on owner_id.
	updated, err := h.repo.SetProjectCollaborative(ctx, input.ID, claims.UserID, input.Body.Collaborative)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to update collaboration", err)
	}
	if !updated {
		return nil, huma.Error403Forbidden("只有创建者可以更改协作状态")
	}

	out := &setCollaborationOutput{}
	out.Body.Data = map[string]bool{"is_collaborative": input.Body.Collaborative}
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type listMembersInput struct {
	ID string `path:"id" doc:"Project UUID"`
}

type listMembersOutput struct {
	Body struct {
		Data      []MemberItem `json:"data"`
		RequestID string       `json:"request_id"`
	}
}

func (h *Handler) listMembers(ctx context.Context, input *listMembersInput) (*listMembersOutput, error) {
	claims, ok := authn.ClaimsFromContext(ctx)
	if !ok {
		return nil, huma.Error401Unauthorized("Authentication required")
	}

	// Any participant (owner or member) may view the roster.
	role, err := h.repo.AccessRole(ctx, input.ID, claims.UserID)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to check access", err)
	}
	if role == "" {
		return nil, huma.Error403Forbidden("Access denied")
	}

	members, err := h.repo.ListMembers(ctx, input.ID)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to list members", err)
	}

	items := make([]MemberItem, 0, len(members))
	for _, m := range members {
		items = append(items, MemberItem{UID: m.UserID, Name: m.Name, Role: m.Role})
	}

	out := &listMembersOutput{}
	out.Body.Data = items
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type addMemberInput struct {
	ID   string `path:"id" doc:"Project UUID"`
	Body struct {
		UID  string `json:"uid" doc:"User UUID to invite"`
		Role string `json:"role" doc:"admin | collaborator | visitor"`
	}
}

type addMemberOutput struct {
	Body struct {
		Data      MemberItem `json:"data"`
		RequestID string     `json:"request_id"`
	}
}

func (h *Handler) addMember(ctx context.Context, input *addMemberInput) (*addMemberOutput, error) {
	claims, ok := authn.ClaimsFromContext(ctx)
	if !ok {
		return nil, huma.Error401Unauthorized("Authentication required")
	}
	if input.Body.UID == "" {
		return nil, huma.Error400BadRequest("缺少用户 ID")
	}
	if input.Body.UID == claims.UserID {
		return nil, huma.Error400BadRequest("创建者无需邀请自己")
	}

	role, err := h.repo.AccessRole(ctx, input.ID, claims.UserID)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to check access", err)
	}
	if !canManageMembers(role) {
		return nil, huma.Error403Forbidden("只有创建者或管理者可以邀请成员")
	}

	newRole := normalizeMemberRole(input.Body.Role)
	if err := h.repo.AddMember(ctx, input.ID, input.Body.UID, newRole); err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to add member", err)
	}

	// Return the authoritative row (with resolved display name).
	item := MemberItem{UID: input.Body.UID, Role: newRole}
	if members, mErr := h.repo.ListMembers(ctx, input.ID); mErr == nil {
		for _, m := range members {
			if m.UserID == input.Body.UID {
				item.Name = m.Name
				item.Role = m.Role
				break
			}
		}
	}

	out := &addMemberOutput{}
	out.Body.Data = item
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type updateMemberInput struct {
	ID   string `path:"id" doc:"Project UUID"`
	UID  string `path:"uid" doc:"Member user UUID"`
	Body struct {
		Role string `json:"role" doc:"admin | collaborator | visitor"`
	}
}

type updateMemberOutput struct {
	Body struct {
		Data      MemberItem `json:"data"`
		RequestID string     `json:"request_id"`
	}
}

func (h *Handler) updateMember(ctx context.Context, input *updateMemberInput) (*updateMemberOutput, error) {
	claims, ok := authn.ClaimsFromContext(ctx)
	if !ok {
		return nil, huma.Error401Unauthorized("Authentication required")
	}

	role, err := h.repo.AccessRole(ctx, input.ID, claims.UserID)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to check access", err)
	}
	if !canManageMembers(role) {
		return nil, huma.Error403Forbidden("只有创建者或管理者可以调整成员权限")
	}

	newRole := normalizeMemberRole(input.Body.Role)
	if err := h.repo.AddMember(ctx, input.ID, input.UID, newRole); err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to update member", err)
	}

	out := &updateMemberOutput{}
	out.Body.Data = MemberItem{UID: input.UID, Role: newRole}
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

type removeMemberInput struct {
	ID  string `path:"id" doc:"Project UUID"`
	UID string `path:"uid" doc:"Member user UUID"`
}

type removeMemberOutput struct {
	Body struct {
		Data      map[string]bool `json:"data"`
		RequestID string          `json:"request_id"`
	}
}

func (h *Handler) removeMember(ctx context.Context, input *removeMemberInput) (*removeMemberOutput, error) {
	claims, ok := authn.ClaimsFromContext(ctx)
	if !ok {
		return nil, huma.Error401Unauthorized("Authentication required")
	}

	role, err := h.repo.AccessRole(ctx, input.ID, claims.UserID)
	if err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to check access", err)
	}
	// Managers can remove anyone; a member may remove themselves (leave).
	if !canManageMembers(role) && input.UID != claims.UserID {
		return nil, huma.Error403Forbidden("无权移除该成员")
	}

	if err := h.repo.RemoveMember(ctx, input.ID, input.UID); err != nil {
		return nil, apperror.Wrap(apperror.CodeInternal, "Failed to remove member", err)
	}

	out := &removeMemberOutput{}
	out.Body.Data = map[string]bool{"removed": true}
	out.Body.RequestID = httpx.RequestIDFrom(ctx)
	return out, nil
}

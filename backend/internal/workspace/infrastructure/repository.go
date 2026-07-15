// Package infrastructure implements the workspace repository using sqlc.
package infrastructure

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"ccy-canvas/backend/internal/platform/database/sqlc"
	"ccy-canvas/backend/internal/workspace/domain"
)

// Repository provides persistence for projects and canvas snapshots.
type Repository struct {
	q *sqlc.Queries
}

// NewRepository creates a new workspace Repository.
func NewRepository(q *sqlc.Queries) *Repository {
	return &Repository{q: q}
}

// --- helpers ---

func pgUUID(u uuid.UUID) pgtype.UUID { return pgtype.UUID{Bytes: u, Valid: true} }

func parsePgUUID(s string) (pgtype.UUID, error) {
	u, err := uuid.Parse(s)
	if err != nil {
		return pgtype.UUID{}, err
	}
	return pgUUID(u), nil
}

func uuidStr(u pgtype.UUID) string {
	if !u.Valid {
		return ""
	}
	return uuid.UUID(u.Bytes).String()
}

func rawJSON(b []byte) json.RawMessage {
	if len(b) == 0 {
		return json.RawMessage("[]")
	}
	return json.RawMessage(b)
}

func toProject(p sqlc.Project) domain.Project {
	folderID := ""
	if p.FolderID.Valid {
		folderID = uuidStr(p.FolderID)
	}
	return domain.Project{
		ID:        uuidStr(p.ID),
		OwnerID:   uuidStr(p.OwnerID),
		Name:      p.Name,
		CoverURL:  p.CoverUrl,
		FolderID:  folderID,
		CreatedAt: p.CreatedAt.Time,
		UpdatedAt: p.UpdatedAt.Time,
	}
}

func toFolder(f sqlc.ProjectFolder) domain.Folder {
	return domain.Folder{
		ID:        uuidStr(f.ID),
		OwnerID:   uuidStr(f.OwnerID),
		Name:      f.Name,
		CreatedAt: f.CreatedAt.Time,
	}
}

func toSnapshot(s sqlc.CanvasSnapshot) domain.CanvasSnapshot {
	return domain.CanvasSnapshot{
		ID:        uuidStr(s.ID),
		ProjectID: uuidStr(s.ProjectID),
		UserID:    uuidStr(s.UserID),
		Nodes:     rawJSON(s.Nodes),
		Edges:     rawJSON(s.Edges),
		Groups:    rawJSON(s.Groups),
		Version:   s.Version,
		CreatedAt: s.CreatedAt.Time,
	}
}

// --- Projects ---

func (r *Repository) ListProjectsByOwner(ctx context.Context, ownerID string) ([]domain.Project, error) {
	pgID, err := parsePgUUID(ownerID)
	if err != nil {
		return nil, err
	}
	rows, err := r.q.ListProjectsByOwner(ctx, pgID)
	if err != nil {
		return nil, err
	}
	result := make([]domain.Project, 0, len(rows))
	for _, row := range rows {
		result = append(result, toProject(row))
	}
	return result, nil
}

func (r *Repository) CreateProject(ctx context.Context, ownerID, name string) (*domain.Project, error) {
	pgID, err := parsePgUUID(ownerID)
	if err != nil {
		return nil, err
	}
	p, err := r.q.CreateProject(ctx, sqlc.CreateProjectParams{OwnerID: pgID, Name: name})
	if err != nil {
		return nil, err
	}
	proj := toProject(p)
	return &proj, nil
}

func (r *Repository) GetProjectByID(ctx context.Context, projectID string) (*domain.Project, error) {
	pgID, err := parsePgUUID(projectID)
	if err != nil {
		return nil, err
	}
	p, err := r.q.GetProjectByID(ctx, pgID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	proj := toProject(p)
	return &proj, nil
}

// ListTemplates returns all projects marked as templates (any user can see them).
func (r *Repository) ListTemplates(ctx context.Context) ([]domain.TemplateProject, error) {
	rows, err := r.q.ListTemplateProjects(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]domain.TemplateProject, 0, len(rows))
	for _, row := range rows {
		out = append(out, domain.TemplateProject{
			ID:        uuidStr(row.ID),
			Name:      row.Name,
			CoverURL:  row.CoverUrl,
			CreatedAt: row.CreatedAt.Time,
		})
	}
	return out, nil
}

// SetProjectTemplate marks/unmarks a project as a template (admin action).
func (r *Repository) SetProjectTemplate(ctx context.Context, projectID string, isTemplate bool) error {
	pgID, err := parsePgUUID(projectID)
	if err != nil {
		return err
	}
	return r.q.SetProjectTemplate(ctx, sqlc.SetProjectTemplateParams{ID: pgID, IsTemplate: isTemplate})
}

// IsProjectTemplate reports whether a project is a public template.
func (r *Repository) IsProjectTemplate(ctx context.Context, projectID string) (bool, error) {
	pgID, err := parsePgUUID(projectID)
	if err != nil {
		return false, err
	}
	v, err := r.q.GetProjectIsTemplate(ctx, pgID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return v, err
}

func (r *Repository) UpdateProjectName(ctx context.Context, projectID, ownerID, name string) (*domain.Project, error) {
	pgProj, err := parsePgUUID(projectID)
	if err != nil {
		return nil, err
	}
	pgOwner, err := parsePgUUID(ownerID)
	if err != nil {
		return nil, err
	}
	p, err := r.q.UpdateProjectName(ctx, sqlc.UpdateProjectNameParams{
		ID:      pgProj,
		Name:    name,
		OwnerID: pgOwner,
	})
	if err != nil {
		return nil, err
	}
	proj := toProject(p)
	return &proj, nil
}

// UpdateProjectCover sets the homepage cover image url.
func (r *Repository) UpdateProjectCover(ctx context.Context, projectID, ownerID, coverURL string) (*domain.Project, error) {
	pgProj, err := parsePgUUID(projectID)
	if err != nil {
		return nil, err
	}
	pgOwner, err := parsePgUUID(ownerID)
	if err != nil {
		return nil, err
	}
	p, err := r.q.UpdateProjectCover(ctx, sqlc.UpdateProjectCoverParams{ID: pgProj, CoverUrl: coverURL, OwnerID: pgOwner})
	if err != nil {
		return nil, err
	}
	proj := toProject(p)
	return &proj, nil
}

// UpdateProjectFolder moves a project into a folder; empty folderID moves it
// back to the root level.
func (r *Repository) UpdateProjectFolder(ctx context.Context, projectID, ownerID, folderID string) (*domain.Project, error) {
	pgProj, err := parsePgUUID(projectID)
	if err != nil {
		return nil, err
	}
	pgOwner, err := parsePgUUID(ownerID)
	if err != nil {
		return nil, err
	}
	var pgFolder pgtype.UUID
	if folderID != "" {
		pgFolder, err = parsePgUUID(folderID)
		if err != nil {
			return nil, err
		}
	}
	p, err := r.q.UpdateProjectFolder(ctx, sqlc.UpdateProjectFolderParams{ID: pgProj, FolderID: pgFolder, OwnerID: pgOwner})
	if err != nil {
		return nil, err
	}
	proj := toProject(p)
	return &proj, nil
}

// DeleteProject removes a project (canvas cascades via FK). Returns true when
// a row was actually deleted (ownership matched).
func (r *Repository) DeleteProject(ctx context.Context, projectID, ownerID string) (bool, error) {
	pgProj, err := parsePgUUID(projectID)
	if err != nil {
		return false, err
	}
	pgOwner, err := parsePgUUID(ownerID)
	if err != nil {
		return false, err
	}
	n, err := r.q.DeleteProject(ctx, sqlc.DeleteProjectParams{ID: pgProj, OwnerID: pgOwner})
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// CreateFolder creates a homepage project folder.
func (r *Repository) CreateFolder(ctx context.Context, ownerID, name string) (*domain.Folder, error) {
	pgOwner, err := parsePgUUID(ownerID)
	if err != nil {
		return nil, err
	}
	f, err := r.q.CreateProjectFolder(ctx, sqlc.CreateProjectFolderParams{OwnerID: pgOwner, Name: name})
	if err != nil {
		return nil, err
	}
	folder := toFolder(f)
	return &folder, nil
}

// ListFolders lists the user's project folders.
func (r *Repository) ListFolders(ctx context.Context, ownerID string) ([]domain.Folder, error) {
	pgOwner, err := parsePgUUID(ownerID)
	if err != nil {
		return nil, err
	}
	rows, err := r.q.ListProjectFoldersByOwner(ctx, pgOwner)
	if err != nil {
		return nil, err
	}
	result := make([]domain.Folder, 0, len(rows))
	for _, row := range rows {
		result = append(result, toFolder(row))
	}
	return result, nil
}

// DeleteFolder removes a folder; member projects fall back to root (FK ON
// DELETE SET NULL).
func (r *Repository) DeleteFolder(ctx context.Context, folderID, ownerID string) (bool, error) {
	pgFolder, err := parsePgUUID(folderID)
	if err != nil {
		return false, err
	}
	pgOwner, err := parsePgUUID(ownerID)
	if err != nil {
		return false, err
	}
	n, err := r.q.DeleteProjectFolder(ctx, sqlc.DeleteProjectFolderParams{ID: pgFolder, OwnerID: pgOwner})
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// --- Canvas ---

func (r *Repository) GetCanvasSnapshot(ctx context.Context, projectID string) (*domain.CanvasSnapshot, error) {
	pgID, err := parsePgUUID(projectID)
	if err != nil {
		return nil, err
	}
	s, err := r.q.GetCanvasSnapshot(ctx, pgID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	snap := toSnapshot(s)
	return &snap, nil
}

func (r *Repository) UpsertCanvasSnapshot(ctx context.Context, projectID, userID string, nodes, edges, groups json.RawMessage) (*domain.CanvasSnapshot, error) {
	pgProj, err := parsePgUUID(projectID)
	if err != nil {
		return nil, err
	}
	pgUser, err := parsePgUUID(userID)
	if err != nil {
		return nil, err
	}
	nodesBytes := []byte(nodes)
	if len(nodesBytes) == 0 {
		nodesBytes = []byte("[]")
	}
	edgesBytes := []byte(edges)
	if len(edgesBytes) == 0 {
		edgesBytes = []byte("[]")
	}
	groupsBytes := []byte(groups)
	if len(groupsBytes) == 0 {
		groupsBytes = []byte("[]")
	}
	s, err := r.q.UpsertCanvasSnapshot(ctx, sqlc.UpsertCanvasSnapshotParams{
		ProjectID: pgProj,
		UserID:    pgUser,
		Nodes:     nodesBytes,
		Edges:     edgesBytes,
		Groups:    groupsBytes,
	})
	if err != nil {
		return nil, err
	}
	snap := toSnapshot(s)
	return &snap, nil
}

// --- Collaboration ---

// ListProjectsForUser returns owned projects PLUS projects the user was invited
// to (as a member), each with is_collaborative and the caller's effective role.
func (r *Repository) ListProjectsForUser(ctx context.Context, userID string) ([]domain.ProjectAccess, error) {
	pgID, err := parsePgUUID(userID)
	if err != nil {
		return nil, err
	}
	rows, err := r.q.ListProjectsForUser(ctx, pgID)
	if err != nil {
		return nil, err
	}
	result := make([]domain.ProjectAccess, 0, len(rows))
	for _, row := range rows {
		folderID := ""
		if row.FolderID.Valid {
			folderID = uuidStr(row.FolderID)
		}
		result = append(result, domain.ProjectAccess{
			Project: domain.Project{
				ID:        uuidStr(row.ID),
				OwnerID:   uuidStr(row.OwnerID),
				Name:      row.Name,
				CoverURL:  row.CoverUrl,
				FolderID:  folderID,
				CreatedAt: row.CreatedAt.Time,
				UpdatedAt: row.UpdatedAt.Time,
			},
			IsCollaborative: row.IsCollaborative,
			MyRole:          row.MyRole,
		})
	}
	return result, nil
}

// SetProjectCollaborative flips the collaborative flag (owner-only). When
// turning it off it also removes every member. Returns true if the owner
// matched (row updated).
func (r *Repository) SetProjectCollaborative(ctx context.Context, projectID, ownerID string, collaborative bool) (bool, error) {
	pgProj, err := parsePgUUID(projectID)
	if err != nil {
		return false, err
	}
	pgOwner, err := parsePgUUID(ownerID)
	if err != nil {
		return false, err
	}
	n, err := r.q.SetProjectCollaborative(ctx, pgProj, pgOwner, collaborative)
	if err != nil {
		return false, err
	}
	if n == 0 {
		return false, nil
	}
	if !collaborative {
		if err := r.q.ClearProjectMembers(ctx, pgProj); err != nil {
			return false, err
		}
	}
	return true, nil
}

// AccessRole returns the caller's effective role on a project:
// "creator" (owner), "admin"/"collaborator"/"visitor" (member), or "" (no access).
func (r *Repository) AccessRole(ctx context.Context, projectID, userID string) (string, error) {
	pgProj, err := parsePgUUID(projectID)
	if err != nil {
		return "", err
	}
	pgUser, err := parsePgUUID(userID)
	if err != nil {
		return "", err
	}
	oc, err := r.q.GetProjectOwnerCollab(ctx, pgProj)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if uuidStr(oc.OwnerID) == userID {
		return "creator", nil
	}
	role, rerr := r.q.GetProjectMemberRole(ctx, pgProj, pgUser)
	if errors.Is(rerr, pgx.ErrNoRows) {
		return "", nil
	}
	if rerr != nil {
		return "", rerr
	}
	return role, nil
}

// ListMembers returns a project's invited members (excludes the owner).
func (r *Repository) ListMembers(ctx context.Context, projectID string) ([]domain.ProjectMember, error) {
	pgProj, err := parsePgUUID(projectID)
	if err != nil {
		return nil, err
	}
	rows, err := r.q.ListProjectMembers(ctx, pgProj)
	if err != nil {
		return nil, err
	}
	result := make([]domain.ProjectMember, 0, len(rows))
	for _, row := range rows {
		result = append(result, domain.ProjectMember{
			UserID:    uuidStr(row.UserID),
			Name:      row.Name,
			Role:      row.Role,
			CreatedAt: row.CreatedAt.Time,
		})
	}
	return result, nil
}

// AddMember invites / re-roles a member.
func (r *Repository) AddMember(ctx context.Context, projectID, userID, role string) error {
	pgProj, err := parsePgUUID(projectID)
	if err != nil {
		return err
	}
	pgUser, err := parsePgUUID(userID)
	if err != nil {
		return err
	}
	return r.q.UpsertProjectMember(ctx, pgProj, pgUser, role)
}

// RemoveMember drops a member from a project.
func (r *Repository) RemoveMember(ctx context.Context, projectID, userID string) error {
	pgProj, err := parsePgUUID(projectID)
	if err != nil {
		return err
	}
	pgUser, err := parsePgUUID(userID)
	if err != nil {
		return err
	}
	return r.q.DeleteProjectMember(ctx, pgProj, pgUser)
}

// EnsureFirstProject creates a default project for the user if they have none.
func (r *Repository) EnsureFirstProject(ctx context.Context, ownerID string) (*domain.Project, error) {
	existing, err := r.ListProjectsByOwner(ctx, ownerID)
	if err != nil {
		return nil, err
	}
	if len(existing) > 0 {
		return &existing[0], nil
	}
	return r.CreateProject(ctx, ownerID, "我的画布")
}

// LastUpdatedAt returns a zero time for use with ETag / caching (optional).
func (r *Repository) LastUpdatedAt(_ context.Context) time.Time { return time.Now() }

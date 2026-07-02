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

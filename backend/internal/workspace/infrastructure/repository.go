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
	return domain.Project{
		ID:        uuidStr(p.ID),
		OwnerID:   uuidStr(p.OwnerID),
		Name:      p.Name,
		CreatedAt: p.CreatedAt.Time,
		UpdatedAt: p.UpdatedAt.Time,
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

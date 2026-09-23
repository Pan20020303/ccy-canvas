package infrastructure

import (
	"ccy-canvas/backend/internal/platform/database/sqlc"
	"ccy-canvas/backend/internal/workspace/domain"
	"context"
	"encoding/json"
	"errors"
	"github.com/jackc/pgx/v5"
)

var ErrCanvasVersionConflict = errors.New("canvas version conflict")

// Versioned browser saves cannot overwrite a snapshot loaded by another editor.
// The unversioned internal copy helper remains available for creating projects.
func (r *Repository) SaveCanvasSnapshotVersioned(ctx context.Context, projectID, userID string, nodes, edges, groups json.RawMessage, expectedVersion int32) (*domain.CanvasSnapshot, error) {
	pid, err := parsePgUUID(projectID)
	if err != nil {
		return nil, err
	}
	uid, err := parsePgUUID(userID)
	if err != nil {
		return nil, err
	}
	normalized := func(raw json.RawMessage) []byte {
		if len(raw) == 0 {
			return []byte("[]")
		}
		return []byte(raw)
	}
	s, err := r.q.SaveCanvasSnapshotVersioned(ctx, sqlc.SaveCanvasSnapshotVersionedParams{ProjectID: pid, UserID: uid, Nodes: normalized(nodes), Edges: normalized(edges), Groups: normalized(groups), ExpectedVersion: expectedVersion})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrCanvasVersionConflict
	}
	if err != nil {
		return nil, err
	}
	snap := toSnapshot(sqlc.CanvasSnapshot{
		ID: s.ID, ProjectID: s.ProjectID, UserID: s.UserID,
		Nodes: s.Nodes, Edges: s.Edges, Groups: s.Groups,
		Version: s.Version, CreatedAt: s.CreatedAt,
	})
	return &snap, nil
}

// Hand-authored bindings for the generation_history table (migration
// 020_generation_history.sql). Lives outside the sqlc-generated files, matching
// the existing _p2 convention, so these can be iterated without re-running sqlc
// generate (which has stale-file conflicts with the hand-written agents/skills
// bindings).

package sqlc

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
)

type GenerationHistory struct {
	ID               pgtype.UUID        `json:"id"`
	UserID           pgtype.UUID        `json:"user_id"`
	ClientID         string             `json:"client_id"`
	SpaceID          string             `json:"space_id"`
	SpaceType        string             `json:"space_type"`
	ProjectID        string             `json:"project_id"`
	ItemType         string             `json:"item_type"`
	MediaType        string             `json:"media_type"`
	Title            string             `json:"title"`
	Thumbnail        string             `json:"thumbnail"`
	Content          string             `json:"content"`
	AspectRatio      string             `json:"aspect_ratio"`
	PromptExcerpt    string             `json:"prompt_excerpt"`
	SourceNodeID     string             `json:"source_node_id"`
	DerivationAction string             `json:"derivation_action"`
	ClientTs         int64              `json:"client_ts"`
	CreatedAt        pgtype.Timestamptz `json:"created_at"`
}

type UpsertGenerationHistoryParams struct {
	UserID           pgtype.UUID
	ClientID         string
	SpaceID          string
	SpaceType        string
	ProjectID        string
	ItemType         string
	MediaType        string
	Title            string
	Thumbnail        string
	Content          string
	AspectRatio      string
	PromptExcerpt    string
	SourceNodeID     string
	DerivationAction string
	ClientTs         int64
}

const upsertGenerationHistory = `
INSERT INTO generation_history (
    user_id, client_id, space_id, space_type, project_id, item_type, media_type,
    title, thumbnail, content, aspect_ratio, prompt_excerpt, source_node_id,
    derivation_action, client_ts
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
ON CONFLICT (user_id, client_id) DO UPDATE SET
    space_id          = EXCLUDED.space_id,
    space_type        = EXCLUDED.space_type,
    project_id        = EXCLUDED.project_id,
    item_type         = EXCLUDED.item_type,
    media_type        = EXCLUDED.media_type,
    title             = EXCLUDED.title,
    thumbnail         = EXCLUDED.thumbnail,
    content           = EXCLUDED.content,
    aspect_ratio      = EXCLUDED.aspect_ratio,
    prompt_excerpt    = EXCLUDED.prompt_excerpt,
    source_node_id    = EXCLUDED.source_node_id,
    derivation_action = EXCLUDED.derivation_action,
    client_ts         = EXCLUDED.client_ts
`

// UpsertGenerationHistory inserts a history item, or refreshes it in place when
// the same (user_id, client_id) is re-synced (e.g. a thumbnail filled in after
// asset staging). Idempotent per the unique (user_id, client_id) index.
func (q *Queries) UpsertGenerationHistory(ctx context.Context, arg UpsertGenerationHistoryParams) error {
	_, err := q.db.Exec(ctx, upsertGenerationHistory,
		arg.UserID, arg.ClientID, arg.SpaceID, arg.SpaceType, arg.ProjectID,
		arg.ItemType, arg.MediaType, arg.Title, arg.Thumbnail, arg.Content,
		arg.AspectRatio, arg.PromptExcerpt, arg.SourceNodeID, arg.DerivationAction,
		arg.ClientTs)
	return err
}

type ListGenerationHistoryParams struct {
	UserID    pgtype.UUID
	SpaceID   string // "" = any space
	ProjectID string // "" = any project
	MediaType string // "" = any media type
	Limit     int32
}

const listGenerationHistory = `
SELECT id, user_id, client_id, space_id, space_type, project_id, item_type,
       media_type, title, thumbnail, content, aspect_ratio, prompt_excerpt,
       source_node_id, derivation_action, client_ts, created_at
FROM generation_history
WHERE user_id = $1
  AND ($2::text = '' OR space_id = $2)
  AND ($3::text = '' OR project_id = $3)
  AND ($4::text = '' OR media_type = $4)
ORDER BY client_ts DESC
LIMIT $5
`

func (q *Queries) ListGenerationHistory(ctx context.Context, arg ListGenerationHistoryParams) ([]GenerationHistory, error) {
	rows, err := q.db.Query(ctx, listGenerationHistory,
		arg.UserID, arg.SpaceID, arg.ProjectID, arg.MediaType, arg.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []GenerationHistory{}
	for rows.Next() {
		var i GenerationHistory
		if err := rows.Scan(
			&i.ID, &i.UserID, &i.ClientID, &i.SpaceID, &i.SpaceType, &i.ProjectID,
			&i.ItemType, &i.MediaType, &i.Title, &i.Thumbnail, &i.Content,
			&i.AspectRatio, &i.PromptExcerpt, &i.SourceNodeID, &i.DerivationAction,
			&i.ClientTs, &i.CreatedAt,
		); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	return items, rows.Err()
}

const deleteGenerationHistory = `
DELETE FROM generation_history
WHERE user_id = $1 AND client_id = ANY($2::text[])
`

// DeleteGenerationHistory removes the caller's history items by client id.
func (q *Queries) DeleteGenerationHistory(ctx context.Context, userID pgtype.UUID, clientIDs []string) error {
	_, err := q.db.Exec(ctx, deleteGenerationHistory, userID, clientIDs)
	return err
}

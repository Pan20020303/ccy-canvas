// Hand-authored bindings for the saved_assets table (migration
// 021_saved_assets.sql). Lives outside the sqlc-generated files, matching the
// existing _p2 / generation_history convention, so these can be iterated
// without re-running sqlc generate.

package sqlc

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
)

type SavedAsset struct {
	ID          pgtype.UUID        `json:"id"`
	UserID      pgtype.UUID        `json:"user_id"`
	ClientID    string             `json:"client_id"`
	Name        string             `json:"name"`
	Category    string             `json:"category"`
	Kind        string             `json:"kind"`
	Thumbnail   string             `json:"thumbnail"`
	URL         string             `json:"url"`
	TextContent string             `json:"text_content"`
	FolderID    string             `json:"folder_id"`
	ClientTs    int64              `json:"client_ts"`
	CreatedAt   pgtype.Timestamptz `json:"created_at"`
}

type UpsertSavedAssetParams struct {
	UserID      pgtype.UUID
	ClientID    string
	Name        string
	Category    string
	Kind        string
	Thumbnail   string
	URL         string
	TextContent string
	FolderID    string
	ClientTs    int64
}

const upsertSavedAsset = `
INSERT INTO saved_assets (
    user_id, client_id, name, category, kind, thumbnail, url, text_content, folder_id, client_ts
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
ON CONFLICT (user_id, client_id) DO UPDATE SET
    name         = EXCLUDED.name,
    category     = EXCLUDED.category,
    kind         = EXCLUDED.kind,
    thumbnail    = EXCLUDED.thumbnail,
    url          = EXCLUDED.url,
    text_content = EXCLUDED.text_content,
    folder_id    = EXCLUDED.folder_id,
    client_ts    = EXCLUDED.client_ts
`

// UpsertSavedAsset inserts a saved asset, or refreshes it in place when the same
// (user_id, client_id) is re-synced (e.g. a thumbnail re-hosted to a stable
// URL, or the asset dragged into a folder). Idempotent per the unique
// (user_id, client_id) index.
func (q *Queries) UpsertSavedAsset(ctx context.Context, arg UpsertSavedAssetParams) error {
	_, err := q.db.Exec(ctx, upsertSavedAsset,
		arg.UserID, arg.ClientID, arg.Name, arg.Category, arg.Kind,
		arg.Thumbnail, arg.URL, arg.TextContent, arg.FolderID, arg.ClientTs)
	return err
}

type ListSavedAssetsParams struct {
	UserID   pgtype.UUID
	Category string // "" = any category
	Limit    int32
}

const listSavedAssets = `
SELECT id, user_id, client_id, name, category, kind, thumbnail, url, text_content,
       folder_id, client_ts, created_at
FROM saved_assets
WHERE user_id = $1
  AND ($2::text = '' OR category = $2)
ORDER BY client_ts DESC
LIMIT $3
`

func (q *Queries) ListSavedAssets(ctx context.Context, arg ListSavedAssetsParams) ([]SavedAsset, error) {
	rows, err := q.db.Query(ctx, listSavedAssets, arg.UserID, arg.Category, arg.Limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []SavedAsset{}
	for rows.Next() {
		var i SavedAsset
		if err := rows.Scan(
			&i.ID, &i.UserID, &i.ClientID, &i.Name, &i.Category, &i.Kind,
			&i.Thumbnail, &i.URL, &i.TextContent, &i.FolderID, &i.ClientTs, &i.CreatedAt,
		); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	return items, rows.Err()
}

const deleteSavedAssets = `
DELETE FROM saved_assets
WHERE user_id = $1 AND client_id = ANY($2::text[])
`

// DeleteSavedAssets removes the caller's saved assets by client id.
func (q *Queries) DeleteSavedAssets(ctx context.Context, userID pgtype.UUID, clientIDs []string) error {
	_, err := q.db.Exec(ctx, deleteSavedAssets, userID, clientIDs)
	return err
}

// ─── 素材库文件夹(asset_folders,migration 026)────────────────────────────

type AssetFolder struct {
	ID        pgtype.UUID        `json:"id"`
	UserID    pgtype.UUID        `json:"user_id"`
	ClientID  string             `json:"client_id"`
	Name      string             `json:"name"`
	ClientTs  int64              `json:"client_ts"`
	CreatedAt pgtype.Timestamptz `json:"created_at"`
}

type UpsertAssetFolderParams struct {
	UserID   pgtype.UUID
	ClientID string
	Name     string
	ClientTs int64
}

const upsertAssetFolder = `
INSERT INTO asset_folders (user_id, client_id, name, client_ts)
VALUES ($1, $2, $3, $4)
ON CONFLICT (user_id, client_id) DO UPDATE SET
    name      = EXCLUDED.name,
    client_ts = EXCLUDED.client_ts
`

// UpsertAssetFolder creates a folder or renames it in place (idempotent per the
// unique (user_id, client_id) index).
func (q *Queries) UpsertAssetFolder(ctx context.Context, arg UpsertAssetFolderParams) error {
	_, err := q.db.Exec(ctx, upsertAssetFolder, arg.UserID, arg.ClientID, arg.Name, arg.ClientTs)
	return err
}

const listAssetFolders = `
SELECT id, user_id, client_id, name, client_ts, created_at
FROM asset_folders
WHERE user_id = $1
ORDER BY client_ts DESC
`

func (q *Queries) ListAssetFolders(ctx context.Context, userID pgtype.UUID) ([]AssetFolder, error) {
	rows, err := q.db.Query(ctx, listAssetFolders, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []AssetFolder{}
	for rows.Next() {
		var i AssetFolder
		if err := rows.Scan(&i.ID, &i.UserID, &i.ClientID, &i.Name, &i.ClientTs, &i.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	return items, rows.Err()
}

const deleteAssetFolder = `
DELETE FROM asset_folders WHERE user_id = $1 AND client_id = $2
`

const clearAssetsFolder = `
UPDATE saved_assets SET folder_id = '' WHERE user_id = $1 AND folder_id = $2
`

// DeleteAssetFolder removes a folder and re-parents its assets back to the root
// (folder_id = ''), so deleting a folder never deletes the assets inside it.
func (q *Queries) DeleteAssetFolder(ctx context.Context, userID pgtype.UUID, clientID string) error {
	if _, err := q.db.Exec(ctx, clearAssetsFolder, userID, clientID); err != nil {
		return err
	}
	_, err := q.db.Exec(ctx, deleteAssetFolder, userID, clientID)
	return err
}

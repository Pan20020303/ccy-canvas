// Hand-written to match sqlc conventions (source: db/queries/canvas_versions.sql).
// 项目约定:不整包重跑 sqlc generate,新查询手写补齐。

package sqlc

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
)

const insertCanvasVersion = `-- name: InsertCanvasVersion :one
INSERT INTO canvas_versions (project_id, nodes, edges, groups, label, created_by)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING id, created_at
`

type InsertCanvasVersionParams struct {
	ProjectID pgtype.UUID `json:"project_id"`
	Nodes     []byte      `json:"nodes"`
	Edges     []byte      `json:"edges"`
	Groups    []byte      `json:"groups"`
	Label     string      `json:"label"`
	CreatedBy pgtype.UUID `json:"created_by"`
}

type InsertCanvasVersionRow struct {
	ID        pgtype.UUID        `json:"id"`
	CreatedAt pgtype.Timestamptz `json:"created_at"`
}

func (q *Queries) InsertCanvasVersion(ctx context.Context, arg InsertCanvasVersionParams) (InsertCanvasVersionRow, error) {
	row := q.db.QueryRow(ctx, insertCanvasVersion, arg.ProjectID, arg.Nodes, arg.Edges, arg.Groups, arg.Label, arg.CreatedBy)
	var i InsertCanvasVersionRow
	err := row.Scan(&i.ID, &i.CreatedAt)
	return i, err
}

const listCanvasVersions = `-- name: ListCanvasVersions :many
SELECT v.id, v.label, v.created_by, v.created_at, COALESCE(u.name, '') AS author_name
FROM canvas_versions v
LEFT JOIN users u ON u.id = v.created_by
WHERE v.project_id = $1
ORDER BY v.created_at DESC
LIMIT 100
`

type ListCanvasVersionsRow struct {
	ID         pgtype.UUID        `json:"id"`
	Label      string             `json:"label"`
	CreatedBy  pgtype.UUID        `json:"created_by"`
	CreatedAt  pgtype.Timestamptz `json:"created_at"`
	AuthorName string             `json:"author_name"`
}

func (q *Queries) ListCanvasVersions(ctx context.Context, projectID pgtype.UUID) ([]ListCanvasVersionsRow, error) {
	rows, err := q.db.Query(ctx, listCanvasVersions, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []ListCanvasVersionsRow{}
	for rows.Next() {
		var i ListCanvasVersionsRow
		if err := rows.Scan(&i.ID, &i.Label, &i.CreatedBy, &i.CreatedAt, &i.AuthorName); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	return items, rows.Err()
}

const getCanvasVersion = `-- name: GetCanvasVersion :one
SELECT id, project_id, nodes, edges, groups FROM canvas_versions WHERE id = $1
`

type GetCanvasVersionRow struct {
	ID        pgtype.UUID `json:"id"`
	ProjectID pgtype.UUID `json:"project_id"`
	Nodes     []byte      `json:"nodes"`
	Edges     []byte      `json:"edges"`
	Groups    []byte      `json:"groups"`
}

func (q *Queries) GetCanvasVersion(ctx context.Context, id pgtype.UUID) (GetCanvasVersionRow, error) {
	row := q.db.QueryRow(ctx, getCanvasVersion, id)
	var i GetCanvasVersionRow
	err := row.Scan(&i.ID, &i.ProjectID, &i.Nodes, &i.Edges, &i.Groups)
	return i, err
}

const pruneCanvasVersions = `-- name: PruneCanvasVersions :exec
DELETE FROM canvas_versions
WHERE project_id = $1
  AND id NOT IN (
    SELECT id FROM canvas_versions WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2
  )
`

func (q *Queries) PruneCanvasVersions(ctx context.Context, projectID pgtype.UUID, keep int32) error {
	_, err := q.db.Exec(ctx, pruneCanvasVersions, projectID, keep)
	return err
}

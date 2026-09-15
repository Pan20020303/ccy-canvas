// Hand-written to match sqlc conventions (source: db/queries/comments.sql).
// 项目约定:不整包重跑 sqlc generate,新查询手写补齐。

package sqlc

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
)

const listProjectComments = `-- name: ListProjectComments :many
SELECT c.id, c.project_id, c.node_id, c.author_id, c.parent_id, c.body, c.resolved, c.created_at,
       u.name AS author_name
FROM canvas_comments c
JOIN users u ON u.id = c.author_id
WHERE c.project_id = $1
ORDER BY c.created_at ASC
LIMIT 2000
`

type ListProjectCommentsRow struct {
	ID         pgtype.UUID        `json:"id"`
	ProjectID  pgtype.UUID        `json:"project_id"`
	NodeID     string             `json:"node_id"`
	AuthorID   pgtype.UUID        `json:"author_id"`
	ParentID   pgtype.UUID        `json:"parent_id"`
	Body       string             `json:"body"`
	Resolved   bool               `json:"resolved"`
	CreatedAt  pgtype.Timestamptz `json:"created_at"`
	AuthorName string             `json:"author_name"`
}

func (q *Queries) ListProjectComments(ctx context.Context, projectID pgtype.UUID) ([]ListProjectCommentsRow, error) {
	rows, err := q.db.Query(ctx, listProjectComments, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []ListProjectCommentsRow{}
	for rows.Next() {
		var i ListProjectCommentsRow
		if err := rows.Scan(&i.ID, &i.ProjectID, &i.NodeID, &i.AuthorID, &i.ParentID, &i.Body, &i.Resolved, &i.CreatedAt, &i.AuthorName); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	return items, rows.Err()
}

const insertComment = `-- name: InsertComment :one
INSERT INTO canvas_comments (project_id, node_id, author_id, parent_id, body)
VALUES ($1, $2, $3, $4, $5)
RETURNING id, project_id, node_id, author_id, parent_id, body, resolved, created_at
`

type InsertCommentParams struct {
	ProjectID pgtype.UUID `json:"project_id"`
	NodeID    string      `json:"node_id"`
	AuthorID  pgtype.UUID `json:"author_id"`
	ParentID  pgtype.UUID `json:"parent_id"`
	Body      string      `json:"body"`
}

type CanvasComment struct {
	ID        pgtype.UUID        `json:"id"`
	ProjectID pgtype.UUID        `json:"project_id"`
	NodeID    string             `json:"node_id"`
	AuthorID  pgtype.UUID        `json:"author_id"`
	ParentID  pgtype.UUID        `json:"parent_id"`
	Body      string             `json:"body"`
	Resolved  bool               `json:"resolved"`
	CreatedAt pgtype.Timestamptz `json:"created_at"`
}

func (q *Queries) InsertComment(ctx context.Context, arg InsertCommentParams) (CanvasComment, error) {
	row := q.db.QueryRow(ctx, insertComment, arg.ProjectID, arg.NodeID, arg.AuthorID, arg.ParentID, arg.Body)
	var i CanvasComment
	err := row.Scan(&i.ID, &i.ProjectID, &i.NodeID, &i.AuthorID, &i.ParentID, &i.Body, &i.Resolved, &i.CreatedAt)
	return i, err
}

const getCommentByID = `-- name: GetCommentByID :one
SELECT id, project_id, author_id FROM canvas_comments WHERE id = $1
`

type GetCommentByIDRow struct {
	ID        pgtype.UUID `json:"id"`
	ProjectID pgtype.UUID `json:"project_id"`
	AuthorID  pgtype.UUID `json:"author_id"`
}

func (q *Queries) GetCommentByID(ctx context.Context, id pgtype.UUID) (GetCommentByIDRow, error) {
	row := q.db.QueryRow(ctx, getCommentByID, id)
	var i GetCommentByIDRow
	err := row.Scan(&i.ID, &i.ProjectID, &i.AuthorID)
	return i, err
}

const setCommentResolved = `-- name: SetCommentResolved :exec
UPDATE canvas_comments SET resolved = $2 WHERE id = $1
`

type SetCommentResolvedParams struct {
	ID       pgtype.UUID `json:"id"`
	Resolved bool        `json:"resolved"`
}

func (q *Queries) SetCommentResolved(ctx context.Context, arg SetCommentResolvedParams) error {
	_, err := q.db.Exec(ctx, setCommentResolved, arg.ID, arg.Resolved)
	return err
}

const deleteComment = `-- name: DeleteComment :exec
DELETE FROM canvas_comments WHERE id = $1
`

func (q *Queries) DeleteComment(ctx context.Context, id pgtype.UUID) error {
	_, err := q.db.Exec(ctx, deleteComment, id)
	return err
}

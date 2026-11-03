// Code manually written to match sqlc conventions (source: db/queries/prompt_templates.sql).
// 项目约定:不整包重跑 sqlc generate(会打乱既有文件组织),新查询手写补齐。

package sqlc

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
)

const listPromptTemplates = `-- name: ListPromptTemplates :many
SELECT
    t.id, t.owner_id, t.title, t.content, t.created_at,
    u.name AS owner_name,
    u.email AS owner_email,
    COALESCE(SUM(CASE WHEN v.vote = 1 THEN 1 ELSE 0 END), 0)::int  AS upvotes,
    COALESCE(SUM(CASE WHEN v.vote = -1 THEN 1 ELSE 0 END), 0)::int AS downvotes,
    COALESCE(MAX(CASE WHEN v.user_id = $1 THEN v.vote END), 0)::int AS my_vote
FROM prompt_templates t
JOIN users u ON u.id = t.owner_id
LEFT JOIN prompt_template_votes v ON v.template_id = t.id
GROUP BY t.id, u.name, u.email
ORDER BY t.created_at DESC
LIMIT 500
`

type ListPromptTemplatesRow struct {
	ID         pgtype.UUID        `json:"id"`
	OwnerID    pgtype.UUID        `json:"owner_id"`
	Title      string             `json:"title"`
	Content    string             `json:"content"`
	CreatedAt  pgtype.Timestamptz `json:"created_at"`
	OwnerName  string             `json:"owner_name"`
	OwnerEmail string             `json:"owner_email"`
	Upvotes    int32              `json:"upvotes"`
	Downvotes  int32              `json:"downvotes"`
	MyVote     int32              `json:"my_vote"`
}

func (q *Queries) ListPromptTemplates(ctx context.Context, viewerID pgtype.UUID) ([]ListPromptTemplatesRow, error) {
	rows, err := q.db.Query(ctx, listPromptTemplates, viewerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []ListPromptTemplatesRow{}
	for rows.Next() {
		var i ListPromptTemplatesRow
		if err := rows.Scan(&i.ID, &i.OwnerID, &i.Title, &i.Content, &i.CreatedAt, &i.OwnerName, &i.OwnerEmail, &i.Upvotes, &i.Downvotes, &i.MyVote); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	return items, rows.Err()
}

const insertPromptTemplate = `-- name: InsertPromptTemplate :one
INSERT INTO prompt_templates (owner_id, title, content)
VALUES ($1, $2, $3)
RETURNING id, owner_id, title, content, created_at
`

type InsertPromptTemplateParams struct {
	OwnerID pgtype.UUID `json:"owner_id"`
	Title   string      `json:"title"`
	Content string      `json:"content"`
}

type PromptTemplate struct {
	ID        pgtype.UUID        `json:"id"`
	OwnerID   pgtype.UUID        `json:"owner_id"`
	Title     string             `json:"title"`
	Content   string             `json:"content"`
	CreatedAt pgtype.Timestamptz `json:"created_at"`
}

func (q *Queries) InsertPromptTemplate(ctx context.Context, arg InsertPromptTemplateParams) (PromptTemplate, error) {
	row := q.db.QueryRow(ctx, insertPromptTemplate, arg.OwnerID, arg.Title, arg.Content)
	var i PromptTemplate
	err := row.Scan(&i.ID, &i.OwnerID, &i.Title, &i.Content, &i.CreatedAt)
	return i, err
}

const deletePromptTemplateByOwner = `-- name: DeletePromptTemplateByOwner :execrows
DELETE FROM prompt_templates WHERE id = $1 AND owner_id = $2
`

type DeletePromptTemplateByOwnerParams struct {
	ID      pgtype.UUID `json:"id"`
	OwnerID pgtype.UUID `json:"owner_id"`
}

func (q *Queries) DeletePromptTemplateByOwner(ctx context.Context, arg DeletePromptTemplateByOwnerParams) (int64, error) {
	result, err := q.db.Exec(ctx, deletePromptTemplateByOwner, arg.ID, arg.OwnerID)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected(), nil
}

const deletePromptTemplateAdmin = `-- name: DeletePromptTemplateAdmin :exec
DELETE FROM prompt_templates WHERE id = $1
`

func (q *Queries) DeletePromptTemplateAdmin(ctx context.Context, id pgtype.UUID) error {
	_, err := q.db.Exec(ctx, deletePromptTemplateAdmin, id)
	return err
}

const upsertPromptTemplateVote = `-- name: UpsertPromptTemplateVote :exec
INSERT INTO prompt_template_votes (template_id, user_id, vote)
VALUES ($1, $2, $3)
ON CONFLICT (template_id, user_id) DO UPDATE SET vote = EXCLUDED.vote
`

type UpsertPromptTemplateVoteParams struct {
	TemplateID pgtype.UUID `json:"template_id"`
	UserID     pgtype.UUID `json:"user_id"`
	Vote       int16       `json:"vote"`
}

func (q *Queries) UpsertPromptTemplateVote(ctx context.Context, arg UpsertPromptTemplateVoteParams) error {
	_, err := q.db.Exec(ctx, upsertPromptTemplateVote, arg.TemplateID, arg.UserID, arg.Vote)
	return err
}

const deletePromptTemplateVote = `-- name: DeletePromptTemplateVote :exec
DELETE FROM prompt_template_votes WHERE template_id = $1 AND user_id = $2
`

type DeletePromptTemplateVoteParams struct {
	TemplateID pgtype.UUID `json:"template_id"`
	UserID     pgtype.UUID `json:"user_id"`
}

func (q *Queries) DeletePromptTemplateVote(ctx context.Context, arg DeletePromptTemplateVoteParams) error {
	_, err := q.db.Exec(ctx, deletePromptTemplateVote, arg.TemplateID, arg.UserID)
	return err
}

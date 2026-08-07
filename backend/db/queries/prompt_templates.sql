-- name: ListPromptTemplates :many
-- 全站模板 + 赞/踩计数 + 当前用户的投票与归属(is_mine 由调用方比对 owner_id)。
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
LIMIT 500;

-- name: InsertPromptTemplate :one
INSERT INTO prompt_templates (owner_id, title, content)
VALUES ($1, $2, $3)
RETURNING id, owner_id, title, content, created_at;

-- name: DeletePromptTemplateByOwner :execrows
DELETE FROM prompt_templates WHERE id = $1 AND owner_id = $2;

-- name: DeletePromptTemplateAdmin :exec
DELETE FROM prompt_templates WHERE id = $1;

-- name: UpsertPromptTemplateVote :exec
INSERT INTO prompt_template_votes (template_id, user_id, vote)
VALUES ($1, $2, $3)
ON CONFLICT (template_id, user_id) DO UPDATE SET vote = EXCLUDED.vote;

-- name: DeletePromptTemplateVote :exec
DELETE FROM prompt_template_votes WHERE template_id = $1 AND user_id = $2;

-- name: ListVisibleSkills :many
-- Returns all enabled skills the caller can see: globals + their own personals.
SELECT id, scope, owner_id, name, description, category, icon, kind, spec, input_schema, output_schema, enabled, created_at, updated_at
FROM skills
WHERE enabled = TRUE
  AND (scope = 'global' OR (scope = 'personal' AND owner_id = $1))
ORDER BY scope ASC, created_at DESC;

-- name: ListAllSkills :many
-- Admin-only: every skill across every scope.
SELECT id, scope, owner_id, name, description, category, icon, kind, spec, input_schema, output_schema, enabled, created_at, updated_at
FROM skills
ORDER BY scope ASC, created_at DESC;

-- name: GetSkill :one
SELECT id, scope, owner_id, name, description, category, icon, kind, spec, input_schema, output_schema, enabled, created_at, updated_at
FROM skills
WHERE id = $1;

-- name: InsertSkill :one
INSERT INTO skills (scope, owner_id, name, description, category, icon, kind, spec, input_schema, output_schema, enabled)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
RETURNING id, scope, owner_id, name, description, category, icon, kind, spec, input_schema, output_schema, enabled, created_at, updated_at;

-- name: UpdateSkill :one
UPDATE skills
SET name = $2,
    description = $3,
    category = $4,
    icon = $5,
    kind = $6,
    spec = $7,
    input_schema = $8,
    output_schema = $9,
    enabled = $10,
    updated_at = now()
WHERE id = $1
RETURNING id, scope, owner_id, name, description, category, icon, kind, spec, input_schema, output_schema, enabled, created_at, updated_at;

-- name: DeleteSkill :exec
DELETE FROM skills WHERE id = $1;

-- name: ListProjectsByOwner :many
SELECT id, owner_id, name, created_at, updated_at
FROM projects
WHERE owner_id = $1
ORDER BY updated_at DESC;

-- name: CreateProject :one
INSERT INTO projects (owner_id, name)
VALUES ($1, $2)
RETURNING id, owner_id, name, created_at, updated_at;

-- name: GetProjectByID :one
SELECT id, owner_id, name, created_at, updated_at
FROM projects
WHERE id = $1;

-- name: UpdateProjectName :one
UPDATE projects
SET name = $2, updated_at = now()
WHERE id = $1 AND owner_id = $3
RETURNING id, owner_id, name, created_at, updated_at;

-- name: GetCanvasSnapshot :one
SELECT id, project_id, user_id, nodes, edges, version, created_at
FROM canvas_snapshots
WHERE project_id = $1;

-- name: UpsertCanvasSnapshot :one
INSERT INTO canvas_snapshots (project_id, user_id, nodes, edges, version)
VALUES ($1, $2, $3, $4, 1)
ON CONFLICT (project_id) DO UPDATE
  SET nodes = EXCLUDED.nodes,
      edges = EXCLUDED.edges,
      version = canvas_snapshots.version + 1,
      user_id = EXCLUDED.user_id
RETURNING id, project_id, user_id, nodes, edges, version, created_at;

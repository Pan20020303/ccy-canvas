-- name: ListProjectsByOwner :many
SELECT id, owner_id, name, cover_url, folder_id, created_at, updated_at
FROM projects
WHERE owner_id = $1
ORDER BY updated_at DESC;

-- name: CreateProject :one
INSERT INTO projects (owner_id, name)
VALUES ($1, $2)
RETURNING id, owner_id, name, cover_url, folder_id, created_at, updated_at;

-- name: GetProjectByID :one
SELECT id, owner_id, name, cover_url, folder_id, created_at, updated_at
FROM projects
WHERE id = $1;

-- name: ListTemplateProjects :many
-- 首页「从模板开始」:全站模板项目,任何登录用户可见,倒序。
SELECT id, name, cover_url, created_at
FROM projects
WHERE is_template
ORDER BY created_at DESC
LIMIT 100;

-- name: SetProjectTemplate :exec
-- 管理端把某项目标记/取消为模板。
UPDATE projects SET is_template = $2, updated_at = now() WHERE id = $1;

-- name: GetProjectIsTemplate :one
SELECT is_template FROM projects WHERE id = $1;

-- name: UpdateProjectName :one
UPDATE projects
SET name = $2, updated_at = now()
WHERE id = $1 AND owner_id = $3
RETURNING id, owner_id, name, cover_url, folder_id, created_at, updated_at;

-- name: UpdateProjectCover :one
UPDATE projects
SET cover_url = $2, updated_at = now()
WHERE id = $1 AND owner_id = $3
RETURNING id, owner_id, name, cover_url, folder_id, created_at, updated_at;

-- name: UpdateProjectFolder :one
UPDATE projects
SET folder_id = $2, updated_at = now()
WHERE id = $1 AND owner_id = $3
RETURNING id, owner_id, name, cover_url, folder_id, created_at, updated_at;

-- name: DeleteProject :execrows
DELETE FROM projects
WHERE id = $1 AND owner_id = $2;

-- name: CreateProjectFolder :one
INSERT INTO project_folders (owner_id, name)
VALUES ($1, $2)
RETURNING id, owner_id, name, created_at;

-- name: ListProjectFoldersByOwner :many
SELECT id, owner_id, name, created_at
FROM project_folders
WHERE owner_id = $1
ORDER BY created_at DESC;

-- name: DeleteProjectFolder :execrows
DELETE FROM project_folders
WHERE id = $1 AND owner_id = $2;

-- name: GetCanvasSnapshot :one
SELECT id, project_id, user_id, nodes, edges, groups, version, created_at
FROM canvas_snapshots
WHERE project_id = $1;

-- name: UpsertCanvasSnapshot :one
INSERT INTO canvas_snapshots (project_id, user_id, nodes, edges, groups, version)
VALUES ($1, $2, $3, $4, $5, 1)
ON CONFLICT (project_id) DO UPDATE
  SET nodes = EXCLUDED.nodes,
      edges = EXCLUDED.edges,
      groups = EXCLUDED.groups,
      version = canvas_snapshots.version + 1,
      user_id = EXCLUDED.user_id
RETURNING id, project_id, user_id, nodes, edges, groups, version, created_at;

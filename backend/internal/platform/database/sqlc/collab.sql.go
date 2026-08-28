// Hand-authored bindings for project collaboration (migration
// 027_project_collaboration.sql). Lives outside the sqlc-generated files
// (same convention as saved_assets.sql.go) so it can be iterated without
// re-running sqlc generate.

package sqlc

import (
	"context"

	"github.com/jackc/pgx/v5/pgtype"
)

// ─── 项目列表(含我参与的协作项目)────────────────────────────────────────

type ProjectForUserRow struct {
	ID              pgtype.UUID
	OwnerID         pgtype.UUID
	Name            string
	CoverUrl        string
	FolderID        pgtype.UUID
	IsCollaborative bool
	MyRole          string // owner → 'creator';否则 project_members.role
	CreatedAt       pgtype.Timestamptz
	UpdatedAt       pgtype.Timestamptz
}

const listProjectsForUser = `
SELECT p.id, p.owner_id, p.name, p.cover_url, p.folder_id, p.is_collaborative,
       CASE WHEN p.owner_id = $1 THEN 'creator' ELSE COALESCE(pm.role, '') END AS my_role,
       p.created_at, p.updated_at
FROM projects p
LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $1
WHERE p.owner_id = $1 OR pm.user_id = $1
ORDER BY p.created_at DESC
`

// ListProjectsForUser returns projects the user owns PLUS projects they were
// invited to (as a member), with the caller's effective role on each.
func (q *Queries) ListProjectsForUser(ctx context.Context, userID pgtype.UUID) ([]ProjectForUserRow, error) {
	rows, err := q.db.Query(ctx, listProjectsForUser, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []ProjectForUserRow{}
	for rows.Next() {
		var i ProjectForUserRow
		if err := rows.Scan(
			&i.ID, &i.OwnerID, &i.Name, &i.CoverUrl, &i.FolderID, &i.IsCollaborative,
			&i.MyRole, &i.CreatedAt, &i.UpdatedAt,
		); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	return items, rows.Err()
}

// ─── 协作标记 ────────────────────────────────────────────────────────────────

const setProjectCollaborative = `
UPDATE projects SET is_collaborative = $3, updated_at = now()
WHERE id = $1 AND owner_id = $2
`

// SetProjectCollaborative flips the collaborative flag (owner-only). Returns
// rows affected (0 = not the owner / not found).
func (q *Queries) SetProjectCollaborative(ctx context.Context, projectID, ownerID pgtype.UUID, collaborative bool) (int64, error) {
	tag, err := q.db.Exec(ctx, setProjectCollaborative, projectID, ownerID, collaborative)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

const getProjectIsCollaborative = `SELECT owner_id, is_collaborative FROM projects WHERE id = $1`

type ProjectOwnerCollabRow struct {
	OwnerID         pgtype.UUID
	IsCollaborative bool
}

func (q *Queries) GetProjectOwnerCollab(ctx context.Context, projectID pgtype.UUID) (ProjectOwnerCollabRow, error) {
	var r ProjectOwnerCollabRow
	err := q.db.QueryRow(ctx, getProjectIsCollaborative, projectID).Scan(&r.OwnerID, &r.IsCollaborative)
	return r, err
}

// ─── 成员 ────────────────────────────────────────────────────────────────────

type ProjectMemberRow struct {
	UserID    pgtype.UUID
	Name      string
	Role      string
	CreatedAt pgtype.Timestamptz
}

const listProjectMembers = `
SELECT pm.user_id, u.name, pm.role, pm.created_at
FROM project_members pm
JOIN users u ON u.id = pm.user_id
WHERE pm.project_id = $1
ORDER BY pm.created_at ASC
`

func (q *Queries) ListProjectMembers(ctx context.Context, projectID pgtype.UUID) ([]ProjectMemberRow, error) {
	rows, err := q.db.Query(ctx, listProjectMembers, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []ProjectMemberRow{}
	for rows.Next() {
		var i ProjectMemberRow
		if err := rows.Scan(&i.UserID, &i.Name, &i.Role, &i.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, i)
	}
	return items, rows.Err()
}

const getProjectMemberRole = `SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2`

// GetProjectMemberRole returns the member's role, or "" if not a member.
func (q *Queries) GetProjectMemberRole(ctx context.Context, projectID, userID pgtype.UUID) (string, error) {
	var role string
	err := q.db.QueryRow(ctx, getProjectMemberRole, projectID, userID).Scan(&role)
	if err != nil {
		return "", err
	}
	return role, nil
}

const upsertProjectMember = `
INSERT INTO project_members (project_id, user_id, role)
VALUES ($1, $2, $3)
ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role
`

func (q *Queries) UpsertProjectMember(ctx context.Context, projectID, userID pgtype.UUID, role string) error {
	_, err := q.db.Exec(ctx, upsertProjectMember, projectID, userID, role)
	return err
}

const deleteProjectMember = `DELETE FROM project_members WHERE project_id = $1 AND user_id = $2`

func (q *Queries) DeleteProjectMember(ctx context.Context, projectID, userID pgtype.UUID) error {
	_, err := q.db.Exec(ctx, deleteProjectMember, projectID, userID)
	return err
}

const clearProjectMembers = `DELETE FROM project_members WHERE project_id = $1`

// ClearProjectMembers removes all members (used when reverting to private).
func (q *Queries) ClearProjectMembers(ctx context.Context, projectID pgtype.UUID) error {
	_, err := q.db.Exec(ctx, clearProjectMembers, projectID)
	return err
}

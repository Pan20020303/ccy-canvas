// Package domain contains workspace bounded context types.
package domain

import (
	"encoding/json"
	"time"
)

// Project represents a canvas project owned by a user.
type Project struct {
	ID        string
	OwnerID   string
	Name      string
	CoverURL  string
	FolderID  string // empty = not in any folder
	CreatedAt time.Time
	UpdatedAt time.Time
}

// ProjectAccess is a project plus the caller's collaboration context:
// whether it's collaborative and the caller's effective role
// (creator/admin/collaborator/visitor).
type ProjectAccess struct {
	Project
	IsCollaborative bool
	MyRole          string
}

// ProjectMember is an invited collaborator on a project (the owner is not a
// member row — the owner is the project's owner_id / "creator").
type ProjectMember struct {
	UserID    string
	Name      string
	Role      string // admin | collaborator | visitor
	CreatedAt time.Time
}

// Folder groups projects on the homepage grid.
type Folder struct {
	ID        string
	OwnerID   string
	Name      string
	CreatedAt time.Time
}

// CanvasSnapshot holds the serialised nodes and edges of a canvas at a point in time.
type CanvasSnapshot struct {
	ID        string
	ProjectID string
	UserID    string
	Nodes     json.RawMessage
	Edges     json.RawMessage
	Groups    json.RawMessage
	Version   int32
	CreatedAt time.Time
}

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

// CanvasVersion is a saved restore point of a project's canvas (metadata only;
// the heavy nodes/edges live in the row but aren't loaded for the list view).
type CanvasVersion struct {
	ID         string
	Label      string
	AuthorName string
	CreatedAt  time.Time
}

// Comment is a canvas comment anchored to a node (NodeID empty = project-level),
// optionally a reply (ParentID set) in a thread.
type Comment struct {
	ID         string
	ProjectID  string
	NodeID     string
	AuthorID   string
	AuthorName string
	ParentID   string // empty = thread root
	Body       string
	Resolved   bool
	CreatedAt  time.Time
}

// TemplateProject is a lightweight view of a project marked as a template,
// shown on the homepage "start from a template" wall.
type TemplateProject struct {
	ID        string
	Name      string
	CoverURL  string
	CreatedAt time.Time
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

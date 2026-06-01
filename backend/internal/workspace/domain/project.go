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
	CreatedAt time.Time
	UpdatedAt time.Time
}

// CanvasSnapshot holds the serialised nodes and edges of a canvas at a point in time.
type CanvasSnapshot struct {
	ID        string
	ProjectID string
	UserID    string
	Nodes     json.RawMessage
	Edges     json.RawMessage
	Version   int32
	CreatedAt time.Time
}

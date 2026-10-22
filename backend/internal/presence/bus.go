// Package presence is an ephemeral, project-scoped pub/sub for live
// collaboration presence (cursors, selections, drag activity). It mirrors the
// modelcatalog TaskEventBus design but keys on projectID instead of userID and
// additionally maintains a per-project online roster so a freshly connected
// client immediately sees who is already present.
//
// Everything here is EPHEMERAL — nothing is persisted. Cross-replica fan-out
// reuses the same optional EventTransport pattern (Redis Pub/Sub) as the task
// bus; every replica materializes the roster from the shared event stream, so
// no separate shared store is needed.
package presence

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"time"
)

// Cursor is a point in flow (canvas) coordinates — resolution/zoom independent.
type Cursor struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// Activity marks nodes a collaborator is actively manipulating (Tier 3).
type Activity struct {
	Kind    string   `json:"kind,omitempty"` // "drag" | "edit"
	NodeIDs []string `json:"node_ids,omitempty"`
}

// PresenceEvent is one broadcast frame for a project room.
type PresenceEvent struct {
	Type      string    `json:"type"` // "presence" | "leave"
	UID       string    `json:"uid"`
	Name      string    `json:"name,omitempty"`
	Color     string    `json:"color,omitempty"`
	Cursor    *Cursor   `json:"cursor,omitempty"`
	Selection []string  `json:"selection,omitempty"` // node ids this user has selected (Tier 2)
	Activity  *Activity `json:"activity,omitempty"`  // Tier 3
	TS        int64     `json:"ts"`
}

// EventTransport is the cross-replica fan-out interface. *events.RedisTransport
// satisfies it structurally, so this package stays Redis-free.
type EventTransport interface {
	Publish(ctx context.Context, channel string, payload []byte) error
	Subscribe(ctx context.Context, channel string) (<-chan []byte, error)
}

const presenceChannel = "ccy:presence-events"

// staleAfter drops a roster entry that hasn't sent a heartbeat/update in this
// long — the backstop for missed leave frames (crashed tab / dropped replica).
const staleAfter = 12 * time.Second

type envelope struct {
	ProjectID string        `json:"project_id"`
	Event     PresenceEvent `json:"event"`
}

// Subscriber is one connected SSE client.
type Subscriber struct {
	ch chan PresenceEvent
}

func (s *Subscriber) Events() <-chan PresenceEvent { return s.ch }

type rosterEntry struct {
	ev       PresenceEvent
	lastSeen time.Time
}

// Bus fans presence events out to project-room subscribers and tracks the
// online roster.
type Bus struct {
	mu     sync.RWMutex
	subs   map[string]map[*Subscriber]struct{} // projectID → subscribers
	roster map[string]map[string]*rosterEntry  // projectID → uid → latest
	conns  map[string]map[string]int           // projectID → uid → local SSE connection count

	transport EventTransport
}

func NewBus() *Bus {
	return &Bus{
		subs:   make(map[string]map[*Subscriber]struct{}),
		roster: make(map[string]map[string]*rosterEntry),
		conns:  make(map[string]map[string]int),
	}
}

func (b *Bus) WithTransport(t EventTransport) *Bus {
	b.transport = t
	return b
}

// Subscribe registers an SSE client for a project room. uid is the connected
// user; a per-(project,uid) connection count lets us emit a leave only when the
// user's last local connection closes. The returned snapshot is the set of
// users currently present, so the client can render them immediately.
func (b *Bus) Subscribe(projectID, uid string) (*Subscriber, []PresenceEvent, func()) {
	sub := &Subscriber{ch: make(chan PresenceEvent, 32)}
	b.mu.Lock()
	set, ok := b.subs[projectID]
	if !ok {
		set = make(map[*Subscriber]struct{})
		b.subs[projectID] = set
	}
	set[sub] = struct{}{}
	if b.conns[projectID] == nil {
		b.conns[projectID] = make(map[string]int)
	}
	b.conns[projectID][uid]++
	snapshot := b.rosterLocked(projectID, uid)
	b.mu.Unlock()

	unsubscribe := func() {
		b.mu.Lock()
		lastConn := false
		if set, ok := b.subs[projectID]; ok {
			if _, present := set[sub]; present {
				delete(set, sub)
				close(sub.ch)
				if len(set) == 0 {
					delete(b.subs, projectID)
				}
			}
		}
		if c := b.conns[projectID]; c != nil {
			c[uid]--
			if c[uid] <= 0 {
				delete(c, uid)
				lastConn = true
			}
			if len(c) == 0 {
				delete(b.conns, projectID)
			}
		}
		b.mu.Unlock()
		// Only announce leave when this user's last local connection is gone.
		if lastConn {
			b.Publish(projectID, PresenceEvent{Type: "leave", UID: uid, TS: time.Now().UnixMilli()})
		}
	}
	return sub, snapshot, unsubscribe
}

// rosterLocked returns the current presence frames for a project, excluding
// selfUID. Caller must hold b.mu.
func (b *Bus) rosterLocked(projectID, selfUID string) []PresenceEvent {
	room := b.roster[projectID]
	out := make([]PresenceEvent, 0, len(room))
	for uid, e := range room {
		if uid == selfUID {
			continue
		}
		out = append(out, e.ev)
	}
	return out
}

// Publish broadcasts an event to the project's subscribers. With a transport
// it goes through Redis and every replica (including this one) delivers via its
// bridge, so there's exactly one delivery path.
func (b *Bus) Publish(projectID string, ev PresenceEvent) {
	if projectID == "" || ev.UID == "" {
		return
	}
	if b.transport != nil {
		payload, err := json.Marshal(envelope{ProjectID: projectID, Event: ev})
		if err != nil {
			return
		}
		if perr := b.transport.Publish(context.Background(), presenceChannel, payload); perr != nil {
			log.Printf("[presence] transport publish failed, delivering locally: %v", perr)
			b.handle(projectID, ev)
		}
		return
	}
	b.handle(projectID, ev)
}

// StartBridge consumes presence events from other replicas. No-op without a
// transport. Run in a goroutine.
func (b *Bus) StartBridge(ctx context.Context) {
	if b.transport == nil {
		return
	}
	stream, err := b.transport.Subscribe(ctx, presenceChannel)
	if err != nil {
		log.Printf("[presence] failed to subscribe transport: %v", err)
		return
	}
	log.Printf("[presence] cross-process presence bridge started")
	for {
		select {
		case <-ctx.Done():
			return
		case payload, ok := <-stream:
			if !ok {
				return
			}
			var env envelope
			if err := json.Unmarshal(payload, &env); err != nil {
				continue
			}
			b.handle(env.ProjectID, env.Event)
		}
	}
}

// handle updates the roster and fans the event out to local subscribers.
func (b *Bus) handle(projectID string, ev PresenceEvent) {
	b.mu.Lock()
	room := b.roster[projectID]
	if room == nil {
		room = make(map[string]*rosterEntry)
		b.roster[projectID] = room
	}
	if ev.Type == "leave" {
		delete(room, ev.UID)
		if len(room) == 0 {
			delete(b.roster, projectID)
		}
	} else {
		room[ev.UID] = &rosterEntry{ev: ev, lastSeen: time.Now()}
	}
	receivers := make([]*Subscriber, 0, len(b.subs[projectID]))
	for sub := range b.subs[projectID] {
		receivers = append(receivers, sub)
	}
	b.mu.Unlock()

	for _, sub := range receivers {
		select {
		case sub.ch <- ev:
		default:
			// Full buffer: drop oldest, enqueue newest (cursors are newest-wins).
			select {
			case <-sub.ch:
			default:
			}
			select {
			case sub.ch <- ev:
			default:
			}
		}
	}
}

// StartSweeper periodically evicts stale roster entries (missed leaves) and
// broadcasts a synthetic leave so every replica's subscribers drop the ghost.
func (b *Bus) StartSweeper(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			cutoff := time.Now().Add(-staleAfter)
			type stale struct{ projectID, uid string }
			var expired []stale
			b.mu.RLock()
			for pid, room := range b.roster {
				for uid, e := range room {
					if e.lastSeen.Before(cutoff) {
						expired = append(expired, stale{pid, uid})
					}
				}
			}
			b.mu.RUnlock()
			for _, s := range expired {
				b.handle(s.projectID, PresenceEvent{Type: "leave", UID: s.uid, TS: time.Now().UnixMilli()})
			}
		}
	}
}

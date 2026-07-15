// Package canvassync is a project-scoped, best-effort pub/sub that broadcasts
// OPAQUE canvas-edit deltas to everyone else in a project room, so collaborators
// see each other's node/edge/group changes live (not just on refresh) and their
// local states converge — which also stops the full-snapshot autosave from
// silently clobbering a peer's concurrent edits.
//
// It mirrors presence.Bus but is even simpler: NO roster, NO TTL, NO leave —
// pure fan-out. The delta payload (Ops) is relayed verbatim; its shape is a
// frontend contract the backend never parses. Late-joiners resync via the
// existing full-snapshot canvas load. Cross-replica fan-out reuses the same
// optional EventTransport (Redis Pub/Sub) as presence + the task bus.
package canvassync

import (
	"context"
	"encoding/json"
	"log"
	"sync"
)

// CanvasEvent is one broadcast frame: an opaque canvas delta authored by UID.
type CanvasEvent struct {
	UID string          `json:"uid"`
	Ops json.RawMessage `json:"ops"`
	TS  int64           `json:"ts"`
}

// EventTransport is the cross-replica fan-out interface. *events.RedisTransport
// satisfies it structurally, so this package stays Redis-free.
type EventTransport interface {
	Publish(ctx context.Context, channel string, payload []byte) error
	Subscribe(ctx context.Context, channel string) (<-chan []byte, error)
}

const canvasChannel = "ccy:canvas-events"

// Subscriber is one connected SSE client.
type Subscriber struct{ ch chan CanvasEvent }

func (s *Subscriber) Events() <-chan CanvasEvent { return s.ch }

type envelope struct {
	ProjectID string      `json:"project_id"`
	Event     CanvasEvent `json:"event"`
}

// Bus fans opaque canvas-op events out to project-room subscribers.
type Bus struct {
	mu        sync.RWMutex
	subs      map[string]map[*Subscriber]struct{} // projectID → subscribers
	transport EventTransport
}

func NewBus() *Bus {
	return &Bus{subs: make(map[string]map[*Subscriber]struct{})}
}

func (b *Bus) WithTransport(t EventTransport) *Bus {
	b.transport = t
	return b
}

// Subscribe registers an SSE client for a project room. Returns the subscriber
// and an unsubscribe func. No roster — late-joiners resync via snapshot load.
func (b *Bus) Subscribe(projectID string) (*Subscriber, func()) {
	// Roomy buffer so a briefly-slow SSE consumer doesn't drop canvas ops (a
	// dropped op diverges that client until the next full-snapshot save/load
	// resyncs). Still non-blocking on overflow — see handle().
	sub := &Subscriber{ch: make(chan CanvasEvent, 256)}
	b.mu.Lock()
	set, ok := b.subs[projectID]
	if !ok {
		set = make(map[*Subscriber]struct{})
		b.subs[projectID] = set
	}
	set[sub] = struct{}{}
	b.mu.Unlock()

	return sub, func() {
		b.mu.Lock()
		if set, ok := b.subs[projectID]; ok {
			if _, present := set[sub]; present {
				delete(set, sub)
				close(sub.ch)
				if len(set) == 0 {
					delete(b.subs, projectID)
				}
			}
		}
		b.mu.Unlock()
	}
}

// Publish broadcasts an event to the project's room. With a transport it goes
// through Redis and every replica (including this one) delivers via its bridge.
func (b *Bus) Publish(projectID string, ev CanvasEvent) {
	if projectID == "" || ev.UID == "" {
		return
	}
	if b.transport != nil {
		payload, err := json.Marshal(envelope{ProjectID: projectID, Event: ev})
		if err != nil {
			return
		}
		if perr := b.transport.Publish(context.Background(), canvasChannel, payload); perr != nil {
			log.Printf("[canvassync] transport publish failed, delivering locally: %v", perr)
			b.handle(projectID, ev)
		}
		return
	}
	b.handle(projectID, ev)
}

// StartBridge consumes canvas events from other replicas. No-op without a
// transport. Run in a goroutine.
func (b *Bus) StartBridge(ctx context.Context) {
	if b.transport == nil {
		return
	}
	stream, err := b.transport.Subscribe(ctx, canvasChannel)
	if err != nil {
		log.Printf("[canvassync] failed to subscribe transport: %v", err)
		return
	}
	log.Printf("[canvassync] cross-process canvas bridge started")
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

// handle fans the event out to local subscribers (best-effort, non-blocking).
func (b *Bus) handle(projectID string, ev CanvasEvent) {
	b.mu.RLock()
	receivers := make([]*Subscriber, 0, len(b.subs[projectID]))
	for sub := range b.subs[projectID] {
		receivers = append(receivers, sub)
	}
	b.mu.RUnlock()

	for _, sub := range receivers {
		select {
		case sub.ch <- ev:
		default:
			// Slow consumer: drop this frame rather than block. Canvas ops are
			// order-sensitive, so a drop can cause divergence until the next
			// full-snapshot save/load resyncs — an accepted best-effort tradeoff.
		}
	}
}

package application

import (
	"context"
	"encoding/json"
	"log"
	"sync"
)

// TaskEvent is the per-task completion notification pushed to subscribed
// SSE clients. Mirrors the read-projection served by GET /api/app/tasks
// so the frontend can apply it the same way.
type TaskEvent struct {
	TaskID      string `json:"task_id"`
	NodeID      string `json:"node_id"`
	ServiceType string `json:"service_type"`
	Status      string `json:"status"`     // "success" or "error"
	ResultURL   string `json:"result_url"` // empty on error
	ErrorMsg    string `json:"error_msg"`  // empty on success
	DurationMs  int    `json:"duration_ms"`
}

// TaskEventBus is an in-process pub/sub for task completion events,
// fanned out per-user. Survives across HTTP requests so the SSE handler
// can subscribe a long-lived client and the service goroutines can
// publish from anywhere.
//
// Constraints / trade-offs:
//   - Per-subscriber buffer of 16. If a slow consumer fills up, the
//     publisher drops the oldest queued event for that subscriber
//     rather than blocking other consumers. The dropped event is still
//     persisted in generation_logs, so the recovery poller (Stage 2)
//     remains the final safety net.
//   - Cross-process fan-out is handled by an optional EventTransport
//     (Redis Pub/Sub) — see below. Without one, delivery is in-process
//     only and multi-replica deployments must rely on the recovery poller.
//
// EventTransport is an optional cross-process fan-out for task events
// (F7). The in-process bus only reaches SSE subscribers attached to the
// same backend process; with multiple replicas the worker that finishes a
// task may live in a different process than the one holding the user's SSE
// connection. A transport (Redis Pub/Sub in production) bridges the gap:
// Publish writes to a shared channel and every replica's Subscribe loop
// delivers to its own local subscribers. Kept as an interface so this
// package stays free of any Redis dependency — main wires the concrete
// implementation.
type EventTransport interface {
	// Publish broadcasts payload to all replicas subscribed to channel.
	Publish(ctx context.Context, channel string, payload []byte) error
	// Subscribe returns a stream of payloads published to channel. The
	// returned channel is closed when ctx is done.
	Subscribe(ctx context.Context, channel string) (<-chan []byte, error)
}

// busEnvelope is the wire format carried over the transport: it pairs the
// target user with the event so each replica can route to the right local
// subscribers.
type busEnvelope struct {
	UserID string    `json:"user_id"`
	Event  TaskEvent `json:"event"`
}

const taskEventChannel = "ccy:task-events"

type TaskEventBus struct {
	mu   sync.RWMutex
	subs map[string]map[*Subscriber]struct{} // userID → set of subscribers

	// transport is nil for single-process deployments (direct local
	// delivery). When set, Publish routes through it and a StartBridge
	// goroutine feeds remote events back into local delivery.
	transport EventTransport
}

type Subscriber struct {
	ch chan TaskEvent
}

// Events returns the receive-only channel for this subscriber. Closed
// when Unsubscribe runs.
func (s *Subscriber) Events() <-chan TaskEvent { return s.ch }

func NewTaskEventBus() *TaskEventBus {
	return &TaskEventBus{
		subs: make(map[string]map[*Subscriber]struct{}),
	}
}

// Subscribe registers a new subscriber for the given user and returns
// it along with an unsubscribe function. Calling unsubscribe is safe
// to do exactly once.
func (b *TaskEventBus) Subscribe(userID string) (*Subscriber, func()) {
	sub := &Subscriber{ch: make(chan TaskEvent, 16)}
	b.mu.Lock()
	set, ok := b.subs[userID]
	if !ok {
		set = make(map[*Subscriber]struct{})
		b.subs[userID] = set
	}
	set[sub] = struct{}{}
	b.mu.Unlock()

	unsubscribe := func() {
		b.mu.Lock()
		if set, ok := b.subs[userID]; ok {
			if _, present := set[sub]; present {
				delete(set, sub)
				close(sub.ch)
				if len(set) == 0 {
					delete(b.subs, userID)
				}
			}
		}
		b.mu.Unlock()
	}
	return sub, unsubscribe
}

// WithTransport attaches a cross-process transport (F7). Returns the bus
// for chaining. Call StartBridge afterwards to begin consuming remote
// events. Safe to skip entirely for single-process deployments.
func (b *TaskEventBus) WithTransport(t EventTransport) *TaskEventBus {
	b.transport = t
	return b
}

// StartBridge consumes task events published by other replicas and feeds
// them into local delivery. Blocks until ctx is done; run it in a
// goroutine. A no-op (returns immediately) when no transport is wired.
func (b *TaskEventBus) StartBridge(ctx context.Context) {
	if b.transport == nil {
		return
	}
	stream, err := b.transport.Subscribe(ctx, taskEventChannel)
	if err != nil {
		log.Printf("[events] failed to subscribe task-event transport: %v", err)
		return
	}
	log.Printf("[events] cross-process task-event bridge started")
	for {
		select {
		case <-ctx.Done():
			return
		case payload, ok := <-stream:
			if !ok {
				return
			}
			var env busEnvelope
			if err := json.Unmarshal(payload, &env); err != nil {
				continue
			}
			b.deliverLocal(env.UserID, env.Event)
		}
	}
}

// Publish delivers the event to subscribers of the given user. With a
// transport wired (multi-replica), it broadcasts over the transport and
// every replica — including this one — delivers via its StartBridge loop,
// so there's exactly one delivery path and no local/remote double-send.
// Without a transport it delivers directly in-process.
func (b *TaskEventBus) Publish(userID string, event TaskEvent) {
	if userID == "" {
		return
	}
	if b.transport != nil {
		payload, err := json.Marshal(busEnvelope{UserID: userID, Event: event})
		if err != nil {
			return
		}
		if perr := b.transport.Publish(context.Background(), taskEventChannel, payload); perr != nil {
			// Transport hiccup: fall back to local delivery so a
			// same-process subscriber still gets it (the recovery poller
			// covers cross-process gaps).
			log.Printf("[events] transport publish failed, delivering locally: %v", perr)
			b.deliverLocal(userID, event)
		}
		return
	}
	b.deliverLocal(userID, event)
}

// deliverLocal fans an event out to the in-process subscribers of a user.
// Non-blocking: if a subscriber's buffer is full we drop the oldest queued
// event and enqueue this one (newest-wins). A no-op when the user has no
// live subscribers in this process.
func (b *TaskEventBus) deliverLocal(userID string, event TaskEvent) {
	if userID == "" {
		return
	}
	b.mu.RLock()
	set := b.subs[userID]
	receivers := make([]*Subscriber, 0, len(set))
	for sub := range set {
		receivers = append(receivers, sub)
	}
	b.mu.RUnlock()

	for _, sub := range receivers {
		select {
		case sub.ch <- event:
			// fast path: there's room
		default:
			// Buffer full. Drain one to make room, then enqueue.
			// Reads from a full chan are non-blocking; if another
			// goroutine drained it first, we just push and move on.
			select {
			case <-sub.ch:
			default:
			}
			select {
			case sub.ch <- event:
			default:
				// Still couldn't push — extremely slow consumer.
				// Skip rather than block other subscribers.
			}
		}
	}
}

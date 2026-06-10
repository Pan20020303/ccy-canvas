package application

import (
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
//   - In-process only. Multi-instance deployments need an external bus
//     (Redis pub/sub, NATS) to fan events across pods. Out of scope for
//     the MVP — see plan's "Open Considerations".
//   - Per-subscriber buffer of 16. If a slow consumer fills up, the
//     publisher drops the oldest queued event for that subscriber
//     rather than blocking other consumers. The dropped event is still
//     persisted in generation_logs, so the recovery poller (Stage 2)
//     remains the final safety net.
type TaskEventBus struct {
	mu   sync.RWMutex
	subs map[string]map[*Subscriber]struct{} // userID → set of subscribers
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

// Publish delivers the event to every active subscriber of the given
// user. Non-blocking: if a subscriber's buffer is full we drop the
// oldest queued event and enqueue this one (newest-wins). A no-op when
// the user has no live subscribers (most common case — SSE only opens
// after the user logs into the app).
func (b *TaskEventBus) Publish(userID string, event TaskEvent) {
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

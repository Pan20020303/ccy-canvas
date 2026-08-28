package application

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
)

// SSE event types emitted by the agent runner.
const (
	EventThought      = "thought"       // model reasoning preview
	EventThoughtDelta = "thought_delta" // streaming reasoning token chunk
	EventToolCall   = "tool_call"    // model decided to invoke a tool
	EventToolResult = "tool_result"  // tool execution finished
	EventMessage    = "message"      // assistant final text reply
	EventCanvasPatch = "canvas_patch" // mutation the frontend should apply
	EventError      = "error"        // fatal error, run stops
	EventDone       = "done"         // run finished normally
	EventUsage      = "usage"        // token usage (context-window meter)
)

// Emitter wraps an http.ResponseWriter and provides thread-safe writes of
// Server-Sent Event frames. The handler must have already set
//   Content-Type: text/event-stream
//   Cache-Control: no-store
// and verified that the writer is an http.Flusher.
type Emitter struct {
	mu      sync.Mutex
	w       http.ResponseWriter
	flusher http.Flusher
	closed  bool
}

func NewEmitter(w http.ResponseWriter) (*Emitter, error) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		return nil, fmt.Errorf("response writer does not support flushing")
	}
	return &Emitter{w: w, flusher: flusher}, nil
}

// Emit writes a single SSE frame. The `data` arg must be a JSON-marshallable
// value; if marshaling fails the event is dropped with no error returned to
// the caller (we don't want to fail an entire run for one bad event).
func (e *Emitter) Emit(event string, data any) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return
	}
	body, err := json.Marshal(data)
	if err != nil {
		return
	}
	// Two-line frame: `event: NAME\ndata: JSON\n\n`
	fmt.Fprintf(e.w, "event: %s\ndata: %s\n\n", event, body)
	e.flusher.Flush()
}

// EmitError is a convenience for the runner.
func (e *Emitter) EmitError(msg string) {
	e.Emit(EventError, map[string]string{"message": msg})
}

func (e *Emitter) Close() {
	e.mu.Lock()
	e.closed = true
	e.mu.Unlock()
}

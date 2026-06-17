package tasks

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/hibiken/asynq"
	"github.com/jackc/pgx/v5/pgtype"

	modelapp "ccy-canvas/backend/internal/modelcatalog/application"
	"ccy-canvas/backend/internal/platform/database/sqlc"
	"ccy-canvas/backend/internal/shared/apperror"
)

// Worker is the consumer side of the Asynq task queue. It owns an
// *asynq.Server (the Redis-polling supervisor + concurrency-bounded
// worker pool) and dispatches each generation task to the model catalog
// Service.
//
// Concurrency: per-queue weights are tuned so video tasks (long, costly)
// don't starve image/text. Total concurrency is the sum of the weights.
//
// Lifecycle: NewWorker creates the server in stopped state; Start() runs
// it in a goroutine; Shutdown() drains gracefully (waits for in-flight
// tasks up to ShutdownTimeout before killing).
type Worker struct {
	server  *asynq.Server
	svc     *modelapp.Service
	queries *sqlc.Queries
}

// NewWorker builds the Asynq server with sane concurrency/priority
// defaults. Returns nil when redisAddr is empty (feature flag off).
func NewWorker(redisAddr, redisPassword string, redisDB int, svc *modelapp.Service, queries *sqlc.Queries) *Worker {
	if redisAddr == "" {
		return nil
	}
	server := asynq.NewServer(
		asynq.RedisClientOpt{
			Addr:     redisAddr,
			Password: redisPassword,
			DB:       redisDB,
		},
		asynq.Config{
			// Total worker pool size. Single-replica backend default.
			// Adjust via env later if you spread workers across machines.
			Concurrency: 20,
			Queues: map[string]int{
				// Higher weight = more share of the 20 slots.
				// Video is intentionally low so a 30 min Sora call
				// can't steal all the workers from fast image/text.
				"text":    6,
				"image":   6,
				"video":   4,
				"audio":   2,
				"default": 2,
			},
			// Asynq's default retry delay is fine (1s, 2s, 4s, 8s, ...).
			ErrorHandler: asynq.ErrorHandlerFunc(func(ctx context.Context, t *asynq.Task, err error) {
				log.Printf("[tasks] task %s failed (will retry per Asynq policy): %v", t.Type(), err)
			}),
		},
	)
	return &Worker{
		server:  server,
		svc:     svc,
		queries: queries,
	}
}

// Enabled reports whether the worker is configured.
func (w *Worker) Enabled() bool {
	return w != nil && w.server != nil
}

// Start runs the Asynq server in the calling goroutine. Block until
// Shutdown is called (or fatal error). Callers typically do go w.Start().
func (w *Worker) Start() error {
	if !w.Enabled() {
		return nil
	}
	mux := asynq.NewServeMux()
	mux.HandleFunc(TaskTypeGeneration, w.handleGeneration)
	return w.server.Run(mux)
}

// Shutdown drains the worker pool gracefully. In-flight tasks get up to
// the Asynq default ShutdownTimeout (8s) to finish before forced abort.
func (w *Worker) Shutdown() {
	if !w.Enabled() {
		return
	}
	w.server.Shutdown()
}

// handleGeneration is the Asynq callback for a single TaskTypeGeneration
// task. Steps:
//
//  1. Decode the small payload to find LogID.
//  2. Reload the full GenerateRequest from generation_logs.request_payload
//     — the JSONB blob persisted at enqueue time.
//  3. Flip the row to 'running' so frontend polling/SSE knows.
//  4. Call Service.GenerateInline with the worker's ctx. Generate handles
//     its own outcome write (status / result_url / error_msg).
//  5. Return either nil (Asynq marks done), an error (Asynq retries
//     per backoff policy), or asynq.SkipRetry (permanent failure).
func (w *Worker) handleGeneration(ctx context.Context, t *asynq.Task) error {
	var p GenerationPayload
	if err := json.Unmarshal(t.Payload(), &p); err != nil {
		// Malformed payload — no point retrying.
		return fmt.Errorf("decode payload: %w: %w", err, asynq.SkipRetry)
	}

	logUUID, err := parseUUID(p.LogID)
	if err != nil {
		return fmt.Errorf("invalid log id %q: %w: %w", p.LogID, err, asynq.SkipRetry)
	}

	// Load the request payload we persisted at enqueue time.
	row, err := w.queries.LoadGenerationLogPayload(ctx, logUUID)
	if err != nil {
		// DB hiccup — let Asynq retry.
		return fmt.Errorf("load payload: %w", err)
	}

	// Skip if the user already cancelled while we were waiting in the
	// queue. status='cancelled' means a /tasks/{id}/cancel call won the
	// race; we should not call the upstream provider.
	if strings.EqualFold(row.Status, "cancelled") {
		return nil
	}

	// Re-hydrate GenerateRequest from JSONB.
	var req modelapp.GenerateRequest
	if len(row.RequestPayload) == 0 {
		return fmt.Errorf("log %s missing request_payload: %w", p.LogID, asynq.SkipRetry)
	}
	if err := json.Unmarshal(row.RequestPayload, &req); err != nil {
		return fmt.Errorf("decode request_payload: %w: %w", err, asynq.SkipRetry)
	}
	// Ensure the worker knows which log row to update.
	req.GenerationLogID = p.LogID
	req.UserID = p.UserID
	req.NodeID = p.NodeID

	// Flip queued → running so frontend sees movement before the call
	// returns. Errors here are non-fatal; the final outcome write in
	// GenerateInline still happens.
	if err := w.queries.MarkGenerationLogRunning(ctx, logUUID); err != nil {
		log.Printf("[tasks] mark running failed for %s: %v", p.LogID, err)
	}

	// Hand off to the model catalog. GenerateInline runs the upstream call
	// synchronously using this ctx. On *success* it persists the result and
	// publishes the SSE event itself; on *failure* it persists nothing and
	// returns the error, leaving the terminal-vs-retry decision to us.
	startedAt := time.Now()
	_, runErr := w.svc.GenerateInline(ctx, req)
	if runErr == nil {
		return nil
	}
	duration := time.Since(startedAt)

	// Classify error: 4xx-ish "user fixed input wrong" errors are
	// permanent — no point burning retries on them. Persist the terminal
	// error now and short-circuit retries.
	if isPermanentError(runErr) {
		log.Printf("[tasks] permanent failure for log %s: %v", p.LogID, runErr)
		w.svc.FinalizeFailure(req, runErr, duration)
		return fmt.Errorf("%w: %w", runErr, asynq.SkipRetry)
	}

	// Timeout on a non-idempotent media generation (image/video/audio): the
	// upstream task may still be running (Manju async tasks finish in
	// minutes) or already done. Retrying would submit a brand-new gateway
	// task — duplicate generation + double charge — while never recovering
	// the original. Covers both a request-level deadline and an exhausted
	// async-poll window. Treat as terminal — do NOT retry.
	if isMediaGeneration(p.ServiceType) && isGenerationTimeout(runErr) {
		log.Printf("[tasks] media generation timed out for log %s (no retry, upstream task may still be running): %v", p.LogID, runErr)
		w.svc.FinalizeFailure(req, errTimeoutNoRetry(runErr), duration)
		return fmt.Errorf("%w: %w", runErr, asynq.SkipRetry)
	}

	// Transient failure (network, 5xx upstream, lease loss). If retries are
	// exhausted, persist the terminal error now — no later attempt will.
	// Otherwise leave the row 'running' and return the error so Asynq
	// retries after backoff; the node keeps spinning instead of flashing
	// to 'error' and back.
	retried, _ := asynq.GetRetryCount(ctx)
	maxRetry, _ := asynq.GetMaxRetry(ctx)
	if maxRetry > 0 && retried >= maxRetry {
		log.Printf("[tasks] transient failure exhausted retries for log %s: %v", p.LogID, runErr)
		w.svc.FinalizeFailure(req, runErr, duration)
		return runErr
	}
	log.Printf("[tasks] transient failure for log %s (attempt %d/%d), will retry: %v", p.LogID, retried+1, maxRetry, runErr)
	return runErr
}

// isMediaGeneration reports whether the service type produces a paid,
// non-idempotent media asset where a duplicate upstream call (from a retry)
// would re-generate and re-charge. Text is excluded — it's cheap and
// effectively idempotent, so retrying a timed-out text call is acceptable.
func isMediaGeneration(serviceType string) bool {
	switch serviceType {
	case "image", "video", "audio":
		return true
	default:
		return false
	}
}

// isGenerationTimeout reports whether err is any kind of generation timeout
// that means "the upstream task may still be running" — a request-level
// deadline, or an exhausted async-poll window. For media generation these
// must not be retried (a retry submits a new gateway task = duplicate).
func isGenerationTimeout(err error) bool {
	if modelapp.IsRequestDeadlineTimeout(err) {
		return true
	}
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "timed out after polling") ||
		strings.Contains(msg, "image generation timed out") ||
		strings.Contains(msg, "generation timed out")
}

// errTimeoutNoRetry wraps a timeout error with a user-facing message that
// explains why it wasn't retried (so the node's error text is actionable).
func errTimeoutNoRetry(err error) error {
	return fmt.Errorf("生成超时：上游可能已生成但未在超时窗口内返回；为避免重复扣费未自动重试，请稍后重试 (%w)", err)
}

// isPermanentError returns true for failures that retries won't fix.
// 429 is intentionally NOT permanent: in single-channel mode a later retry
// should hit the same channel instead of locking or switching it.
func isPermanentError(err error) bool {
	if err == nil {
		return false
	}
	var ae *apperror.Error
	if errors.As(err, &ae) {
		if ae.Code == apperror.CodeInvalidInput {
			return true
		}
	}
	msg := strings.ToLower(err.Error())
	switch {
	case strings.Contains(msg, "http 400"):
		return true
	case strings.Contains(msg, "http 401"):
		return true
	case strings.Contains(msg, "http 403"):
		return true
	case strings.Contains(msg, "http 404"):
		return true
	case strings.Contains(msg, "http 422"):
		return true
	case strings.Contains(msg, "unauthorized"):
		return true
	case strings.Contains(msg, "forbidden"):
		return true
	}
	return false
}

// parseUUID converts a hex string UUID to pgtype.UUID. Mirrors what
// the modelcatalog repository does internally.
func parseUUID(s string) (pgtype.UUID, error) {
	var u pgtype.UUID
	if err := u.Scan(s); err != nil {
		return u, err
	}
	return u, nil
}

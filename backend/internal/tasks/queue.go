// Package tasks owns the durable background-job layer for ccy-canvas.
//
// Why this exists:
//   - Generation tasks can take minutes (image) to half an hour (video).
//   - The old design ran them in a detached goroutine inside the request
//     handler. If the backend process crashed mid-flight, the in-flight
//     task was lost — exactly the "成功了拿不回来" pain point users hit.
//   - This package wraps Asynq (Redis-backed Go task queue) so tasks
//     survive backend restarts, retry on transient failure, and get a
//     dead-letter slot we can surface in the admin UI.
//
// Two halves:
//   - Queue (this file): producer-side helper used by HTTP handlers to
//     enqueue. Stateless wrapper around asynq.Client.
//   - Worker (worker.go): consumer-side server that decodes payloads and
//     calls back into the model catalog service.
//
// Feature flag: Queue is constructed only when REDIS_ADDR is configured.
// Handlers check Queue.Enabled() and fall back to the legacy inline
// detached-goroutine path when it's nil — keeps rollout risk-free.
package tasks

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/hibiken/asynq"
)

// TaskType for the generation pipeline. Asynq routes incoming tasks to
// handlers keyed by this string, so changing it is a breaking change
// for any in-flight queued task already in Redis.
const (
	TaskTypeGeneration   = "generation:run"
	TaskTypeAssetPersist = "asset:persist"
)

// GenerationPayload is the JSON blob enqueued with each task. Worker
// uses LogID to reload the full request from generation_logs; we keep a
// small subset inline for routing decisions (priority queue by service
// type) and for asynqmon UI display.
type GenerationPayload struct {
	LogID       string `json:"log_id"`     // generation_logs.id (UUID)
	RequestID   string `json:"request_id"` // client-side UUID for idempotency
	UserID      string `json:"user_id"`
	ServiceType string `json:"service_type"` // image / video / text / audio
	Model       string `json:"model"`
	NodeID      string `json:"node_id"`
	EnqueuedAt  int64  `json:"enqueued_at"` // unix sec, for queue-time metric
}

type AssetPersistPayload struct {
	LogID       string `json:"log_id"`
	UserID      string `json:"user_id"`
	NodeID      string `json:"node_id"`
	ServiceType string `json:"service_type"`
	StagingPath string `json:"staging_path"`
	StagingURL  string `json:"staging_url"`
	COSKey      string `json:"cos_key"`
	ContentType string `json:"content_type"`
	EnqueuedAt  int64  `json:"enqueued_at"`
}

// Queue is the producer-side helper. Wraps an *asynq.Client and exposes
// a minimal Enqueue API the HTTP handler can call.
type Queue struct {
	client *asynq.Client
}

// NewQueue builds a Queue from a Redis address. Caller is responsible
// for non-empty addr; pass nil result if the queue isn't configured
// rather than constructing an empty Queue.
func NewQueue(redisAddr, redisPassword string, redisDB int) *Queue {
	if redisAddr == "" {
		return nil
	}
	client := asynq.NewClient(asynq.RedisClientOpt{
		Addr:     redisAddr,
		Password: redisPassword,
		DB:       redisDB,
	})
	return &Queue{client: client}
}

// Enabled reports whether the queue is wired up. Handlers use this to
// decide between the durable Asynq path and the legacy inline path.
func (q *Queue) Enabled() bool {
	return q != nil && q.client != nil
}

// Close releases the Redis connection. Should be called on shutdown.
func (q *Queue) Close() error {
	if q == nil || q.client == nil {
		return nil
	}
	return q.client.Close()
}

// queueNameForServiceType maps service type to Asynq queue name. Asynq
// configures per-queue priority weights in the server (worker.go), so
// e.g. video tasks can be capped to a smaller worker pool to keep them
// from starving cheaper image/text tasks.
func queueNameForServiceType(serviceType string) string {
	switch serviceType {
	case "video":
		return "video"
	case "image":
		return "image"
	case "audio":
		return "audio"
	default:
		return "text"
	}
}

// timeoutForServiceType matches the existing maxRuntimeForType budgets
// in modelcatalog/application/service.go. Asynq enforces this as a hard
// upper bound on a single attempt; transient failures still get
// retry-loop time on top via Asynq's built-in backoff.
func timeoutForServiceType(serviceType string) time.Duration {
	switch serviceType {
	case "image":
		return 15 * time.Minute
	case "video":
		return 30 * time.Minute
	case "audio":
		return 10 * time.Minute
	default:
		return 5 * time.Minute
	}
}

// Enqueue submits a generation task. The asynq task id is set to the
// caller-supplied RequestID — Asynq treats duplicate task ids as an
// idempotency hint and will not re-enqueue (returns ErrDuplicateTask /
// ErrTaskIDConflict). The handler can decide whether to surface that
// as "already submitted, here's the existing task_id" or as an error.
func (q *Queue) Enqueue(ctx context.Context, p GenerationPayload) (string, error) {
	if !q.Enabled() {
		return "", fmt.Errorf("tasks queue not configured (REDIS_ADDR empty)")
	}
	p.EnqueuedAt = time.Now().Unix()
	body, err := json.Marshal(p)
	if err != nil {
		return "", fmt.Errorf("marshal task payload: %w", err)
	}
	task := asynq.NewTask(TaskTypeGeneration, body,
		asynq.Queue(queueNameForServiceType(p.ServiceType)),
		// Retry transient failures (network blip, upstream 5xx, lease loss
		// after an OOM/kill). The worker only persists a terminal 'error'
		// + SSE event once the failure is permanent OR retries are
		// exhausted (see worker.handleGeneration), so a retried transient
		// failure never flashes the node to 'error' and never double-bills
		// a *successful* generation. Permanent failures short-circuit via
		// asynq.SkipRetry, so they don't burn the retry budget.
		asynq.MaxRetry(5),
		asynq.Timeout(timeoutForServiceType(p.ServiceType)),
		asynq.Retention(24*time.Hour),
		// TaskID = RequestID: duplicate submits return ErrTaskIDConflict
		// which the handler treats as "this is already in flight".
		asynq.TaskID(p.RequestID),
	)
	info, err := q.client.EnqueueContext(ctx, task)
	if err != nil {
		// Idempotency (F6): a duplicate request_id means this exact submit
		// is already queued / in flight. Treat it as success and return the
		// existing task id (which equals RequestID, since TaskID=RequestID)
		// rather than surfacing a 5xx for a harmless retry / double-click.
		if errors.Is(err, asynq.ErrTaskIDConflict) || errors.Is(err, asynq.ErrDuplicateTask) {
			return p.RequestID, nil
		}
		return "", err
	}
	return info.ID, nil
}

func (q *Queue) EnqueueAssetPersist(ctx context.Context, p AssetPersistPayload) (string, error) {
	if !q.Enabled() {
		return "", fmt.Errorf("tasks queue not configured (REDIS_ADDR empty)")
	}
	p.EnqueuedAt = time.Now().Unix()
	body, err := json.Marshal(p)
	if err != nil {
		return "", fmt.Errorf("marshal asset persist payload: %w", err)
	}
	task := asynq.NewTask(TaskTypeAssetPersist, body,
		asynq.Queue("asset"),
		asynq.MaxRetry(12),
		asynq.Timeout(10*time.Minute),
		asynq.Retention(24*time.Hour),
		asynq.TaskID("asset:"+p.LogID),
	)
	info, err := q.client.EnqueueContext(ctx, task)
	if err != nil {
		if errors.Is(err, asynq.ErrTaskIDConflict) || errors.Is(err, asynq.ErrDuplicateTask) {
			return "asset:" + p.LogID, nil
		}
		return "", err
	}
	return info.ID, nil
}

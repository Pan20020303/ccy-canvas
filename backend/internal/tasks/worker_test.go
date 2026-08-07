package tasks

import (
	"context"
	"errors"
	"testing"
	"time"

	modelapp "ccy-canvas/backend/internal/modelcatalog/application"
	"github.com/hibiken/asynq"
)

type stubAgentRunProcessor struct{ err error }

func (p stubAgentRunProcessor) ProcessAgentRun(context.Context, string) error { return p.err }

func TestIsMediaGeneration(t *testing.T) {
	cases := map[string]bool{
		"image": true,
		"video": true,
		"audio": true,
		"text":  false,
		"":      false,
		"other": false,
	}
	for svc, want := range cases {
		if got := isMediaGeneration(svc); got != want {
			t.Errorf("isMediaGeneration(%q) = %v, want %v", svc, got, want)
		}
	}
}

// Guards the core fix: a request-deadline timeout on a media generation must
// be classified as terminal (not retried), while text stays retryable. This
// mirrors the decision handleGeneration makes.
func TestMediaTimeoutIsTerminal(t *testing.T) {
	timeout := errors.New("Post \"x\": context deadline exceeded (Client.Timeout exceeded while awaiting headers)")

	if !(isMediaGeneration("image") && modelapp.IsRequestDeadlineTimeout(timeout)) {
		t.Fatal("image + request-deadline timeout must be terminal (no retry)")
	}
	// Text timeouts remain retryable (cheap, ~idempotent).
	if isMediaGeneration("text") {
		t.Fatal("text must not be treated as media generation")
	}
}

func TestIsGenerationTimeout(t *testing.T) {
	cases := map[string]bool{
		"Image generation timed out after polling": true,
		"generation timed out":                     true,
		`Post "x": context deadline exceeded (Client.Timeout exceeded while awaiting headers)`: true,
		// pollImageTask 的「最后一轮带响应体」出口 —— 曾用 "Timed out. Last
		// response: ..." 文案漏过本判定,被当 transient 重试 → 向网关重复提交
		// 付费任务(Manju 图生图重复扣费的根因)。锁住修正后的哨兵文案。
		`Image generation timed out after polling. Last response: {"status":"running","progress":0}`: true,
		"Provider returned empty image content":                                                      false,
		"Provider HTTP 502: server overloaded":                                                       false,
		"":                                                                                           false,
	}
	for msg, want := range cases {
		var err error
		if msg != "" {
			err = errors.New(msg)
		}
		if got := isGenerationTimeout(err); got != want {
			t.Errorf("isGenerationTimeout(%q) = %v, want %v", msg, got, want)
		}
	}
}

func TestAssetPersistenceFailureIsPermanent(t *testing.T) {
	err := errors.New("asset persistence failed: generated media could not be saved to configured storage")
	if !isPermanentError(err) {
		t.Fatal("asset persistence failures must not retry the whole generation")
	}
}

func TestProviderInputValidationFailuresArePermanent(t *testing.T) {
	cases := []string{
		"Video generation failed: DataInspectionFailed: Green net check failed for text (input): Input data may contain inappropriate content.",
		"Video generation failed: InvalidParameter: Input should be 'reference_image': input.media.0.type",
	}
	for _, msg := range cases {
		if !isPermanentError(errors.New(msg)) {
			t.Fatalf("isPermanentError(%q) = false, want true", msg)
		}
	}
}

func TestErrTimeoutNoRetryWrapsOriginal(t *testing.T) {
	orig := context.DeadlineExceeded
	wrapped := errTimeoutNoRetry(orig)
	if !errors.Is(wrapped, orig) {
		t.Fatal("errTimeoutNoRetry must wrap the original error")
	}
}

func TestRedeliveredGenerationSkipsTerminalStatuses(t *testing.T) {
	for _, status := range []string{
		"success", "succeeded", "completed", "error", "failed", "dead",
		"cancelled", "canceled", "persisting", " SUCCESS ",
	} {
		if !shouldSkipRedeliveredGeneration(status) {
			t.Errorf("status %q should skip provider execution on redelivery", status)
		}
	}
	for _, status := range []string{"queued", "pending", "running", "retrying", ""} {
		if shouldSkipRedeliveredGeneration(status) {
			t.Errorf("status %q should remain executable", status)
		}
	}
}

func TestAbsoluteTextTaskDeadlineUsesOriginalEnqueueTime(t *testing.T) {
	t.Setenv("TEXT_TASK_MAX_RUNTIME_SECONDS", "900")
	enqueuedAt := time.Now().Add(-4 * time.Minute).Unix()
	deadline, ok := absoluteTextTaskDeadline(GenerationPayload{
		ServiceType: "text",
		EnqueuedAt:  enqueuedAt,
	})
	if !ok {
		t.Fatal("text task should have an absolute deadline")
	}
	want := time.Unix(enqueuedAt, 0).Add(15 * time.Minute)
	if !deadline.Equal(want) {
		t.Fatalf("deadline = %s, want %s", deadline, want)
	}

	if _, ok := absoluteTextTaskDeadline(GenerationPayload{
		ServiceType: "image",
		EnqueuedAt:  enqueuedAt,
	}); ok {
		t.Fatal("non-text task must not use the text absolute deadline")
	}
	if _, ok := absoluteTextTaskDeadline(GenerationPayload{ServiceType: "text"}); ok {
		t.Fatal("legacy payload without enqueued_at must not invent a deadline")
	}
}

func TestAgentRunPersistenceFailureKeepsRetryBudget(t *testing.T) {
	w := &Worker{agentProcessor: stubAgentRunProcessor{err: errors.New("persist terminal result")}}
	task := asynq.NewTask(TaskTypeAgentRun, []byte(`{"run_id":"run-1"}`))

	err := w.handleAgentRun(context.Background(), task)
	if err == nil {
		t.Fatal("processor failure must be returned to Asynq")
	}
	if errors.Is(err, asynq.SkipRetry) {
		t.Fatal("incomplete durable agent run must remain retryable")
	}
}

func TestAgentRunFinalizedFailureCompletesQueueTask(t *testing.T) {
	w := &Worker{agentProcessor: stubAgentRunProcessor{}}
	task := asynq.NewTask(TaskTypeAgentRun, []byte(`{"run_id":"run-1"}`))

	if err := w.handleAgentRun(context.Background(), task); err != nil {
		t.Fatalf("finalized job should complete queue task: %v", err)
	}
}

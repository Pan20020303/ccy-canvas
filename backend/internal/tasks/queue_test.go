package tasks

import (
	"testing"
	"time"

	modelapp "ccy-canvas/backend/internal/modelcatalog/application"
)

func TestMidjourneyQueueBudgetMatchesPollingAndPersistence(t *testing.T) {
	t.Setenv("IMAGE_TASK_MAX_RUNTIME_SECONDS", "900")
	got := timeoutForGenerationPayload(GenerationPayload{ServiceType: "image", Model: "midjourney-v8-2"})
	if got != modelapp.MidjourneyTaskRuntimeBudget || got <= modelapp.MidjourneyTaskPollBudget {
		t.Fatalf("MJ worker timeout %s does not include polling and persistence", got)
	}
	if got := timeoutForGenerationPayload(GenerationPayload{ServiceType: "image", Model: "gpt-image-2"}); got != 15*time.Minute {
		t.Fatalf("ordinary image timeout changed to %s", got)
	}
}

func TestTextTaskTimeoutMatchesDurableBudget(t *testing.T) {
	t.Setenv("TEXT_TASK_MAX_RUNTIME_SECONDS", "")
	if got := timeoutForServiceType("text"); got != 15*time.Minute {
		t.Fatalf("timeoutForServiceType(text) = %s, want 15m", got)
	}
	t.Setenv("TEXT_TASK_MAX_RUNTIME_SECONDS", "91")
	if got := timeoutForServiceType("text"); got != 91*time.Second {
		t.Fatalf("text timeout override = %s, want 91s", got)
	}
}

func TestTextTaskUsesBoundedQueueRetries(t *testing.T) {
	if got := maxRetryForServiceType("text"); got != 2 {
		t.Fatalf("maxRetryForServiceType(text) = %d, want 2", got)
	}
	for _, serviceType := range []string{"image", "video", "audio"} {
		if got := maxRetryForServiceType(serviceType); got != 5 {
			t.Fatalf("maxRetryForServiceType(%s) = %d, want 5", serviceType, got)
		}
	}
}

func TestMiniMaxDirectorGetsLongVideoBudget(t *testing.T) {
	t.Setenv("VIDEO_TASK_MAX_QUEUE_SECONDS", "43200")
	p := GenerationPayload{ServiceType: "video", Model: "minimax-h3-director-local"}
	if got := timeoutForGenerationPayload(p); got != 15*time.Hour {
		t.Fatalf("director hard timeout = %s, want 15h (12h queue + 3h execution)", got)
	}
}

func TestComfyVideoQueueDoesNotConsumeExecutionBudget(t *testing.T) {
	t.Setenv("VIDEO_TASK_MAX_RUNTIME_SECONDS", "1800")
	t.Setenv("VIDEO_TASK_MAX_QUEUE_SECONDS", "7200")
	p := GenerationPayload{ServiceType: "video", Model: "minimax-h3-t2v-ref2v-turbo-local"}
	if got := timeoutForGenerationPayload(p); got != 150*time.Minute {
		t.Fatalf("Comfy video hard timeout = %s, want 2h queue + 30m execution", got)
	}
	cloud := GenerationPayload{ServiceType: "video", Model: "dreamina-seedance-2-5"}
	if got := timeoutForGenerationPayload(cloud); got != 30*time.Minute {
		t.Fatalf("cloud video timeout = %s, want execution-only 30m", got)
	}
}

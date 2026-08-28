package application

import (
	"testing"
	"time"
)

func TestImageQueueWaitDoesNotConsumeInferenceBudget(t *testing.T) {
	t.Setenv("IMAGE_TASK_MAX_RUNTIME_SECONDS", "900")
	for _, status := range []string{"pending", "queued", "retrying"} {
		if staleGenerationBudgetForStatus("image", status) != 24*time.Hour {
			t.Fatal("waiting images need their own queue budget")
		}
	}
	if staleGenerationBudgetForStatus("image", "running") != time.Hour {
		t.Fatal("running-image reaper must remain bounded")
	}
	if staleGenerationBudgetForStatus("text", "queued") != staleGenerationBudget("text") {
		t.Fatal("text absolute budget must not change")
	}
}

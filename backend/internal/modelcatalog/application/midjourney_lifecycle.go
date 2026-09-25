package application

import (
	"strings"
	"time"
)

// HopBase may take two hours to publish a terminal Midjourney task state.
// Give that terminal update a small propagation margin, then reserve time to
// download and save all four paid images before the worker deadline.
const (
	MidjourneyTaskPollBudget    = 2*time.Hour + 2*time.Minute
	MidjourneyTaskRuntimeBudget = MidjourneyTaskPollBudget + 10*time.Minute
)

func isMidjourneyFixedBatchRequest(req GenerateRequest) bool {
	return req.ServiceType == "image" && strings.EqualFold(strings.TrimSpace(req.Model), "midjourney-v8-2")
}

package application

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestSplitAgentInputUsesVolumeAndEntryBoundariesWithoutDuplicatingEntries(t *testing.T) {
	var document strings.Builder
	for volume := 1; volume <= 2; volume++ {
		fmt.Fprintf(&document, "# 分卷 %02d\n本卷统一要求：使用豆包 5.0。\n\n", volume)
		for entry := 1; entry <= 5; entry++ {
			fmt.Fprintf(&document, "## V%d-M%02d\n%s\n\n", volume, entry, strings.Repeat("人物提示词。", 18))
		}
	}

	segments := SplitAgentInput(document.String(), 220)
	if len(segments) < 4 {
		t.Fatalf("segments = %d, want semantic subdivision", len(segments))
	}
	for index, segment := range segments {
		if got := utf8.RuneCountInString(segment.Content); got > 220 {
			t.Fatalf("segment %d has %d runes, want <= 220", index, got)
		}
	}
	joined := "\n" + strings.Join(segmentContents(segments), "\n")
	for volume := 1; volume <= 2; volume++ {
		for entry := 1; entry <= 5; entry++ {
			marker := fmt.Sprintf("## V%d-M%02d\n", volume, entry)
			if got := strings.Count(joined, marker); got != 1 {
				t.Fatalf("marker %q occurs %d times, want exactly once", marker, got)
			}
		}
	}
}

func TestSplitAgentInputIgnoresHeadingsInsideCodeFence(t *testing.T) {
	document := "# 正文\n\n```markdown\n# 这不是分卷\n## 这不是条目\n```\n\n" + strings.Repeat("内容。", 80)
	segments := SplitAgentInput(document, 90)
	if len(segments) < 2 {
		t.Fatalf("segments = %d, want hard/paragraph split", len(segments))
	}
	for _, segment := range segments {
		if segment.Label == "这不是分卷" || segment.Label == "这不是条目" {
			t.Fatalf("code-fence heading was treated as semantic heading: %+v", segment)
		}
	}
}

func TestSanitizeConversationHistoryKeepsNewestWithinBudgetAndSkipsHugeTurn(t *testing.T) {
	history := []ChatMessage{
		{Role: "user", Content: "old"},
		{Role: "user", Content: strings.Repeat("巨", MaxAgentHistoryRunes+1)},
		{Role: "assistant", Content: strings.Repeat("新", MaxAgentHistoryRunes-10)},
		{Role: "user", Content: "follow-up"},
	}
	got := sanitizeConversationHistory(history)
	if len(got) != 2 {
		t.Fatalf("history len = %d, want 2", len(got))
	}
	if got[0].Role != "assistant" || got[1].Content != "follow-up" {
		t.Fatalf("unexpected retained history: %#v", got)
	}
}

func TestRunAdaptiveCallsLLMPerSegmentButEmitsOneFinalMessage(t *testing.T) {
	requestCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"choices":[{"message":{"content":"第%d段完成"},"finish_reason":"stop"}]}`, requestCount)
	}))
	defer server.Close()

	runner := Runner{
		LLM:       NewLLMClient(),
		Endpoints: []Endpoint{{BaseURL: server.URL, APIKey: "test"}},
	}
	message := "# 超长任务\n\n" + strings.Repeat("条目内容。", DefaultAgentInputChunkRunes/5+10)
	messageEvents := 0
	doneEvents := 0
	stats, err := runner.RunAdaptive(context.Background(), RunInput{
		SystemPrompt: "test",
		Model:        "test-model",
		UserMessage:  message,
	}, func(event string, _ any) {
		switch event {
		case EventMessage:
			messageEvents++
		case EventDone:
			doneEvents++
		}
	})
	if err != nil {
		t.Fatalf("RunAdaptive error: %v", err)
	}
	if requestCount < 2 {
		t.Fatalf("request count = %d, want >= 2", requestCount)
	}
	if messageEvents != 1 || doneEvents != 1 {
		t.Fatalf("message events = %d, done events = %d; want 1 each", messageEvents, doneEvents)
	}
	if !strings.Contains(stats.FinalReply, fmt.Sprintf("%d/%d 段", requestCount, requestCount)) {
		t.Fatalf("final reply = %q", stats.FinalReply)
	}
}

func segmentContents(segments []AgentInputSegment) []string {
	contents := make([]string, 0, len(segments))
	for _, segment := range segments {
		contents = append(contents, segment.Content)
	}
	return contents
}

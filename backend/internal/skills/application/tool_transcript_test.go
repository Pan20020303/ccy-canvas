package application

import (
	"strings"
	"testing"
)

func TestFormatToolTranscript(t *testing.T) {
	if got := FormatToolTranscript(nil); got != "" {
		t.Fatalf("empty: got %q", got)
	}
	got := FormatToolTranscript([]ToolTranscriptEntry{
		{Name: "list_nodes", Args: "{}", OK: true, Result: `[{"id":"n1"}]`},
		{Name: "run_node", Args: `{"node_id":"x"}`, OK: false, Result: `{"error":"boom"}`},
	})
	want := "✓ list_nodes({}) → [{\"id\":\"n1\"}]\n✕ run_node({\"node_id\":\"x\"}) → {\"error\":\"boom\"}"
	if got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestBuildToolHistoryPrompt(t *testing.T) {
	if got := BuildToolHistoryPrompt(nil, 2); got != "" {
		t.Fatalf("empty logs: got %q", got)
	}
	// 只取最近 maxLogs 条(时间升序,取尾部)。
	got := BuildToolHistoryPrompt([]string{"轮1记录", "轮2记录", "轮3记录"}, 2)
	if strings.Contains(got, "轮1记录") {
		t.Fatalf("should drop oldest beyond maxLogs: %q", got)
	}
	if !strings.Contains(got, "轮2记录") || !strings.Contains(got, "轮3记录") {
		t.Fatalf("missing recent logs: %q", got)
	}
	if !strings.Contains(got, "【最近工具执行记录】") || !strings.Contains(got, "不要重复已完成的操作") {
		t.Fatalf("missing header/guidance: %q", got)
	}
}

func TestTruncateForTranscript(t *testing.T) {
	if got := truncateForTranscript("  short  ", 100); got != "short" {
		t.Fatalf("trim: %q", got)
	}
	long := strings.Repeat("记", 250)
	got := truncateForTranscript(long, 200)
	if r := []rune(got); len(r) != 201 || !strings.HasSuffix(got, "…") {
		t.Fatalf("truncate: %d runes, suffix ok=%v", len([]rune(got)), strings.HasSuffix(got, "…"))
	}
}

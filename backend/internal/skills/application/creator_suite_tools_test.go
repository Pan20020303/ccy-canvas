package application

import (
	"strings"
	"testing"
)

// save_memory 与 deep_retrieve 必须共用同一隔离域规则,否则「存了召不回」。
func TestMemoryIsolationKeyConsistency(t *testing.T) {
	cases := map[[2]string]string{
		{"", ""}:            "default",
		{"proj1", "ws2"}:    "proj1:ws2",
		{"proj1", ""}:       "proj1:",
		{" ", " "}:          "default", // 两端空白被 trim 后等价于空
	}
	for in, want := range cases {
		if got := memoryIsolationKey(in[0], in[1]); got != want {
			t.Fatalf("memoryIsolationKey(%q,%q) = %q, want %q", in[0], in[1], got, want)
		}
	}
}

// 截断按 rune 计(防止把多字节中文切碎),且去除首尾空白。
func TestTruncateMemoryContent(t *testing.T) {
	if got := truncateMemoryContent("  hello  "); got != "hello" {
		t.Fatalf("trim: got %q", got)
	}
	long := strings.Repeat("记", memoryContentMaxLen+50)
	got := truncateMemoryContent(long)
	if r := []rune(got); len(r) != memoryContentMaxLen {
		t.Fatalf("truncate: got %d runes, want %d", len(r), memoryContentMaxLen)
	}
	// 截断后仍是合法 UTF-8(rune 边界)
	if !strings.HasPrefix(got, "记") || strings.ContainsRune(got, '�') {
		t.Fatalf("truncate broke rune boundary")
	}
}

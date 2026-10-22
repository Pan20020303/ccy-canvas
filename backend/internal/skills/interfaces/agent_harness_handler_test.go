package interfaces

import (
	"encoding/json"
	"strings"
	"testing"
)

// 桥的 SSE 帧格式（与 agent_job_handler.go 一致）：
//
//	id: N\nevent: NAME\ndata: JSON\n\n
//
// 这个解析器是 Go 侧唯一"读懂桥"的地方，顺序/边界错都会静默丢事件，
// 所以逐条钉住。

func collect(t *testing.T, body string) []harnessEvent {
	t.Helper()
	var events []harnessEvent
	if err := readHarnessSSE(strings.NewReader(body), func(event harnessEvent) {
		events = append(events, event)
	}); err != nil {
		t.Fatalf("readHarnessSSE 返回错误: %v", err)
	}
	return events
}

func TestReadHarnessSSEParsesFrames(t *testing.T) {
	body := ": connected\n\n" +
		"id: 1\nevent: tool_call\ndata: {\"name\":\"create_text_node\"}\n\n" +
		"id: 2\nevent: canvas_patch\ndata: {\"op\":\"add_node\",\"revision\":1}\n\n" +
		"id: 3\nevent: done\ndata: {\"steps\":1}\n\n"

	events := collect(t, body)
	if len(events) != 3 {
		t.Fatalf("期望 3 条事件，实际 %d 条: %+v", len(events), events)
	}
	// 开头的注释行（心跳）不能被当成事件。
	if events[0].Type != "tool_call" || events[1].Type != "canvas_patch" || events[2].Type != "done" {
		t.Fatalf("事件顺序错误: %s / %s / %s", events[0].Type, events[1].Type, events[2].Type)
	}
	var call struct {
		Name string `json:"name"`
	}
	if err := json.Unmarshal(events[0].Data, &call); err != nil || call.Name != "create_text_node" {
		t.Fatalf("tool_call 载荷解析失败: %v / %s", err, string(events[0].Data))
	}
}

func TestReadHarnessSSEPreservesCanvasPatchBeforeDone(t *testing.T) {
	// 这是必须成立的顺序：前端一收到 done 就停止处理后续事件，
	// 画布补丁排在 done 之后会被静默丢弃（桥侧实测踩过）。
	body := "event: canvas_patch\ndata: {\"revision\":2}\n\n" +
		"event: canvas_patch\ndata: {\"revision\":3}\n\n" +
		"event: done\ndata: {\"steps\":1}\n\n"

	events := collect(t, body)
	if len(events) != 3 || events[2].Type != "done" {
		t.Fatalf("done 必须是最后一条: %+v", events)
	}
}

func TestReadHarnessSSEHandlesMultiLineData(t *testing.T) {
	// 规范允许同一个事件的 data 拆成多行；拼接时不能插入换行。
	body := "event: message\ndata: {\"content\":\"前半\"\ndata: ,\"extra\":1}\n\n"
	events := collect(t, body)
	if len(events) != 1 {
		t.Fatalf("期望 1 条事件，实际 %d 条", len(events))
	}
	var payload map[string]any
	if err := json.Unmarshal(events[0].Data, &payload); err != nil {
		t.Fatalf("多行 data 拼接后不是合法 JSON: %v / %s", err, string(events[0].Data))
	}
	if payload["content"] != "前半" {
		t.Fatalf("content 解析错误: %v", payload["content"])
	}
}

func TestReadHarnessSSEToleratesCRLFAndBlankData(t *testing.T) {
	body := "event: thought_delta\r\ndata: {\"delta\":\"a\"}\r\n\r\n" +
		"event: message\ndata: {}\n\n"
	events := collect(t, body)
	if len(events) != 2 {
		t.Fatalf("CRLF 行应被正确处理，实际 %d 条", len(events))
	}
	if events[0].Type != "thought_delta" || string(events[0].Data) != `{"delta":"a"}` {
		t.Fatalf("CRLF 帧解析错误: %+v", events[0])
	}
}

func TestReadHarnessSSEIgnoresFramesWithoutEventName(t *testing.T) {
	// 只有 data、没有 event 的帧必须被丢弃（否则会生成空类型事件污染前端契约）。
	body := "data: {\"x\":1}\n\n" + "event: usage\ndata: {\"total_tokens\":5}\n\n"
	events := collect(t, body)
	if len(events) != 1 || events[0].Type != "usage" {
		t.Fatalf("无 event 名的帧应被忽略: %+v", events)
	}
}

func TestReadHarnessSSEFlushesTrailingFrameWithoutBlankLine(t *testing.T) {
	// 连接在最后一个空行前被关掉时，最后一条事件仍然要交付。
	body := "event: done\ndata: {\"steps\":2}"
	events := collect(t, body)
	if len(events) != 1 || events[0].Type != "done" {
		t.Fatalf("结尾未带空行的帧应被 flush: %+v", events)
	}
}

func TestReadHarnessSSEAcceptsLargePayload(t *testing.T) {
	// 工具返回值/长回复可能很大，必须超过 bufio.Scanner 默认的 64KB 上限。
	large := strings.Repeat("很长的工具输出", 20000) // ~140KB UTF-8
	body := "event: tool_result\ndata: {\"ok\":true,\"result\":\"" + large + "\"}\n\n"
	events := collect(t, body)
	if len(events) != 1 {
		t.Fatalf("大载荷应被完整读取，实际 %d 条（可能是扫描缓冲上限问题）", len(events))
	}
	var payload struct {
		Result string `json:"result"`
	}
	if err := json.Unmarshal(events[0].Data, &payload); err != nil {
		t.Fatalf("大载荷不是合法 JSON: %v", err)
	}
	if payload.Result != large {
		t.Fatalf("大载荷被截断: 期望 %d 字符，实际 %d", len([]rune(large)), len([]rune(payload.Result)))
	}
}

func TestTruncateRunes(t *testing.T) {
	if got := truncateRunes("  前后空格  ", 10); got != "前后空格" {
		t.Fatalf("应去掉首尾空白: %q", got)
	}
	if got := truncateRunes("一二三四五", 3); got != "一二三…" {
		t.Fatalf("应按 rune 截断并加省略号: %q", got)
	}
	// 不能把中文切成半个字（按 rune 而不是字节）。
	got := truncateRunes("中文中文中文", 2)
	if len([]rune(got)) != 3 { // 2 个 rune + 省略号
		t.Fatalf("截断未按 rune 进行: %q", got)
	}
}

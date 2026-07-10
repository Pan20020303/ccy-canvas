package interfaces

import (
	"testing"

	"ccy-canvas/backend/internal/platform/database/sqlc"
)

func TestToConversationItems(t *testing.T) {
	messages := []sqlc.AgentConversationMessage{
		{
			Role:    "user",
			Content: "Draft a launch headline.",
		},
		{
			Role:    "assistant",
			Content: "Launch brighter with our summer collection.",
		},
		{
			Role:    "user",
			Content: "Make it warmer.",
		},
		{
			Role:    "assistant",
			Content: "Here is a warmer launch headline.",
		},
	}

	items := toConversationItems(messages)
	if len(items) != 2 {
		t.Fatalf("expected 2 items, got %d", len(items))
	}

	expected := []struct {
		userInput  string
		finalReply string
	}{
		{userInput: "Draft a launch headline.", finalReply: "Launch brighter with our summer collection."},
		{userInput: "Make it warmer.", finalReply: "Here is a warmer launch headline."},
	}

	for index, item := range items {
		if item.UserInput != expected[index].userInput || item.FinalReply != expected[index].finalReply {
			t.Fatalf("item %d mismatch: got %#v want user=%q reply=%q", index, item, expected[index].userInput, expected[index].finalReply)
		}
	}
}

// 一轮 run 会写 user / tool_log / assistant 三行:tool_log 是内部记录,
// 不能进 UI 历史,更不能让后续轮次的 user↔assistant 配对错位。
func TestToConversationItemsSkipsToolLog(t *testing.T) {
	messages := []sqlc.AgentConversationMessage{
		{Role: "user", Content: "你好"},
		{Role: "tool_log", Content: "✓ create_node({...}) → {id:...}"},
		{Role: "assistant", Content: "已创建节点。"},
		{Role: "user", Content: "继续"},
		{Role: "tool_log", Content: "✓ run_node({...}) → ok"},
		{Role: "assistant", Content: "已安排生成。"},
	}

	items := toConversationItems(messages)
	if len(items) != 2 {
		t.Fatalf("expected 2 items, got %d: %#v", len(items), items)
	}
	expected := []struct{ userInput, finalReply string }{
		{"你好", "已创建节点。"},
		{"继续", "已安排生成。"},
	}
	for index, item := range items {
		if item.UserInput != expected[index].userInput || item.FinalReply != expected[index].finalReply {
			t.Fatalf("item %d mismatch: got %#v want user=%q reply=%q", index, item, expected[index].userInput, expected[index].finalReply)
		}
	}
}

// 极端情况:历史被 LIMIT 截到 assistant 行开头(user 行不在窗口内),
// 该回复应单独成 item 而不是吞并下一轮的 user。
func TestToConversationItemsOrphanAssistant(t *testing.T) {
	messages := []sqlc.AgentConversationMessage{
		{Role: "assistant", Content: "(被截断轮次的回复)"},
		{Role: "user", Content: "新问题"},
		{Role: "assistant", Content: "新回答"},
	}

	items := toConversationItems(messages)
	if len(items) != 2 {
		t.Fatalf("expected 2 items, got %d: %#v", len(items), items)
	}
	if items[0].UserInput != "" || items[0].FinalReply != "(被截断轮次的回复)" {
		t.Fatalf("item 0 mismatch: %#v", items[0])
	}
	if items[1].UserInput != "新问题" || items[1].FinalReply != "新回答" {
		t.Fatalf("item 1 mismatch: %#v", items[1])
	}
}

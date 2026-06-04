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

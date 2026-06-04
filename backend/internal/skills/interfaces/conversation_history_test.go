package interfaces

import "testing"

func TestToConversationTurns(t *testing.T) {
	items := []AgentConversationItem{
		{
			UserInput:  "Draft a launch headline.",
			FinalReply: "Launch brighter with our summer collection.",
		},
		{
			UserInput:  "Make it warmer.",
			FinalReply: "Here is a warmer launch headline.",
		},
	}

	turns := toConversationTurns(items)
	if len(turns) != 4 {
		t.Fatalf("expected 4 turns, got %d", len(turns))
	}

	expected := []struct {
		role    string
		content string
	}{
		{role: "user", content: "Draft a launch headline."},
		{role: "assistant", content: "Launch brighter with our summer collection."},
		{role: "user", content: "Make it warmer."},
		{role: "assistant", content: "Here is a warmer launch headline."},
	}

	for index, turn := range turns {
		if turn.Role != expected[index].role || turn.Content != expected[index].content {
			t.Fatalf("turn %d mismatch: got %#v want role=%q content=%q", index, turn, expected[index].role, expected[index].content)
		}
	}
}

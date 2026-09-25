package sqlc

import (
	"context"
	"fmt"
	"reflect"
	"testing"
	"time"
)

// Use the isolated test schema, never production conversation rows.
const conversationOrderTestTable = `CREATE TABLE agent_conversation_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id uuid NOT NULL,
    role text NOT NULL,
    content text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON agent_conversation_messages(conversation_id, created_at);`

func TestConversationHistoryOrdersTiedTimestamps(t *testing.T) {
	q, pool := runtimeTestDB(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, conversationOrderTestTable); err != nil {
		t.Fatal(err)
	}
	conversation, other := runtimeUUID(), runtimeUUID()
	base := time.Date(2026, 9, 24, 3, 31, 26, 0, time.UTC)
	// The old transactional writer saved each turn at one timestamp. Deliberately
	// shuffle physical/UUID order so neither can accidentally supply role order.
	for turn := 0; turn < 3; turn++ {
		for _, role := range []string{"assistant", "user", "tool_log"} {
			if _, err := pool.Exec(ctx, `INSERT INTO agent_conversation_messages(conversation_id,role,content,created_at) VALUES($1,$2,$3,$4)`,
				conversation, role, fmt.Sprintf("%d-%s", turn, role), base.Add(time.Duration(turn)*time.Second)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO agent_conversation_messages(conversation_id,role,content) VALUES($1,'user','other canvas')`, other); err != nil {
		t.Fatal(err)
	}
	full := []string{"0-user", "0-tool_log", "0-assistant", "1-user", "1-tool_log", "1-assistant", "2-user", "2-tool_log", "2-assistant"}
	for _, limit := range []int32{100, 6, 5, 3, 2, 1, 0} {
		t.Run(fmt.Sprintf("latest_%d", limit), func(t *testing.T) {
			rows, err := q.ListAgentConversationMessages(ctx, ListAgentConversationMessagesParams{ConversationID: conversation, Limit: limit})
			if err != nil {
				t.Fatal(err)
			}
			got := make([]string, 0, len(rows))
			for _, row := range rows {
				got = append(got, row.Content)
			}
			want := full[max(0, len(full)-int(limit)):]
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("history order = %v, want %v", got, want)
			}
		})
	}
}

func TestConversationInsertRecordsStatementTimeWithinTransaction(t *testing.T) {
	_, pool := runtimeTestDB(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, conversationOrderTestTable); err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	q := New(tx)
	conversation := runtimeUUID()
	var previous time.Time
	for _, role := range []string{"user", "tool_log", "assistant"} {
		row, err := q.InsertAgentConversationMessage(ctx, InsertAgentConversationMessageParams{ConversationID: conversation, Role: role, Content: role})
		if err != nil {
			t.Fatal(err)
		}
		if !row.CreatedAt.Time.After(previous) {
			t.Fatalf("%s reused transaction timestamp: %v <= %v", role, row.CreatedAt.Time, previous)
		}
		previous = row.CreatedAt.Time
		if _, err := tx.Exec(ctx, "SELECT pg_sleep(0.002)"); err != nil {
			t.Fatal(err)
		}
	}
}

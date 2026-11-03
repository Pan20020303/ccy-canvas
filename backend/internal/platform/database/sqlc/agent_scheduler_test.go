package sqlc

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Integration tests create a unique, isolated schema, never touching app rows.
func runtimeTestDB(t *testing.T) (*Queries, *pgxpool.Pool) {
	t.Helper()
	dsn := os.Getenv("CCY_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set CCY_TEST_DATABASE_URL for isolated PostgreSQL tests")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	schema := "agent_runtime_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err = admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		// Only the literal prefix plus generated UUID can reach this cleanup.
		if len(schema) != len("agent_runtime_test_")+32 || !strings.HasPrefix(schema, "agent_runtime_test_") {
			t.Fatal("unsafe test schema")
		}
		if _, err := admin.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE"); err != nil {
			t.Error(err)
		}
		admin.Close()
	})
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	_, err = pool.Exec(ctx, `
CREATE TABLE agent_runs (id uuid PRIMARY KEY, conversation_id uuid NOT NULL, request_payload jsonb NOT NULL DEFAULT '{}', status text NOT NULL,
created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz,
final_reply text NOT NULL DEFAULT '', tool_calls integer NOT NULL DEFAULT 0, steps integer NOT NULL DEFAULT 0, error_msg text NOT NULL DEFAULT '', duration_ms integer NOT NULL DEFAULT 0);
CREATE TABLE agent_run_events (id bigserial PRIMARY KEY, run_id uuid NOT NULL, event_type text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE agent_memories (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, agent_id uuid, isolation_key text, role text DEFAULT 'user', content text,
embedding jsonb DEFAULT '[]', metadata jsonb DEFAULT '{}', summarized boolean DEFAULT false, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());`)
	if err != nil {
		t.Fatal(err)
	}
	return New(pool), pool
}

func runtimeUUID() pgtype.UUID { return pgtype.UUID{Bytes: uuid.New(), Valid: true} }

func TestAgentSchedulerDatabase(t *testing.T) {
	q, pool := runtimeTestDB(t)
	ctx := context.Background()
	lane, other := runtimeUUID(), runtimeUUID()
	first, second, independent, legacy := runtimeUUID(), runtimeUUID(), runtimeUUID(), runtimeUUID()
	insert := func(id, conversation pgtype.UUID, offset int, payload, status string) {
		t.Helper()
		_, err := pool.Exec(ctx, `INSERT INTO agent_runs(id,conversation_id,created_at,request_payload,status) VALUES($1,$2,now()+make_interval(secs => $3),$4,$5)`, id, conversation, offset, payload, status)
		if err != nil {
			t.Fatal(err)
		}
	}
	insert(legacy, lane, -30, "{}", "pending")
	insert(first, lane, -20, `{"message":"first"}`, "queued")
	insert(second, lane, -10, `{"message":"second"}`, "queued")
	insert(independent, other, 0, `{"message":"other"}`, "queued")
	claim := func(id, conversation pgtype.UUID, want string) {
		t.Helper()
		got, err := q.ClaimAgentRun(ctx, id, conversation)
		if err != nil || got != want {
			t.Fatalf("claim: %q, %v; want %q", got, err, want)
		}
	}
	claim(second, lane, "blocked")
	// Competing workers may claim the same row exactly once.
	var wg sync.WaitGroup
	results := make(chan string, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			state, err := q.ClaimAgentRun(ctx, first, lane)
			if err != nil {
				results <- fmt.Sprint(err)
			} else {
				results <- state
			}
		}()
	}
	wg.Wait()
	close(results)
	claimed := 0
	for state := range results {
		if state == "claimed" {
			claimed++
		} else if state != "running" {
			t.Error(state)
		}
	}
	if claimed != 1 {
		t.Fatalf("claimed %d times", claimed)
	}
	claim(second, lane, "blocked")
	claim(independent, other, "claimed")
	if err := q.RequestAgentRunCancellation(ctx, first); err != nil {
		t.Fatal(err)
	}
	claim(first, lane, "waiting")
	claim(second, lane, "blocked")
	if err := q.FinishAgentRunJob(ctx, FinishAgentRunJobParams{ID: first, Status: "cancelled", EventType: "error", EventData: []byte(`{"message":"cancelled"}`)}); err != nil {
		t.Fatal(err)
	}
	// Late model completion must not overwrite cancellation or append a second terminal event.
	if err := q.FinishAgentRunJob(ctx, FinishAgentRunJobParams{ID: first, Status: "success", EventType: "done", EventData: []byte(`{}`)}); err != nil {
		t.Fatal(err)
	}
	claim(first, lane, "cancelled")
	claim(second, lane, "claimed")
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM agent_run_events WHERE run_id=$1 AND event_type IN ('done','error')`, first).Scan(&count); err != nil || count != 1 {
		t.Fatalf("terminal events=%d: %v", count, err)
	}
	// An interrupted lease expires without replay, releasing the next queued run.
	third := runtimeUUID()
	insert(third, lane, 10, `{"message":"third"}`, "queued")
	if _, err := pool.Exec(ctx, `UPDATE agent_runs SET started_at=now()-interval '12 minutes' WHERE id=$1`, second); err != nil {
		t.Fatal(err)
	}
	claim(third, lane, "claimed")
	claim(second, lane, "error")
}

func TestMemoryQueryFiltersBeforeLimitAndIsolatesOwners(t *testing.T) {
	q, pool := runtimeTestDB(t)
	ctx := context.Background()
	user, agent, another := runtimeUUID(), runtimeUUID(), runtimeUUID()
	for _, row := range []struct {
		user         pgtype.UUID
		key, content string
		age          int
	}{
		{user, "project-a", "我叫林书豪", -30}, {user, "project-a", "最新的无关内容", 0},
		{another, "project-a", "别人的林书豪", 1}, {user, "project-b", "其他项目林书豪", 2},
	} {
		if _, err := pool.Exec(ctx, `INSERT INTO agent_memories(user_id,agent_id,isolation_key,content,created_at) VALUES($1,$2,$3,$4,now()+make_interval(secs=>$5))`, row.user, agent, row.key, row.content, row.age); err != nil {
			t.Fatal(err)
		}
	}
	rows, err := q.ListAgentMemories(ctx, ListAgentMemoriesParams{UserID: user, AgentID: agent, IsolationKey: "project-a", Query: "林书豪", Limit: 1})
	if err != nil || len(rows) != 1 || rows[0].Content != "我叫林书豪" {
		t.Fatalf("memory lookup: %+v, %v", rows, err)
	}
}

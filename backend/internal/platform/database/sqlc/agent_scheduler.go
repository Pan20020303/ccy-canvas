package sqlc

import (
	"context"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

// Claim under a short, per-conversation transaction lock. No model request
// holds a database transaction. Multiple worker processes share the same lane.
func (q *Queries) ClaimAgentRun(ctx context.Context, id, conversationID pgtype.UUID) (string, error) {
	db, ok := q.db.(interface {
		Begin(context.Context) (pgx.Tx, error)
	})
	if !ok {
		return "", fmt.Errorf("agent scheduler requires transaction support")
	}
	tx, err := db.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1::text, 7342))`, fmt.Sprintf("%x", conversationID.Bytes)); err != nil {
		return "", err
	}
	// The execution deadline is ten minutes. A much older lease belongs to an
	// interrupted worker, not a currently valid execution; do not replay it.
	if _, err = tx.Exec(ctx, `WITH expired AS (
UPDATE agent_runs SET status='error',error_msg='上次执行已中断，未自动重放；请检查已完成操作后重试',finished_at=now(),updated_at=now()
WHERE conversation_id=$1 AND request_payload<>'{}'::jsonb AND status IN ('running','waiting') AND started_at < now()-interval '11 minutes'
RETURNING id,error_msg)
INSERT INTO agent_run_events(run_id,event_type,data) SELECT id,'error',jsonb_build_object('message',error_msg) FROM expired`, conversationID); err != nil {
		return "", err
	}
	var status string
	if err = tx.QueryRow(ctx, `SELECT status FROM agent_runs WHERE id=$1 FOR UPDATE`, id).Scan(&status); err != nil {
		return "", err
	}
	// A recovered delivery is not a license to repeat already-started tools.
	if status != "queued" && status != "pending" {
		return status, tx.Commit(ctx)
	}
	var blocked bool
	err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agent_runs r WHERE r.conversation_id=$1 AND r.id<>$2 AND r.request_payload <> '{}'::jsonb AND (r.status IN ('running','waiting') OR (r.status IN ('queued','pending') AND (r.created_at,r.id)<(SELECT created_at,id FROM agent_runs WHERE id=$2))))`, conversationID, id).Scan(&blocked)
	if err != nil {
		return "", err
	}
	if blocked {
		return "blocked", tx.Commit(ctx)
	}
	if _, err = tx.Exec(ctx, `UPDATE agent_runs SET status='running',started_at=now(),updated_at=now() WHERE id=$1`, id); err != nil {
		return "", err
	}
	if err = tx.Commit(ctx); err != nil {
		return "", err
	}
	return "claimed", nil
}

// Running jobs retain the session lane until the worker acknowledges the stop.
// Waiting is an existing persisted state, so no status-enum migration is needed.
func (q *Queries) RequestAgentRunCancellation(ctx context.Context, id pgtype.UUID) error {
	_, err := q.db.Exec(ctx, `WITH stopped AS (
UPDATE agent_runs SET status=CASE WHEN status IN ('pending','queued') THEN 'cancelled' ELSE 'waiting' END,
error_msg=CASE WHEN status IN ('pending','queued') THEN '用户已取消任务；已完成的操作不会回滚' ELSE '用户请求停止' END,
finished_at=CASE WHEN status IN ('pending','queued') THEN now() ELSE finished_at END,updated_at=now()
WHERE id=$1 AND status IN ('pending','queued','running') RETURNING id,status,error_msg)
INSERT INTO agent_run_events(run_id,event_type,data) SELECT id,CASE WHEN status='cancelled' THEN 'error' ELSE 'lifecycle' END,
jsonb_build_object('status',status,'message',error_msg) FROM stopped`, id)
	return err
}

func (q *Queries) SaveAgentRunConversation(ctx context.Context, runID, conversationID pgtype.UUID, title string, messages []InsertAgentConversationMessageParams) error {
	db, ok := q.db.(interface {
		Begin(context.Context) (pgx.Tx, error)
	})
	if !ok {
		return fmt.Errorf("agent history requires transaction support")
	}
	tx, err := db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.Background())
	var status string
	if err = tx.QueryRow(ctx, `SELECT status FROM agent_runs WHERE id=$1 FOR UPDATE`, runID).Scan(&status); err != nil {
		return err
	}
	if status != "running" {
		return fmt.Errorf("任务已停止，不再写入会话")
	}
	tq := q.WithTx(tx)
	for _, message := range messages {
		message.ConversationID = conversationID
		if _, err = tq.InsertAgentConversationMessage(ctx, message); err != nil {
			return err
		}
	}
	if _, err = tq.TouchAgentConversation(ctx, TouchAgentConversationParams{ID: conversationID, Title: title}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

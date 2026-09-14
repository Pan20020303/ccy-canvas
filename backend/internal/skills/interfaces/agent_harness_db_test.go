package interfaces

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"ccy-canvas/backend/internal/platform/database/sqlc"
	skillsapp "ccy-canvas/backend/internal/skills/application"
)

// Go↔桥 的端到端测试（含会话持久化），需要真实 Postgres。
//
// 运行方式：
//   $env:CCY_TEST_DATABASE_URL = "postgres://postgres:postgres@localhost:55432/ccy_canvas?sslmode=disable"
//   go test ./internal/skills/interfaces/ -run Harness -v
//
// 未设置该变量时跳过 —— 保证 CI 在没有数据库时不会红。
//
// 数据隔离：全程在一个事务里，结束时统一 ROLLBACK，所以不会给开发库留残留。
// 事务同时也**提高了测试强度**：router 的 q 就是这个事务，任何"绕过传入 querier
// 偷偷拿连接"的写法都会读不到数据而失败。

const testDatabaseURLEnv = "CCY_TEST_DATABASE_URL"

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := strings.TrimSpace(os.Getenv(testDatabaseURLEnv))
	if url == "" {
		t.Skipf("未设置 %s，跳过需要数据库的测试", testDatabaseURLEnv)
	}
	pool, err := pgxpool.New(context.Background(), url)
	if err != nil {
		t.Skipf("无法创建连接池（%v），跳过", err)
	}
	if err := pool.Ping(context.Background()); err != nil {
		pool.Close()
		t.Skipf("数据库不可达（%v），跳过", err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// seedFixture 在一个事务里造出 job/agent/conversation 所需的最小数据。
type fixture struct {
	tx           pgx.Tx
	q            *sqlc.Queries
	userID       pgtype.UUID
	agentID      pgtype.UUID
	conversation sqlc.AgentConversation
	job          sqlc.AgentRunJob
}

func seedFixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool) *fixture {
	t.Helper()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("开启事务失败: %v", err)
	}
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })

	q := sqlc.New(tx)

	var userID pgtype.UUID
	if err := tx.QueryRow(ctx, `
		insert into users (email, password_hash, name, role, status)
		values ($1, 'x', 'harness-test', 'member', 'active')
		returning id`, "harness-test-"+time.Now().Format("150405.000000")+"@example.invalid",
	).Scan(&userID); err != nil {
		t.Fatalf("造用户失败: %v", err)
	}

	var agentID pgtype.UUID
	if err := tx.QueryRow(ctx, `
		insert into agents (scope, owner_id, name, system_prompt, model, strategy, canvas_tools, metadata)
		values ('personal', $1, 'harness 测试智能体', '你是测试用智能体', 'deepseek-flash', 'reactive', true,
		        '{"agentRuntime":"harness"}'::jsonb)
		returning id`, userID,
	).Scan(&agentID); err != nil {
		t.Fatalf("造智能体失败: %v", err)
	}

	conversation, err := q.InsertAgentConversation(ctx, sqlc.InsertAgentConversationParams{
		UserID: userID, AgentID: agentID, Title: "harness 测试智能体",
	})
	if err != nil {
		t.Fatalf("造会话失败: %v", err)
	}

	job, err := q.InsertAgentRunJob(ctx, sqlc.InsertAgentRunJobParams{
		UserID: userID, AgentID: agentID, ConversationID: conversation.ID,
		UserInput: "建个节点", RequestPayload: []byte(`{}`),
	})
	if err != nil {
		t.Fatalf("造 job 失败: %v", err)
	}

	return &fixture{tx: tx, q: q, userID: userID, agentID: agentID, conversation: conversation, job: job}
}

// harnessRouter 构造一个只用于 harness 路径的 router（其余依赖在这些测试里用不到）。
// 终态写入走真实 SQL：本文件的测试都在事务里，能看到未提交的行。
func harnessRouter(q *sqlc.Queries) *AgentRunRouter {
	return &AgentRunRouter{q: q}
}

// TestAgentUsesHarness 钉住派发规则：只有 metadata.agentRuntime == "harness" 才走桥接。
func TestAgentUsesHarness(t *testing.T) {
	cases := []struct {
		name     string
		metadata string
		want     bool
	}{
		{"hook 命中", `{"agentRuntime":"harness"}`, true},
		{"大小写与空白无关", `{"agentRuntime":"  HARNESS "}`, true},
		{"其它后端值", `{"agentRuntime":"local"}`, false},
		{"有 metadata 但没这个键", `{"other":1}`, false},
		{"空 metadata", ``, false},
		{"非法 JSON 不得 panic，按关闭处理", `{not json`, false},
		{"类型不对（数组）不得 panic", `{"agentRuntime":["harness"]}`, false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			agent := sqlc.Agent{}
			if testCase.metadata != "" {
				agent.Metadata = []byte(testCase.metadata)
			}
			if got := agentUsesHarness(agent); got != testCase.want {
				t.Fatalf("agentUsesHarness(%s) = %v, 期望 %v", testCase.metadata, got, testCase.want)
			}
		})
	}
}

func TestHarnessJobEndToEndPersistsEventsAndConversation(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	fx := seedFixture(t, ctx, pool)

	bridge := &fakeBridge{events: ": connected\n\n" +
		"id: 1\nevent: thought_delta\ndata: {\"delta\":\"先看看画布\"}\n\n" +
		"id: 2\nevent: tool_call\ndata: {\"id\":\"c1\",\"name\":\"create_text_node\",\"arguments\":\"{\\\"content\\\":\\\"hi\\\"}\"}\n\n" +
		"id: 3\nevent: tool_result\ndata: {\"id\":\"c1\",\"name\":\"create_text_node\",\"ok\":true,\"result\":\"{\\\"ok\\\":true,\\\"node_id\\\":\\\"n1\\\"}\"}\n\n" +
		"id: 4\nevent: message\ndata: {\"content\":\"已建好 n1\"}\n\n" +
		"id: 5\nevent: canvas_patch\ndata: {\"op\":\"add_node\",\"node\":{\"id\":\"n1\"},\"base_revision\":0,\"revision\":1}\n\n" +
		"id: 6\nevent: done\ndata: {\"steps\":1}\n\n"}
	server := bridge.start(t)
	t.Setenv(harnessBridgeURLEnv, server.URL)

	router := harnessRouter(fx.q)
	emit := func(event string, data any) { router.persistAgentEvent(fx.job.ID, event, data) }

	// 真实调用：走完 HTTP 桥 → 事件落库 → 会话持久化 → job 终态。
	if err := router.executeHarnessAgentJob(ctx, fx.job, sqlc.Agent{ID: fx.agentID, Name: "harness 测试智能体"},
		fx.conversation, agentRunRequest{Message: "建个文本节点"}, emit); err != nil {
		t.Fatalf("harness 执行失败: %v", err)
	}

	// 1) job 终态。终态事件不落在 agent_runs 上 —— FinishAgentRunJob 是原子 CTE：
	//    更新 agent_runs 的同时把终态事件插进 agent_run_events。
	var status, finalReply string
	var toolCalls, steps int
	if err := fx.tx.QueryRow(ctx,
		`select status, final_reply, tool_calls, steps from agent_runs where id = $1`, fx.job.ID,
	).Scan(&status, &finalReply, &toolCalls, &steps); err != nil {
		t.Fatalf("读取 job 失败: %v", err)
	}
	if status != "success" {
		t.Fatalf("job 状态应为 success，实际 %q", status)
	}
	if finalReply != "已建好 n1" {
		t.Fatalf("最终回复未落库: %q", finalReply)
	}
	if toolCalls != 1 {
		t.Fatalf("工具调用计数应为 1，实际 %d", toolCalls)
	}

	// 终态事件（done）与其载荷（steps）
	var eventType string
	var eventData []byte
	if err := fx.tx.QueryRow(ctx,
		`select event_type, data from agent_run_events where run_id = $1 order by id desc limit 1`, fx.job.ID,
	).Scan(&eventType, &eventData); err != nil {
		t.Fatalf("读取终态事件失败: %v", err)
	}
	if eventType != skillsapp.EventDone {
		t.Fatalf("最后一条事件应为 done，实际 %q", eventType)
	}
	var donePayload struct {
		Steps int `json:"steps"`
	}
	if err := json.Unmarshal(eventData, &donePayload); err != nil || donePayload.Steps < 1 {
		t.Fatalf("done 载荷应含 steps: %s (err=%v)", string(eventData), err)
	}

	// 2) 事件顺序：canvas_patch 必须在 done 之前（前端收到 done 就停止处理后续事件）
	rows, err := fx.tx.Query(ctx,
		`select event_type from agent_run_events where run_id = $1 order by id`, fx.job.ID)
	if err != nil {
		t.Fatalf("读取事件失败: %v", err)
	}
	var persisted []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatalf("扫描事件失败: %v", err)
		}
		persisted = append(persisted, name)
	}
	rows.Close()

	joined := strings.Join(persisted, ",")
	wantOrder := []string{
		skillsapp.EventThoughtDelta,
		skillsapp.EventToolCall,
		skillsapp.EventToolResult,
		skillsapp.EventMessage,
		skillsapp.EventCanvasPatch,
		skillsapp.EventDone,
	}
	if joined != strings.Join(wantOrder, ",") {
		t.Fatalf("事件落库顺序不符\nwant: %v\n got: %v", wantOrder, persisted)
	}

	// 3) 会话消息：user / tool_log / assistant 三条都要有（harness 路径最容易漏写）
	msgRows, err := fx.tx.Query(ctx,
		`select role, content from agent_conversation_messages where conversation_id = $1 order by created_at, id`,
		fx.conversation.ID)
	if err != nil {
		t.Fatalf("读取会话消息失败: %v", err)
	}
	roles := map[string]string{}
	for msgRows.Next() {
		var role, content string
		if err := msgRows.Scan(&role, &content); err != nil {
			t.Fatalf("扫描会话消息失败: %v", err)
		}
		roles[role] = content
	}
	msgRows.Close()
	if roles["user"] != "建个文本节点" {
		t.Fatalf("user 消息未落库: %+v", roles)
	}
	if roles["assistant"] != "已建好 n1" {
		t.Fatalf("assistant 消息未落库: %+v", roles)
	}
	if !strings.Contains(roles["tool_log"], "create_text_node") {
		t.Fatalf("tool_log 未落库或未包含工具名: %q", roles["tool_log"])
	}

	// 4) 记忆与标题
	var memoryCount int
	if err := fx.tx.QueryRow(ctx,
		`select count(*) from agent_memories where user_id = $1 and agent_id = $2`, fx.userID, fx.agentID,
	).Scan(&memoryCount); err != nil {
		t.Fatalf("统计记忆失败: %v", err)
	}
	if memoryCount == 0 {
		t.Fatal("本轮记忆未落库（PersistTurnMemory 未被调用？）")
	}

	var title string
	if err := fx.tx.QueryRow(ctx,
		`select title from agent_conversations where id = $1`, fx.conversation.ID,
	).Scan(&title); err != nil {
		t.Fatalf("读取标题失败: %v", err)
	}
	if title == "" || title == "harness 测试智能体" {
		t.Fatalf("首轮未用用户消息生成标题: %q", title)
	}
}

func TestHarnessJobFailureMarksRunErrorAndKeepsNoAssistantMessage(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	fx := seedFixture(t, ctx, pool)

	// 桥连不上：job 必须落到 error，且不能写一条空的 assistant 消息污染历史。
	t.Setenv(harnessBridgeURLEnv, "http://127.0.0.1:1")

	router := harnessRouter(fx.q)
	emit := func(event string, data any) { router.persistAgentEvent(fx.job.ID, event, data) }

	_ = router.executeHarnessAgentJob(ctx, fx.job, sqlc.Agent{ID: fx.agentID, Name: "harness 测试智能体"},
		fx.conversation, agentRunRequest{Message: "建个文本节点"}, emit)

	var status, errorMessage string
	if err := fx.tx.QueryRow(ctx,
		`select status, error_msg from agent_runs where id = $1`, fx.job.ID,
	).Scan(&status, &errorMessage); err != nil {
		t.Fatalf("读取 job 失败: %v", err)
	}
	if status != "error" {
		t.Fatalf("桥不可用时 job 应为 error，实际 %q", status)
	}
	if !strings.Contains(errorMessage, "桥接") {
		t.Fatalf("错误信息应可诊断: %q", errorMessage)
	}
	// 终态事件应为 error
	var terminalEvent string
	if err := fx.tx.QueryRow(ctx,
		`select event_type from agent_run_events where run_id = $1 order by id desc limit 1`, fx.job.ID,
	).Scan(&terminalEvent); err != nil {
		t.Fatalf("读取终态事件失败: %v", err)
	}
	if terminalEvent != skillsapp.EventError {
		t.Fatalf("终态事件应为 error，实际 %q", terminalEvent)
	}

	var assistantCount int
	if err := fx.tx.QueryRow(ctx,
		`select count(*) from agent_conversation_messages where conversation_id = $1 and role = 'assistant'`,
		fx.conversation.ID).Scan(&assistantCount); err != nil {
		t.Fatalf("统计 assistant 消息失败: %v", err)
	}
	if assistantCount != 0 {
		t.Fatalf("失败的一轮不应写入 assistant 消息，实际 %d 条", assistantCount)
	}
}

// 保证 fakeBridge 的 SSE 正文与真实桥一致（真实桥的帧由 agent_job_handler 的
// 格式约定；这里用同形帧构造，避免测试自说自话）。
func TestFakeBridgeFrameShapeMatchesContract(t *testing.T) {
	frame := "id: 1\nevent: message\ndata: {\"content\":\"x\"}\n\n"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "text/event-stream")
		_, _ = w.Write([]byte(frame))
	}))
	defer server.Close()

	response, err := http.Get(server.URL)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer response.Body.Close()
	var events []harnessEvent
	if err := readHarnessSSE(response.Body, func(event harnessEvent) { events = append(events, event) }); err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if len(events) != 1 || events[0].Type != "message" {
		t.Fatalf("帧解析结果不符: %+v", events)
	}
	var payload struct {
		Content string `json:"content"`
	}
	if err := json.Unmarshal(events[0].Data, &payload); err != nil || payload.Content != "x" {
		t.Fatalf("载荷解析失败: %v", err)
	}
}

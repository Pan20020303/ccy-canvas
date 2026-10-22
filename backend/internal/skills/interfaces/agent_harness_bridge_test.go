package interfaces

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"ccy-canvas/backend/internal/platform/database/sqlc"
	skillsapp "ccy-canvas/backend/internal/skills/application"
)

// 不需要数据库的桥接管道测试：错误处理、URL 归一化、提前返回的守卫。
//
// 需要真实 Postgres 的端到端测试（事件落库顺序、会话消息、记忆、标题）在
// agent_harness_db_test.go，由 CCY_TEST_DATABASE_URL 控制是否运行。
//
// 注意：不能让 q 为 nil 去跑"成功路径" —— persistSuccessfulTurn 会真的写库，
// nil 会直接 panic。所以成功路径只在真库测试里覆盖。

// fakeBridge 同时扮演 POST /jobs 与 GET /events 两个端点。
type fakeBridge struct {
	mu sync.Mutex
	// submitStatus 非 202/200 时用于模拟拒绝。
	submitStatus int
	submitBody   string
	// events 是 SSE 正文（已含帧格式）。
	events string
	// dropSubmit 为真时不返回 job_id，模拟无效响应。
	dropSubmit bool
	jobID      string
	// lastSubmit 记录最后一次 /jobs 收到的请求体，用于断言"发出去的是什么"。
	lastSubmit []byte
}

func (f *fakeBridge) start(t *testing.T) *httptest.Server {
	t.Helper()
	if f.jobID == "" {
		f.jobID = "job_fake_1"
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/jobs"):
			body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
			f.mu.Lock()
			f.lastSubmit = body
			f.mu.Unlock()
			status := f.submitStatus
			if status == 0 {
				status = http.StatusAccepted
			}
			if status != http.StatusAccepted && status != http.StatusOK {
				w.WriteHeader(status)
				_, _ = w.Write([]byte(f.submitBody))
				return
			}
			w.Header().Set("content-type", "application/json")
			w.WriteHeader(status)
			if f.dropSubmit {
				_, _ = w.Write([]byte(`{}`))
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]string{"job_id": f.jobID, "status": "queued"})
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/events"):
			w.Header().Set("content-type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(f.events))
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

// capturedError 断言"失败路径先落一条 error 事件"，并返回其内容。
func capturedError(t *testing.T, events []recordedEvent) string {
	t.Helper()
	if len(events) == 0 {
		t.Fatal("没有任何事件落库")
	}
	if events[0].eventType != skillsapp.EventError {
		t.Fatalf("第一条事件应为 error，实际 %q（全部: %+v）", events[0].eventType, events)
	}
	var payload struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal([]byte(events[0].data), &payload); err != nil {
		t.Fatalf("error 事件载荷不是合法 JSON: %v", err)
	}
	return payload.Message
}

type recordedEvent struct {
	eventType string
	data      string
}

// terminalCall 记录注入式终态写入器的调用（替代真实 SQL）。
type terminalCall struct {
	called bool
	stats  skillsapp.RunStats
	runErr error
	data   any
}

func collectingEmit() (*[]recordedEvent, func(string, any)) {
	var events []recordedEvent
	emit := func(event string, data any) {
		raw, _ := json.Marshal(data)
		events = append(events, recordedEvent{eventType: event, data: string(raw)})
	}
	return &events, emit
}

// routerWithSink 构造一个不连数据库的 router：终态写入被替换成内存记录。
// 这样失败路径（它末尾也要写终态）才能在无库环境下被测。
func routerWithSink() (*AgentRunRouter, *terminalCall) {
	call := &terminalCall{}
	router := (&AgentRunRouter{}).WithTerminalSink(
		func(_ context.Context, _ pgtype.UUID, stats skillsapp.RunStats, runErr error, _ time.Time, data any) error {
			call.called = true
			call.stats = stats
			call.runErr = runErr
			call.data = data
			return nil
		})
	return router, call
}

// drainEvents 只读取事件、不触发持久化：用于验证"失败发生在写库之前"。
func drainEvents(events *[]recordedEvent) []string {
	names := make([]string, 0, len(*events))
	for _, event := range *events {
		names = append(names, event.eventType)
	}
	return names
}

func TestHarnessJobReportsBridgeUnavailable(t *testing.T) {
	t.Setenv(harnessBridgeURLEnv, "http://127.0.0.1:1")
	events, emit := collectingEmit()
	router, terminal := routerWithSink()

	_ = router.executeHarnessAgentJob(
		context.Background(), sqlc.AgentRunJob{}, sqlc.Agent{}, sqlc.AgentConversation{},
		agentRunRequest{Message: "x"}, emit,
	)
	message := capturedError(t, *events)
	if !strings.Contains(message, "桥接服务不可用") {
		t.Fatalf("错误信息不够可诊断: %q", message)
	}
	// 失败也必须写终态，否则 job 会永远悬在 running。
	if !terminal.called || terminal.runErr == nil {
		t.Fatalf("桥不可用时必须写 error 终态: called=%v err=%v", terminal.called, terminal.runErr)
	}
}

func TestHarnessJobRejectsWhenBridgeRefusesSubmit(t *testing.T) {
	bridge := &fakeBridge{submitStatus: http.StatusInternalServerError, submitBody: "boom"}
	server := bridge.start(t)
	t.Setenv(harnessBridgeURLEnv, server.URL)
	events, emit := collectingEmit()
	router, terminal := routerWithSink()

	_ = router.executeHarnessAgentJob(
		context.Background(), sqlc.AgentRunJob{}, sqlc.Agent{}, sqlc.AgentConversation{},
		agentRunRequest{Message: "x"}, emit,
	)
	message := capturedError(t, *events)
	// 面向用户的文案不应泄漏上游细节（PublicMessage 的设计如此），
	// 但原始原因必须留在 error 里供日志排查。
	if !strings.Contains(message, "拒绝了任务") {
		t.Fatalf("用户可见文案不符: %q", message)
	}
	if !terminal.called || terminal.runErr == nil {
		t.Fatal("桥拒绝任务时必须写 error 终态")
	}
	if !strings.Contains(terminal.runErr.Error(), "500") &&
		!strings.Contains(fmt.Sprint(errors.Unwrap(terminal.runErr)), "500") {
		t.Fatalf("原始错误应保留上游状态码供排查: %v", terminal.runErr)
	}
}

func TestHarnessJobRejectsInvalidJobID(t *testing.T) {
	bridge := &fakeBridge{dropSubmit: true}
	server := bridge.start(t)
	t.Setenv(harnessBridgeURLEnv, server.URL)
	events, emit := collectingEmit()
	router, terminal := routerWithSink()

	_ = router.executeHarnessAgentJob(
		context.Background(), sqlc.AgentRunJob{}, sqlc.Agent{}, sqlc.AgentConversation{},
		agentRunRequest{Message: "x"}, emit,
	)
	message := capturedError(t, *events)
	if !strings.Contains(message, "任务号") {
		t.Fatalf("错误信息应指明无效任务号: %q", message)
	}
	if !terminal.called {
		t.Fatal("无效 job_id 时必须写 error 终态")
	}
}

func TestHarnessBridgeURLNormalization(t *testing.T) {
	t.Setenv(harnessBridgeURLEnv, "http://127.0.0.1:39300/")
	if got := harnessBridgeURL(); got != "http://127.0.0.1:39300" {
		t.Fatalf("尾部斜杠应被去掉: %q", got)
	}
	t.Setenv(harnessBridgeURLEnv, "   ")
	if got := harnessBridgeURL(); got != harnessBridgeURLDefault {
		t.Fatalf("空白值应回退默认地址: %q", got)
	}
}

func TestPersistSuccessfulTurnGuardsBeforeTouchingStore(t *testing.T) {
	// 无最终回复、或用户消息为空时必须提前返回 —— q 为 nil 也不会 panic。
	// 这两个守卫是"失败轮次不污染会话历史"的关键。
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("守卫失效，触碰了数据库: %v", r)
		}
	}()
	router := &AgentRunRouter{}
	router.persistSuccessfulTurn(context.Background(), sqlc.AgentRunJob{}, sqlc.Agent{},
		sqlc.AgentConversation{}, agentRunRequest{Message: "x"}, skillsapp.RunStats{FinalReply: ""})
	router.persistSuccessfulTurn(context.Background(), sqlc.AgentRunJob{}, sqlc.Agent{},
		sqlc.AgentConversation{}, agentRunRequest{Message: ""}, skillsapp.RunStats{FinalReply: "有回复"})
}

// 斜杠技能必须在分流**之前**解析：否则桥收到的是字面 "/rewrite 正文"，
// 技能模板完全没生效。
//
// 注意：这里**不能让桥回 message** —— 成功路径末端会 persistSuccessfulTurn 写库，
// 无库环境下会 panic（成功路径必须由真库测试覆盖，见 agent_harness_db_test.go）。
// 所以本测试只发 usage/done，专注断言"发到桥的载荷"。
func TestHarnessJobSendsResolvedSlashSkillToBridge(t *testing.T) {
	bridge := &fakeBridge{events: "event: usage\ndata: {\"total_tokens\":1}\n\nevent: done\ndata: {\"steps\":1}\n\n"}
	server := bridge.start(t)
	t.Setenv(harnessBridgeURLEnv, server.URL)

	events, emit := collectingEmit()
	router, _ := routerWithSink()
	// q 为 nil：LoadBoundSkills 对 nil 是安全的（skill_ids 为空则直接返回），
	// 这条路径只验证"消息被原样送到桥"，不涉及技能查库。
	_ = router.executeHarnessAgentJob(
		context.Background(), sqlc.AgentRunJob{}, sqlc.Agent{}, sqlc.AgentConversation{},
		agentRunRequest{Message: "（参考画布节点：开场图#a1b2c3）\n/rewrite 换成更暖的调子"}, emit,
	)

	var payload map[string]any
	if err := json.Unmarshal(bridge.lastSubmit, &payload); err != nil {
		t.Fatalf("桥收到的请求体不是合法 JSON: %v / %s", err, string(bridge.lastSubmit))
	}
	message, _ := payload["message"].(string)
	if message == "" {
		t.Fatal("桥收到的 message 为空")
	}
	// q 为 nil 时没有绑定技能可查，所以这里应当原样透传（含前导与命令），
	// 关键是不能把消息丢掉或截断。
	if !strings.Contains(message, "/rewrite") || !strings.Contains(message, "开场图#a1b2c3") {
		t.Fatalf("消息未被完整透传:\n%s", message)
	}
	// conversation_id 必须存在（桥用它当 DSH sessionId）
	if payload["conversation_id"] == nil {
		t.Fatalf("缺少 conversation_id: %s", string(bridge.lastSubmit))
	}
	_ = events
}

func TestHarnessJobRespectsCancelledContext(t *testing.T) { // ctx 已取消：提交阶段应立刻失败并落 error 事件，而不是挂住或 panic。
	bridge := &fakeBridge{events: "event: message\ndata: {\"content\":\"ok\"}\n\n"}
	server := bridge.start(t)
	t.Setenv(harnessBridgeURLEnv, server.URL)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	events, emit := collectingEmit()
	router, _ := routerWithSink()

	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = router.executeHarnessAgentJob(ctx, sqlc.AgentRunJob{}, sqlc.Agent{},
			sqlc.AgentConversation{}, agentRunRequest{Message: "x"}, emit)
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("上下文取消后 10s 仍未返回")
	}
	if len(*events) == 0 {
		t.Fatal("取消后仍应落一条 error 事件，让前端能离开思考中")
	}
	if names := drainEvents(events); names[0] != skillsapp.EventError {
		t.Fatalf("取消时首条事件应为 error，实际 %v", names)
	}
}

package application

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const initialTestPlan = `{"steps":[{"id":"read","title":"核对参考素材","status":"in_progress"},{"id":"generate","title":"提交生成并确认结果","status":"pending"}],"summary":"先核对素材，再处理生成请求"}`

func TestTaskPlanSchemaAndValidation(t *testing.T) {
	var events []TaskPlan
	tool := BuildTaskProgressTool(func(event string, data any) {
		if event != EventPlan {
			t.Fatalf("unexpected event: %s", event)
		}
		events = append(events, data.(TaskPlan))
	})
	var schema map[string]any
	if err := json.Unmarshal(tool.Parameters(), &schema); err != nil {
		t.Fatal(err)
	}
	stepsSchema := schema["properties"].(map[string]any)["steps"].(map[string]any)
	if stepsSchema["minItems"] != float64(2) || stepsSchema["maxItems"] != float64(6) {
		t.Fatalf("unbounded plan schema: %s", tool.Parameters())
	}
	if _, err := tool.Execute(context.Background(), json.RawMessage(initialTestPlan)); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{
		`{}`, `{"steps":[]}`, `{"steps":[{"id":"read","title":"只做一步","status":"pending"}]}`,
		initialTestPlan + `{}`,
		strings.Replace(initialTestPlan, `"generate"`, `"read"`, 1),
		strings.Replace(initialTestPlan, `"pending"`, `"unknown"`, 1),
		strings.Replace(initialTestPlan, `"pending"`, `"in_progress"`, 1),
		strings.Replace(initialTestPlan, `核对参考素材`, `Inspect the private reasoning`, 1),
		strings.Replace(initialTestPlan, `核对参考素材`, `查看\n素材`, 1),
		strings.Replace(initialTestPlan, `先核对素材，再处理生成请求`, strings.Repeat("内容", 61), 1),
		strings.Replace(initialTestPlan, `"read"`, `"replacement"`, 1),
		strings.Replace(initialTestPlan, `{"steps"`, `{"reasoning":"private","steps"`, 1),
	} {
		if _, err := tool.Execute(context.Background(), json.RawMessage(bad)); err == nil {
			t.Errorf("accepted invalid plan: %s", bad)
		}
	}
	if len(events) != 1 {
		t.Fatalf("invalid plans emitted events: %d", len(events))
	}
	updated := strings.ReplaceAll(initialTestPlan, `"in_progress"`, `"completed"`)
	updated = strings.ReplaceAll(updated, `"pending"`, `"in_progress"`)
	if _, err := tool.Execute(context.Background(), json.RawMessage(updated)); err != nil {
		t.Fatal(err)
	}
	if events[0].Steps[0].Status != "in_progress" {
		t.Fatal("publishing an update mutated a previous event")
	}
}

func TestTaskPlanDoesNotCompletePendingGeneration(t *testing.T) {
	tool := BuildTaskProgressTool(func(string, any) {}).(*taskProgressTool)
	if _, err := tool.Execute(context.Background(), json.RawMessage(initialTestPlan)); err != nil {
		t.Fatal(err)
	}
	tool.generationWait = "等待你确认生成参数"
	completed := strings.ReplaceAll(strings.ReplaceAll(initialTestPlan, `"in_progress"`, `"completed"`), `"pending"`, `"completed"`)
	if _, err := tool.Execute(context.Background(), json.RawMessage(completed)); err == nil {
		t.Fatal("submission alone marked every step complete")
	}
	tool.finish(false)
	if tool.plan.Steps[0].Status != "blocked" || tool.plan.Steps[1].Status != "pending" || tool.plan.Summary != tool.generationWait {
		t.Fatalf("unfinished generation hidden: %#v", tool.plan)
	}
}

func TestPublicToolProgressUsesSafeChineseLabels(t *testing.T) {
	call := ToolCall{ID: "read-1"}
	call.Function.Name = "read_node"
	call.Function.Arguments = `{"node_id":"n1","reasoning":"INTERNAL_SECRET","prompt":"PRIVATE_PROMPT"}`
	for _, finished := range []bool{false, true} {
		progress := publicToolProgress(call, "PRIVATE_RESULT", nil, finished)
		raw, _ := json.Marshal(progress)
		if strings.Contains(string(raw), "PRIVATE") || strings.Contains(string(raw), "SECRET") || !strings.Contains(progress.Label, "读取引用节点信息") {
			t.Fatalf("unsafe public event: %s", raw)
		}
		if len(progress.NodeIDs) != 1 || progress.NodeIDs[0] != "n1" {
			t.Fatalf("missing referenced node: %+v", progress)
		}
	}
	for _, test := range []struct {
		name, result, label string
	}{
		{"run_node", `{"status":"awaiting_browser_confirmation"}`, "等待你确认生成参数"},
		{"run_node", `{"status":"submitted_to_browser"}`, "生成请求已交给浏览器，等待生成结果"},
		{"create_generation_batch", `{"requires_confirmation":true}`, "等待你确认生成参数"},
		{"create_generation_batch", `{"requires_confirmation":false}`, "生成请求已交给浏览器，等待生成结果"},
		{"ask_user", `ok`, "等待你确认任务要求"},
	} {
		call.Function.Name = test.name
		progress := publicToolProgress(call, test.result, nil, true)
		if progress.Status != "waiting" || progress.Label != test.label {
			t.Fatalf("wrong waiting status: %#v", progress)
		}
	}
	progress := publicToolProgress(call, "", errors.New("SECRET_ERROR"), true)
	if progress.Status != "failed" || strings.Contains(progress.Label, "SECRET") {
		t.Fatalf("unsafe failure: %#v", progress)
	}
}

func TestRunnerSimpleGreetingDoesNotForcePlanOrExposeReasoning(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		requests++
		var body struct {
			Messages []ChatMessage `json:"messages"`
		}
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		prompt := body.Messages[0].Content
		if strings.Contains(prompt, "Before taking any action") || !strings.Contains(prompt, "普通问候") {
			t.Errorf("wrong complexity guide: %s", prompt)
		}
		for _, message := range body.Messages {
			if strings.Contains(message.Content, "SECRET_CANVAS_ASSET") {
				t.Error("unrequested canvas content leaked into the model prompt")
			}
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"PRIVATE_ENGLISH_REASONING\"}}]}\n\n" +
			"data: {\"choices\":[{\"delta\":{\"content\":\"你好！\"}}]}\n\ndata: [DONE]\n\n"))
	}))
	defer server.Close()
	emit := func(event string, data any) {
		raw, _ := json.Marshal(data)
		if event == EventThought || event == EventThoughtDelta || event == EventPlan || event == EventProgress || strings.Contains(string(raw), "PRIVATE_ENGLISH_REASONING") {
			t.Errorf("greeting leaked reasoning or forced a task card: %s %s", event, raw)
		}
	}
	runner := Runner{LLM: &LLMClient{httpClient: server.Client()}, BaseURL: server.URL, APIKey: "test"}
	canvas := NewCanvasState([]CanvasNode{{ID: "private-node", Type: "textNode", Data: map[string]any{"content": "SECRET_CANVAS_ASSET"}}}, nil, emit)
	tools := append(BuildCanvasTools(canvas), BuildTaskProgressTool(emit))
	tools = append(tools, BuildAgentMediaTools(canvas, runner.LLM, []Endpoint{{BaseURL: server.URL}}, "test-model", "test-model")...)
	stats, err := runner.Run(context.Background(), RunInput{Model: "test-model", UserMessage: "你好", Strategy: "scripted", Tools: tools}, emit)
	if err != nil || requests != 1 || stats.FinalReply != "你好！" || stats.ToolCalls != 0 || stats.PublicProgress != nil {
		t.Fatalf("greeting should directly answer: requests=%d stats=%+v err=%v", requests, stats, err)
	}
}

func TestRunnerPersistsPendingPlanBeforeFinalMessage(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		w.Header().Set("Content-Type", "application/json")
		message := map[string]any{"content": "参数已准备好，请确认后生成。"}
		if requests == 1 {
			message = map[string]any{"reasoning_content": "PRIVATE_ENGLISH_REASONING", "tool_calls": []any{
				map[string]any{"id": "plan-1", "type": "function", "function": map[string]any{"name": "update_plan", "arguments": initialTestPlan}},
				map[string]any{"id": "generate-1", "type": "function", "function": map[string]any{"name": "run_node", "arguments": `{"node_id":"ready"}`}},
			}}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": message}}})
	}))
	defer server.Close()
	var events []string
	var plans []TaskPlan
	emit := func(event string, data any) {
		events = append(events, event)
		if event == EventPlan {
			plans = append(plans, data.(TaskPlan))
		}
		if event == EventThought || event == EventThoughtDelta {
			t.Errorf("private reasoning event: %s", event)
		}
	}
	state := NewCanvasState([]CanvasNode{{ID: "ready", Type: "videoNode", Data: map[string]any{"promptDraft": "测试视频"}}}, nil, emit)
	tools := append(BuildCanvasTools(state), BuildTaskProgressTool(emit))
	runner := Runner{LLM: &LLMClient{httpClient: server.Client()}, BaseURL: server.URL, APIKey: "test", MaxSteps: 3}
	stats, err := runner.Run(context.Background(), RunInput{Model: "test-model", UserMessage: "制作视频", Tools: tools}, emit)
	if err != nil {
		t.Fatal(err)
	}
	if len(plans) != 2 || plans[1].Summary != "等待你确认生成参数" || plans[1].Steps[0].Status != "blocked" {
		t.Fatalf("missing final waiting plan: %#v", plans)
	}
	if events[len(events)-1] != EventDone || events[len(events)-2] != EventMessage || events[len(events)-3] != EventProgress || events[len(events)-4] != EventPlan {
		t.Fatalf("final state must precede message/done: %v", events)
	}
	if len(stats.ToolTranscript) != 1 || stats.ToolTranscript[0].Name != "run_node" || stats.PublicProgress == nil || stats.PublicProgress.Progress.Status != "waiting" {
		t.Fatalf("wrong persisted state: %#v", stats)
	}
	log := FormatConversationToolLog(stats)
	publicJSON := strings.Split(log, publicProgressLogPrefix)[1]
	var restored TaskProgressSnapshot
	if err := json.Unmarshal([]byte(publicJSON), &restored); err != nil {
		t.Fatalf("public state truncated: %s", log)
	}
	if restored.Plan.Summary != "等待你确认生成参数" || strings.Contains(log, "PRIVATE_ENGLISH_REASONING") {
		t.Fatalf("bad history: %s", log)
	}
	prompt := BuildToolHistoryPrompt([]string{log}, 2)
	if strings.Contains(prompt, "public_progress") || strings.Contains(prompt, "steps") || !strings.Contains(prompt, "run_node") {
		t.Fatalf("public card polluted future model context: %s", prompt)
	}
	if BuildToolHistoryPrompt([]string{publicProgressLogPrefix + publicJSON}, 2) != "" {
		t.Fatal("progress-only log should not be reinjected")
	}
}

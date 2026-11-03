package application

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strings"
	"unicode"
)

const (
	EventPlan     = "plan"
	EventProgress = "progress"
)

// AgentTaskProgressGuide describes public work, not private model reasoning.
// A greeting needs neither a separate classification request nor a forced plan.
const AgentTaskProgressGuide = `【公开执行进度】
先在内部判断任务复杂度，不另调用模型分类、不展示判断过程。普通问候、闲聊、知识问答、明确的一步操作直接回答或执行，不创建计划、不调用无关工具、不主动复述画布或历史素材。
需要多步分析、多个资产协同、批量制作或跨节点修改时，先调用 update_plan 提供 2–6 个简短、可验收的中文执行步骤，再逐步执行。标题描述可见工作，例如“查找相关角色”“核对参考素材”“写入分镜节点”，不要写“思考用户意图”或展示推理、英文独白、系统指令。只有缺少关键对象或授权时才询问。
执行中在步骤状态真正变化时更新同一计划，保留稳定的步骤 id，最多一个 in_progress。不为每个工具再建立重复步骤。计划和简短进展使用中文，素材名、模型名可保留原文。不要输出思维链、内部推理或将它们放进 summary。
画布内容默认未读取：用户明确引用的节点优先，只调用完成请求必需的读取工具；引用不明时先查找，有歧义时确认。历史工具结果和聊天记忆不等于当前画布，不据此声称刚刚查看了素材。
只有收到真实工具结果才能完成步骤。run_node / create_generation_batch 的成功仅表示参数建议或请求交给浏览器：手动模式须写“等待你确认生成参数”，自动模式须写“等待生成结果”，不得写“视频/图片已生成”。没有结果就保留未完成步骤；不为让卡片全绿而虚报完成。结束时简短总结实际结果和剩余事项。`

type TaskPlanStep struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	Status string `json:"status"`
}

type TaskPlan struct {
	Steps   []TaskPlanStep `json:"steps"`
	Summary string         `json:"summary,omitempty"`
}

type TaskProgress struct {
	ID       string   `json:"id"`
	Phase    string   `json:"phase,omitempty"`
	Label    string   `json:"label"`
	ToolName string   `json:"tool_name,omitempty"`
	NodeIDs  []string `json:"node_ids,omitempty"`
	Status   string   `json:"status"`
}

// Only public work is persisted here: no reasoning, raw arguments or provider
// response bodies. Operational tool records remain in their separate section.
type TaskProgressSnapshot struct {
	Plan     *TaskPlan     `json:"plan,omitempty"`
	Progress *TaskProgress `json:"progress,omitempty"`
}

const publicProgressLogPrefix = "✓ public_progress({}) → "

func FormatConversationToolLog(stats RunStats) string {
	transcript := FormatToolTranscript(stats.ToolTranscript)
	if stats.PublicProgress == nil {
		return transcript
	}
	raw, err := json.Marshal(stats.PublicProgress)
	if err != nil {
		return transcript
	}
	return strings.TrimSpace(transcript + "\n" + publicProgressLogPrefix + string(raw))
}

func stripPublicProgressLog(log string) string {
	lines := strings.Split(log, "\n")
	kept := make([]string, 0, len(lines))
	for _, line := range lines {
		if !strings.HasPrefix(line, publicProgressLogPrefix) {
			kept = append(kept, line)
		}
	}
	return strings.TrimSpace(strings.Join(kept, "\n"))
}

type taskProgressTool struct {
	emit           func(string, any)
	plan           TaskPlan
	generationWait string
}

// BuildTaskProgressTool creates one controller per run. It never executes a
// canvas mutation or initiates a model/generation request.
func BuildTaskProgressTool(emit func(string, any)) Tool {
	return &taskProgressTool{emit: emit}
}

func (t *taskProgressTool) Name() string { return "update_plan" }
func (t *taskProgressTool) Description() string {
	return "复杂任务执行前公布简短中文步骤；工作推进时更新同一计划。普通聊天或一步操作不用。只记录用户可见工作及真实状态，不包含内部推理。生成提交不等于生成完成。"
}
func (t *taskProgressTool) Parameters() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"steps":{"type":"array","minItems":2,"maxItems":6,"items":{"type":"object","properties":{"id":{"type":"string","pattern":"^[a-zA-Z0-9_-]{1,48}$"},"title":{"type":"string","minLength":1,"maxLength":40,"description":"简短中文行动标题，不是推理独白"},"status":{"type":"string","enum":["pending","in_progress","completed","blocked"]}},"required":["id","title","status"],"additionalProperties":false}},"summary":{"type":"string","maxLength":120,"description":"可选的中文进展或等待原因，不含内部推理"}},"required":["steps"],"additionalProperties":false}`)
}

var taskStepIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,48}$`)

func validPublicTaskText(value string, limit int) bool {
	if value == "" || len([]rune(value)) > limit || strings.ContainsAny(value, "\r\n\x00") {
		return false
	}
	return strings.ContainsFunc(value, func(r rune) bool { return unicode.Is(unicode.Han, r) })
}

func (t *taskProgressTool) Execute(_ context.Context, args json.RawMessage) (string, error) {
	var next TaskPlan
	decoder := json.NewDecoder(strings.NewReader(string(args)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&next); err != nil {
		return "", fmt.Errorf("执行计划格式无效，请只填写 steps 和可选 summary")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return "", fmt.Errorf("执行计划只能包含一个完整的对象")
	}
	if len(next.Steps) < 2 || len(next.Steps) > 6 {
		return "", fmt.Errorf("复杂任务计划需要 2–6 个步骤；简单请求无需计划")
	}
	next.Summary = strings.TrimSpace(next.Summary)
	if next.Summary != "" && !validPublicTaskText(next.Summary, 120) {
		return "", fmt.Errorf("计划摘要需为 120 字以内的单行中文进展，不包含内部推理")
	}
	seen := make(map[string]bool, len(next.Steps))
	running, completed := 0, 0
	for index := range next.Steps {
		step := &next.Steps[index]
		step.Title = strings.TrimSpace(step.Title)
		if !taskStepIDPattern.MatchString(step.ID) || seen[step.ID] {
			return "", fmt.Errorf("执行步骤需要互不重复的简短 id")
		}
		seen[step.ID] = true
		if !validPublicTaskText(step.Title, 40) {
			return "", fmt.Errorf("步骤标题需为 40 字以内的单行中文行动，不包含内部推理")
		}
		switch step.Status {
		case "pending", "blocked":
		case "in_progress":
			running++
		case "completed":
			completed++
		default:
			return "", fmt.Errorf("步骤状态只支持 pending、in_progress、completed、blocked")
		}
	}
	if running > 1 {
		return "", fmt.Errorf("同一时间只保留一个正在执行的步骤")
	}
	if t.generationWait != "" && completed == len(next.Steps) {
		return "", fmt.Errorf("%s；仅收到提交回执，不能将计划全部标为完成", t.generationWait)
	}
	for _, previous := range t.plan.Steps {
		if !seen[previous.ID] {
			return "", fmt.Errorf("更新计划须保留已有步骤 id，不能隐藏尚未完成的步骤")
		}
	}
	t.plan = next
	t.publish()
	return `{"ok":true,"note":"公开执行计划已更新；继续按实际结果推进，不展示内部推理。"}`, nil
}

func (t *taskProgressTool) publish() {
	if t.emit == nil {
		return
	}
	// Emit a snapshot: subsequent plan changes must not mutate queued events.
	copy := t.plan
	copy.Steps = append([]TaskPlanStep(nil), copy.Steps...)
	t.emit(EventPlan, copy)
}

func (t *taskProgressTool) finish(failed bool) {
	if len(t.plan.Steps) == 0 {
		return
	}
	changed, allComplete := false, true
	for i := range t.plan.Steps {
		if t.plan.Steps[i].Status != "completed" {
			allComplete = false
		}
		if t.plan.Steps[i].Status == "in_progress" {
			t.plan.Steps[i].Status = "blocked"
			changed = true
		}
	}
	if t.generationWait != "" {
		if allComplete {
			t.plan.Steps[len(t.plan.Steps)-1].Status = "blocked"
		}
		t.plan.Summary = t.generationWait
		changed = true
	} else if failed && !allComplete {
		t.plan.Summary = "本次执行中断，已完成的步骤保留"
		changed = true
	} else if changed {
		t.plan.Summary = "本轮已结束，仍有步骤未完成"
	}
	if changed {
		t.publish()
	}
}

func progressTool(tools []Tool) *taskProgressTool {
	for _, tool := range tools {
		if progress, ok := tool.(*taskProgressTool); ok {
			return progress
		}
	}
	return nil
}

// A safe allowlist avoids reflecting model-written arguments/results or private
// reasoning in public progress. Unknown skills deliberately use a generic label.
func publicToolProgress(tc ToolCall, result string, toolErr error, finished bool) TaskProgress {
	labels := map[string]string{
		"list_nodes": "读取节点列表", "list_groups": "读取分组列表", "read_group": "读取分组信息", "find_nodes": "查找相关节点",
		"read_node": "读取引用节点信息", "read_nodes": "读取相关节点信息", "get_subgraph": "检查节点连接关系",
		"get_canvas_delta": "核对画布变化", "analyze_image": "分析参考图片", "analyze_video": "分析参考视频",
		"create_node": "创建画布节点", "set_prompt": "写入节点提示词", "connect_nodes": "连接相关素材",
		"layout_nodes": "整理画布布局", "move_node": "调整节点位置", "create_group": "整理节点分组",
		"delete_node": "删除指定节点", "run_node": "准备生成请求", "create_generation_batch": "准备批量生成请求",
		"ask_user": "确认任务要求", "deep_retrieve": "检索相关记忆", "save_memory": "保存任务记忆",
	}
	label := labels[tc.Function.Name]
	if label == "" {
		label = "执行任务工具"
	}
	progress := TaskProgress{ID: tc.ID, Phase: "tool", ToolName: tc.Function.Name, Label: "正在" + label, Status: "running"}
	var args struct {
		NodeID  string   `json:"node_id"`
		NodeIDs []string `json:"node_ids"`
	}
	if json.Unmarshal([]byte(tc.Function.Arguments), &args) == nil {
		if args.NodeID != "" {
			args.NodeIDs = append([]string{args.NodeID}, args.NodeIDs...)
		}
		for _, id := range args.NodeIDs {
			if len(id) <= 128 && !strings.ContainsAny(id, "\r\n") && len(progress.NodeIDs) < 50 {
				progress.NodeIDs = append(progress.NodeIDs, id)
			}
		}
	}
	if !finished {
		return progress
	}
	if toolErr != nil {
		progress.Status, progress.Label = "failed", label+"未完成"
		return progress
	}
	progress.Status, progress.Label = "completed", "已完成："+label
	if tc.Function.Name == "ask_user" {
		progress.Status, progress.Label = "waiting", "等待你确认任务要求"
	}
	if tc.Function.Name == "run_node" || tc.Function.Name == "create_generation_batch" {
		var payload struct {
			Status               string `json:"status"`
			RequiresConfirmation bool   `json:"requires_confirmation"`
		}
		_ = json.Unmarshal([]byte(result), &payload)
		progress.Status, progress.Label = "waiting", "生成请求已交给浏览器，等待生成结果"
		if payload.RequiresConfirmation || payload.Status == "awaiting_browser_confirmation" {
			progress.Label = "等待你确认生成参数"
		}
	}
	return progress
}

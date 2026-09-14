package interfaces

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"ccy-canvas/backend/internal/platform/database/sqlc"
	"ccy-canvas/backend/internal/shared/apperror"
	skillsapp "ccy-canvas/backend/internal/skills/application"
)

// harness 桥接：把智能体任务交给 Node 侧的 agent bridge（DeepSeek Harness）。
//
// 为什么走 HTTP 而不是在 Go 里直接管 dsh 进程：
//   - DSH 本身就是 Node 应用，自己的 SDK/JSON-RPC/MCP 生态都在 Node 侧；
//   - 事件映射是最需要反复调整的部分（实测踩到 done/canvas_patch 顺序、事件保序两个坑），
//     放在 Node 侧改一行就能重启验证，不必重编译 Go 二进制。
//
// 契约边界（重要）：
//   - 鉴权、积分、会话持久化、画布权威状态仍然在 Go；
//   - 桥只负责"跑 DSH + 翻译事件"；
//   - 桥的 SSE 帧格式与本地 agent_job_handler 完全一致，所以这里只做转存。
//
// 已知限制（来自 DSH SDK 协议本身，不是实现缺陷）：
//   - 协议没有 per-prompt 取消，所以任务一旦发出，Go 侧取消只能停止观察；
//     真要停必须由桥关掉该会话的 runtime（会一并丢掉该会话上下文）。

const (
	// harnessBridgeURLEnv 指定桥的地址，例如 http://127.0.0.1:39300。
	// 未设置时 harness 后端视为不可用（而不是静默回退到本地 runner ——
	// 静默回退会让"为什么 agent 行为变了"变得无法排查）。
	harnessBridgeURLEnv = "CCY_HARNESS_BRIDGE_URL"

	// harnessBridgeURLDefault 与 scripts/agent-bridge/server.mjs 的默认端口一致。
	harnessBridgeURLDefault = "http://127.0.0.1:39300"

	// harnessSubmitTimeout 只约束"建任务"这一步；事件流是长连接，不能设整体超时。
	harnessSubmitTimeout = 15 * time.Second

	// agentMetadataRuntimeKey 是 agents.metadata 里选择后端的键，值为 "harness" 时
	// 该智能体走桥接（DeepSeek Harness）。
	//
	// 为什么用 metadata 而不是新加列：
	//   - agents.strategy 已有 CHECK 约束（只允许 reactive/scripted），塞不进新值；
	//   - agents.runtime 的语义是"角色/预置"（scriptAgent、productionAgent 等），
	//     被种子 diff 逻辑使用，复用会破坏幂等；
	//   - 加列要同时改迁移 + schema + 重新生成 sqlc，风险与成本都明显更高。
	// metadata 是现成的扩展点，先用它跑通，等验证稳定再升级成正式列（可写管理端点）。
	agentMetadataRuntimeKey = "agentRuntime"
)

// agentUsesHarness 判断该智能体是否走桥接后端。
func agentUsesHarness(agent sqlc.Agent) bool {
	if len(agent.Metadata) == 0 {
		return false
	}
	var meta map[string]any
	if err := json.Unmarshal(agent.Metadata, &meta); err != nil {
		return false
	}
	value, _ := meta[agentMetadataRuntimeKey].(string)
	return strings.EqualFold(strings.TrimSpace(value), "harness")
}

// harnessEvent 是桥 SSE 的一帧。Type 对应 ccy 的 AgentSSEEventType。
type harnessEvent struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data"`
}

func harnessBridgeURL() string {
	if value := strings.TrimSpace(os.Getenv(harnessBridgeURLEnv)); value != "" {
		return strings.TrimSuffix(value, "/")
	}
	return harnessBridgeURLDefault
}

// truncateRunes 按 rune 截断（防切碎中文），与 application 包内的同名工具保持一致的语义。
func truncateRunes(s string, max int) string {
	s = strings.TrimSpace(s)
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + "…"
}

// executeHarnessAgentJob 把一个已持久化的 agent job 交给桥执行，并把桥的事件
// 转存进本地事件表 —— 这样前端的中断续传、回放、watchdog 逻辑全部照旧。
//
// 返回 error 仅在"任务本身失败"时非 nil（对应 job 变 error 态）；管道层面的
// 失败也走同一条路，保证 job 不会悬在 running。
func (rt *AgentRunRouter) executeHarnessAgentJob(
	ctx context.Context,
	job sqlc.AgentRunJob,
	agent sqlc.Agent,
	conversation sqlc.AgentConversation,
	req agentRunRequest,
	emit func(string, any),
) error {
	startedAt := time.Now()
	baseURL := harnessBridgeURL()

	// fail 统一：先落一条用户可读的 error 事件（否则前端只看到 job 变 error，
	// 不知道原因），再写终态，避免 job 悬在 running。
	//
	// 同时把**真实原因**写进服务端日志：早期只留泛化文案（"服务暂时不可用"），
	// 导致前后端都无从排查（实测踩过：一个 marshal 失败在日志里完全看不见）。
	fail := func(publicMessage string, cause error) error {
		log.Printf("[harness] job=%s 失败: %s | cause=%v", formatUUID(job.ID), publicMessage, cause)
		runErr := apperror.Wrap(apperror.CodeUpstreamUnavailable, publicMessage, cause)
		message := apperror.PublicMessage(runErr)
		emit(skillsapp.EventError, map[string]string{"message": message})
		return rt.finishJob(ctx, job.ID, skillsapp.RunStats{Steps: 1}, runErr, startedAt, nil)
	}

	// 斜杠技能：/技能名 必须在分流**之前**解析（本地 runner 是在自己的路径里做的）。
	// 不解析的话，DSH 收到的是字面 "/rewrite 正文"，技能模板完全没生效。
	// 复用同一个解析器，保证两条路径的技能语义一致（含"参考画布节点"前导的处理）。
	boundSkills := skillsapp.LoadBoundSkills(ctx, rt.q, agent.SkillIDs)
	resolvedMessage, invokedSkill := skillsapp.ResolveSlashSkillMessage(req.Message, boundSkills)
	if invokedSkill != "" {
		emit(skillsapp.EventThought, map[string]string{"content": "已加载技能：" + invokedSkill})
	}

	// 技能导出：把绑定技能交给桥，由桥写进会话工作区的 .dsh/skills，
	// 让 DSH 的 skill 插件把它们变成"模型可发现的目录 + 可按需加载的方法论"
	// （等价于本地 runner 的技能工具，但用的是 DSH 自己的渐进披露）。
	// 只导 kind=prompt 且有正文的：code 类技能是给工具用的，不是给模型读的方法论。
	exportedSkills := make([]map[string]string, 0, len(boundSkills))
	for _, skill := range boundSkills {
		if !skill.Enabled || !strings.EqualFold(strings.TrimSpace(skill.Kind), "prompt") {
			continue
		}
		content := skillsapp.PromptSkillContent(skill)
		if content == "" {
			continue
		}
		exportedSkills = append(exportedSkills, map[string]string{
			"name":        strings.TrimSpace(skill.Name),
			"description": strings.TrimSpace(skill.Description),
			"content":     content,
		})
	}

	// 桥用 conversation_id 作为 DSH 的 sessionId：一个会话对应一个常驻 runtime，
	// 多轮上下文（含 DSH 自己的压缩与记忆）由此保持连续。
	payload, err := json.Marshal(map[string]any{
		"message":         resolvedMessage,
		"conversation_id": formatUUID(conversation.ID),
		"agent_id":        formatUUID(job.AgentID),
		"skills":          exportedSkills,
		// 画布快照：桥把它 seed 进会话工作区，MCP 画布工具才看得到用户的真实画布。
		// 不传的话 agent 看到的是空画布（实测：会回答"当前画布是空的"）。
		"nodes":           req.Nodes,
		"edges":           req.Edges,
		"groups":          req.Groups,
		"canvas_revision": req.CanvasRevision,
	})
	// 把 payload 大小也记下来：marshal 失败时这是关键线索（比如某字段不可序列化）。
	if err != nil {
		log.Printf("[harness] job=%s 编码桥接请求失败: %v (nodes=%d edges=%d groups=%d rev=%d)",
			formatUUID(job.ID), err, len(req.Nodes), len(req.Edges), len(req.Groups), req.CanvasRevision)
		return fail("无法编码桥接请求", err)
	}
	log.Printf("[harness] job=%s → 桥: bytes=%d nodes=%d edges=%d groups=%d rev=%d",
		formatUUID(job.ID), len(payload), len(req.Nodes), len(req.Edges), len(req.Groups), req.CanvasRevision)
	submitCtx, cancelSubmit := context.WithTimeout(ctx, harnessSubmitTimeout)
	defer cancelSubmit()
	submitReq, err := http.NewRequestWithContext(submitCtx, http.MethodPost,
		baseURL+"/api/app/agents/"+formatUUID(job.AgentID)+"/jobs", bytes.NewReader(payload))
	if err != nil {
		return fail("无法创建桥接请求", err)
	}
	submitReq.Header.Set("Content-Type", "application/json")

	response, err := http.DefaultClient.Do(submitReq)
	if err != nil {
		return fail("智能体桥接服务不可用（请确认 agent bridge 已启动）", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusAccepted && response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 512))
		return fail("智能体桥接服务拒绝了任务",
			fmt.Errorf("HTTP %d: %s", response.StatusCode, strings.TrimSpace(string(body))))
	}
	var accepted struct {
		JobID string `json:"job_id"`
	}
	if err := json.NewDecoder(response.Body).Decode(&accepted); err != nil || accepted.JobID == "" {
		return fail("智能体桥接服务返回了无效的任务号", err)
	}

	// 事件流：不能设整体超时（一轮可能跑很久），用请求上下文控制生命周期。
	streamReq, err := http.NewRequestWithContext(ctx, http.MethodGet,
		baseURL+"/api/app/agent-jobs/"+accepted.JobID+"/events?after=0", nil)
	if err != nil {
		return fail("无法创建事件流请求", err)
	}
	streamReq.Header.Set("Accept", "text/event-stream")
	// 事件流是长连接，不能设整体超时；生命周期由请求上下文控制。
	streamClient := &http.Client{}
	streamResponse, err := streamClient.Do(streamReq)
	if err != nil {
		return fail("无法连接智能体事件流", err)
	}
	defer streamResponse.Body.Close()
	if streamResponse.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(streamResponse.Body, 512))
		return fail("智能体事件流不可用",
			fmt.Errorf("HTTP %d: %s", streamResponse.StatusCode, strings.TrimSpace(string(body))))
	}

	stats := skillsapp.RunStats{}
	toolCalls := 0
	var transcript []skillsapp.ToolTranscriptEntry
	// 画布补丁延后到终态事件之前统一落库：前端一收到 done 就停止处理后续事件，
	// 顺序错了画布变更会被静默丢弃（桥侧已经踩过这个坑）。
	var pendingPatches []json.RawMessage

	var streamErr error
	terminalSeen := false

	err = readHarnessSSE(streamResponse.Body, func(event harnessEvent) {
		if terminalSeen {
			return
		}
		switch event.Type {
		case skillsapp.EventCanvasPatch:
			pendingPatches = append(pendingPatches, event.Data)
			return
		case skillsapp.EventToolCall:
			toolCalls++
			var call struct {
				Name      string `json:"name"`
				Arguments string `json:"arguments"`
			}
			if err := json.Unmarshal(event.Data, &call); err == nil {
				transcript = append(transcript, skillsapp.ToolTranscriptEntry{
					Name: call.Name,
					Args: truncateRunes(call.Arguments, 200),
				})
			}
			emit(event.Type, json.RawMessage(event.Data))
			return
		case skillsapp.EventToolResult:
			var result struct {
				OK     bool   `json:"ok"`
				Result string `json:"result"`
				Error  string `json:"error"`
			}
			if err := json.Unmarshal(event.Data, &result); err == nil && len(transcript) > 0 {
				last := &transcript[len(transcript)-1]
				last.OK = result.OK
				output := result.Result
				if !result.OK {
					output = result.Error
				}
				last.Result = truncateRunes(output, 300)
			}
			emit(event.Type, json.RawMessage(event.Data))
			return
		case skillsapp.EventMessage:
			var message struct {
				Content string `json:"content"`
			}
			if err := json.Unmarshal(event.Data, &message); err == nil {
				stats.FinalReply = message.Content
			}
			emit(event.Type, json.RawMessage(event.Data))
			return
		case skillsapp.EventUsage:
			emit(event.Type, json.RawMessage(event.Data))
			return
		case skillsapp.EventDone:
			// done 放在最后落库：前端一收到 done 就停止处理后续事件，
			// 所以画布补丁必须排在它之前（见下方 pendingPatches 的处理）。
			terminalSeen = true
			return
		case skillsapp.EventError:
			var failure struct {
				Message string `json:"message"`
			}
			if err := json.Unmarshal(event.Data, &failure); err == nil {
				streamErr = errors.New(failure.Message)
			} else {
				streamErr = errors.New("智能体执行失败")
			}
			terminalSeen = true
			return
		default:
			emit(event.Type, json.RawMessage(event.Data))
		}
	})
	if err != nil && streamErr == nil {
		streamErr = err
	}

	stats.ToolCalls = toolCalls
	stats.ToolTranscript = transcript
	if stats.Steps == 0 {
		stats.Steps = 1
	}

	// 先把画布补丁落库（顺序必须在终态事件之前）。
	for _, patch := range pendingPatches {
		emit(skillsapp.EventCanvasPatch, json.RawMessage(patch))
	}

	if streamErr != nil {
		emit(skillsapp.EventError, map[string]string{"message": streamErr.Error()})
		return rt.finishJob(ctx, job.ID, stats, streamErr, startedAt, nil)
	}

	// 与本地 runner 一致：会话消息 / tool_log / 记忆 / 标题都必须在成功后落库，
	// 否则前端历史与跨轮上下文都会断。
	persistCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := rt.persistSuccessfulTurn(persistCtx, job, agent, conversation, req, stats); err != nil {
		return rt.finishJob(ctx, job.ID, stats, apperror.New(apperror.CodeConflict, "执行结束但会话保存失败或已取消；不会自动重放，请检查任务记录"), startedAt, nil)
	}

	// done 事件带 steps：前端会用它显示步数（本地 runner 也是这个载荷）。
	return rt.finishJob(ctx, job.ID, stats, nil, startedAt, map[string]int{"steps": stats.Steps})
}

// readHarnessSSE 解析桥的 SSE 流（`id: N` / `event: NAME` / `data: JSON` + 空行分隔）。
//
// 用 bufio.Scanner 提升缓冲区上限：单条事件可能很长（工具返回值、长回复），
// 默认 64KB 会直接报错截断。
func readHarnessSSE(body io.Reader, onEvent func(harnessEvent)) error {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)

	var eventName string
	var dataLines []string

	flush := func() {
		if eventName == "" {
			dataLines = dataLines[:0]
			return
		}
		raw := strings.Join(dataLines, "")
		onEvent(harnessEvent{Type: eventName, Data: json.RawMessage(raw)})
		eventName = ""
		dataLines = dataLines[:0]
	}

	for scanner.Scan() {
		line := strings.TrimRight(scanner.Text(), "\r")
		switch {
		case line == "":
			flush()
		case strings.HasPrefix(line, ":"):
			// 注释/心跳（桥会发 `: connected`），忽略。
		case strings.HasPrefix(line, "event:"):
			eventName = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		case strings.HasPrefix(line, "data:"):
			dataLines = append(dataLines, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		case strings.HasPrefix(line, "id:"):
			// 事件序号由桥侧维护；Go 侧不需要续传游标（重连由前端驱动）。
		}
	}
	flush()
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("读取智能体事件流失败: %w", err)
	}
	return nil
}

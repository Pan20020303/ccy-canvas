package application

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// Runner is the agent loop. Conceptually:
//
//	while step < maxSteps:
//	  resp = llm.chat(messages, tools)
//	  if no tool calls:
//	    emit("message", resp.content); return
//	  for each tool_call:
//	    emit("tool_call"); result = tool.execute(); emit("tool_result")
//	    messages += {role:"tool", tool_call_id, content: result}
//
// Mirrors the OpenAI Agents SDK without the multi-agent / handoff machinery.
//
// Strategy:
//
//	"reactive" — the default tool-calling loop above (LLM decides each step).
//	"scripted" — same loop but prefaces with a one-shot "make a plan first"
//	             turn that's emitted as a `thought` event, giving the user a
//	             preview of intent before any tool runs.
type Runner struct {
	LLM *LLMClient
	// Endpoints is the upstream provider list that serves the model.
	// The catalog now resolves a single preferred endpoint for each model so
	// we do not automatically switch between vendors mid-run.
	// BaseURL/APIKey are kept for backward compatibility; if Endpoints is empty
	// they're synthesized into a single-element list.
	Endpoints []Endpoint
	// Health is the optional channel-health reporter. When set, each endpoint
	// success/failure is recorded so future requests can avoid sick channels.
	Health    ChannelHealthReporter
	BaseURL   string
	APIKey    string
	MaxSteps  int
	ModelHint string
}

// RunInput carries everything Run needs that isn't on the Runner itself.
type RunInput struct {
	SystemPrompt string
	Model        string
	UserMessage  string
	History      []ChatMessage
	Tools        []Tool
	Strategy     string // "reactive" (default) or "scripted"
}

// RunStats summarizes what happened during the run. Used by the handler to
// write an agent_runs audit row.
type RunStats struct {
	Steps      int
	ToolCalls  int
	FinalReply string
	// Usage 是最后一轮 LLM 调用的 token 用量。prompt+completion ≈ 本轮结束后的
	// 上下文规模(下一轮的 prompt 大致就是它)——驱动前端的上下文窗口计量表。
	Usage Usage
	// ToolTranscript 是本次运行的紧凑工具记录(名称/参数/结果,均截断)。
	// handler 把它持久化为 role="tool_log" 会话消息,下一轮注入 system prompt,
	// 让后续轮次"记得"之前执行过什么 —— 跨轮工具历史(长任务连续性)。
	ToolTranscript []ToolTranscriptEntry
}

// ToolTranscriptEntry 单条工具执行摘要。
type ToolTranscriptEntry struct {
	Name   string
	Args   string
	OK     bool
	Result string
}

// Run executes the agent loop, streaming events via emit.
func (r *Runner) Run(ctx context.Context, in RunInput, emit func(string, any)) (RunStats, error) {
	stats := RunStats{}
	max := r.MaxSteps
	if max == 0 {
		max = 12
	}

	model := in.Model
	if model == "" {
		model = r.ModelHint
	}
	if model == "" {
		return stats, errors.New("no model specified for agent")
	}

	systemPrompt := in.SystemPrompt
	if in.Strategy == "scripted" {
		systemPrompt += "\n\nBefore taking any action, briefly describe your plan in 2-3 sentences. Then execute it with tool calls."
	}

	messages := []ChatMessage{
		{Role: "system", Content: systemPrompt},
	}
	messages = append(messages, sanitizeConversationHistory(in.History)...)
	messages = append(messages, ChatMessage{Role: "user", Content: in.UserMessage})
	toolDefs := ToOpenAIDefs(in.Tools)

	for step := 0; step < max; step++ {
		select {
		case <-ctx.Done():
			return stats, ctx.Err()
		default:
		}
		stats.Steps = step + 1

		// Stream the upstream response: every text delta is forwarded as a
		// `message_delta` event in real time. Tool-call fragments accumulate
		// internally and are returned in `resp` after the stream finishes.
		endpoints := r.Endpoints
		if len(endpoints) == 0 {
			// Backward compat: legacy single-endpoint path.
			endpoints = []Endpoint{{BaseURL: r.BaseURL, APIKey: r.APIKey}}
		}
		var streamedAnyText bool
		resp, err := r.LLM.ChatStreamMulti(ctx, endpoints, model, messages, toolDefs, func(delta string) {
			if delta == "" {
				return
			}
			streamedAnyText = true
			emit("message_delta", map[string]string{"delta": delta})
		}, r.Health)
		if err != nil {
			emit(EventError, map[string]string{"message": err.Error()})
			return stats, err
		}

		// 上下文计量:每轮把网关返回的 usage 推给前端(不支持 include_usage 的
		// 网关返回 0,前端计量表隐藏)。取最近一轮而非累加 —— prompt_tokens 已
		// 包含全部历史,累加会重复计。
		if resp.Usage.TotalTokens > 0 {
			stats.Usage = resp.Usage
			emit(EventUsage, map[string]int{
				"prompt_tokens":     resp.Usage.PromptTokens,
				"completion_tokens": resp.Usage.CompletionTokens,
				"total_tokens":      resp.Usage.TotalTokens,
			})
		}

		if len(resp.ToolCalls) == 0 {
			// No tools requested → the streamed text is the final reply.
			// If the relay didn't actually stream and onDelta never fired,
			// fall back to a one-shot message event so the UI sees something.
			if !streamedAnyText && resp.Content != "" {
				emit("message_delta", map[string]string{"delta": resp.Content})
			}
			emit(EventMessage, map[string]string{"content": resp.Content})
			stats.FinalReply = resp.Content
			emit(EventDone, map[string]int{"steps": step + 1})
			return stats, nil
		}

		// Tool calls coming next. If the model also wrote some narrative text
		// before requesting tools, surface it as a `thought` so the user sees
		// the rationale. The streamed deltas have already painted it into the
		// UI as a partial assistant bubble; emitting `thought` is for the
		// timeline view.
		if resp.Content != "" {
			emit(EventThought, map[string]string{"content": resp.Content})
		}

		messages = append(messages, ChatMessage{
			Role:      "assistant",
			Content:   resp.Content,
			ToolCalls: resp.ToolCalls,
		})

		for _, tc := range resp.ToolCalls {
			stats.ToolCalls++
			emit(EventToolCall, map[string]any{
				"id":        tc.ID,
				"name":      tc.Function.Name,
				"arguments": tc.Function.Arguments,
			})

			tool := findTool(in.Tools, tc.Function.Name)
			var (
				result  string
				toolErr error
			)
			if tool == nil {
				toolErr = fmt.Errorf("tool %q not available", tc.Function.Name)
			} else {
				result, toolErr = tool.Execute(ctx, json.RawMessage(tc.Function.Arguments))
			}

			emitResult := map[string]any{"id": tc.ID, "name": tc.Function.Name}
			if toolErr != nil {
				result = fmt.Sprintf(`{"error":%q}`, toolErr.Error())
				emitResult["ok"] = false
				emitResult["error"] = toolErr.Error()
			} else {
				emitResult["ok"] = true
				emitResult["result"] = result
			}
			emit(EventToolResult, emitResult)
			stats.ToolTranscript = append(stats.ToolTranscript, ToolTranscriptEntry{
				Name:   tc.Function.Name,
				Args:   truncateForTranscript(tc.Function.Arguments, 200),
				OK:     toolErr == nil,
				Result: truncateForTranscript(result, 300),
			})

			messages = append(messages, ChatMessage{
				Role:       "tool",
				ToolCallID: tc.ID,
				Name:       tc.Function.Name,
				Content:    result,
			})
		}
	}

	emit(EventError, map[string]string{"message": "Max steps exceeded"})
	return stats, errors.New("max steps exceeded")
}

func sanitizeConversationHistory(history []ChatMessage) []ChatMessage {
	if len(history) == 0 {
		return nil
	}

	sanitized := make([]ChatMessage, 0, len(history))
	for _, message := range history {
		if message.Role != "user" && message.Role != "assistant" {
			continue
		}
		if message.Content == "" {
			continue
		}
		sanitized = append(sanitized, ChatMessage{
			Role:    message.Role,
			Content: message.Content,
		})
	}
	return sanitized
}

// ─── 跨轮工具历史(P3)────────────────────────────────────────────────────────
// 单轮内 messages 保有完整 tool_calls/tool 结果,但跨轮持久化只存 user/最终回复,
// 下一轮完全不知道之前执行过什么。这里把每轮工具记录压缩成紧凑文本持久化
// (role="tool_log" 会话消息),下一轮以 system prompt 注入 —— 不进 messages,
// 避免 OpenAI tool 消息的严格配对校验,同时 token 预算可控。

// truncateForTranscript 按 rune 截断(防切碎中文),超长加省略号。
func truncateForTranscript(s string, max int) string {
	s = strings.TrimSpace(s)
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + "…"
}

// FormatToolTranscript 把一轮的工具记录压成多行紧凑文本(持久化格式):
//
//	✓ list_nodes({}) → [{"id":"n1"...
//	✕ run_node({"node_id":"x"}) → {"error":"..."}
func FormatToolTranscript(entries []ToolTranscriptEntry) string {
	if len(entries) == 0 {
		return ""
	}
	var b strings.Builder
	for i, e := range entries {
		if i > 0 {
			b.WriteString("\n")
		}
		mark := "✓"
		if !e.OK {
			mark = "✕"
		}
		fmt.Fprintf(&b, "%s %s(%s) → %s", mark, e.Name, e.Args, e.Result)
	}
	return b.String()
}

// BuildToolHistoryPrompt 把最近几条 tool_log(每条 = 一轮的紧凑记录,时间升序)
// 组装成注入 system prompt 的段落。maxLogs 限制轮数、总长再兜底截断。
func BuildToolHistoryPrompt(logs []string, maxLogs int) string {
	if len(logs) == 0 {
		return ""
	}
	if maxLogs > 0 && len(logs) > maxLogs {
		logs = logs[len(logs)-maxLogs:]
	}
	joined := strings.Join(logs, "\n---\n")
	joined = truncateForTranscript(joined, 4000)
	return "【最近工具执行记录】\n以下是你在本会话之前轮次里实际执行过的工具及结果(✓成功/✕失败),延续任务时不要重复已完成的操作:\n" + joined
}

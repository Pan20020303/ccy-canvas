package application

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
)

// Runner is the agent loop. Conceptually:
//
//   while step < maxSteps:
//     resp = llm.chat(messages, tools)
//     if no tool calls:
//       emit("message", resp.content); return
//     for each tool_call:
//       emit("tool_call"); result = tool.execute(); emit("tool_result")
//       messages += {role:"tool", tool_call_id, content: result}
//
// Mirrors the OpenAI Agents SDK without the multi-agent / handoff machinery.
//
// Strategy:
//   "reactive" — the default tool-calling loop above (LLM decides each step).
//   "scripted" — same loop but prefaces with a one-shot "make a plan first"
//                turn that's emitted as a `thought` event, giving the user a
//                preview of intent before any tool runs.
type Runner struct {
	LLM      *LLMClient
	// Endpoints is the ordered list of upstream providers that serve the model.
	// Each is tried in turn — see LLMClient.ChatStreamMulti for fallback rules.
	// BaseURL/APIKey are kept for backward compatibility; if Endpoints is empty
	// they're synthesized into a single-element list.
	Endpoints []Endpoint
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
		})
		if err != nil {
			emit(EventError, map[string]string{"message": err.Error()})
			return stats, err
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


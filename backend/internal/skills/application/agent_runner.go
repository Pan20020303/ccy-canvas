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
	LLM       *LLMClient
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
		{Role: "user", Content: in.UserMessage},
	}
	toolDefs := ToOpenAIDefs(in.Tools)

	for step := 0; step < max; step++ {
		select {
		case <-ctx.Done():
			return stats, ctx.Err()
		default:
		}
		stats.Steps = step + 1

		resp, err := r.LLM.Chat(ctx, r.BaseURL, r.APIKey, model, messages, toolDefs)
		if err != nil {
			emit(EventError, map[string]string{"message": err.Error()})
			return stats, err
		}

		if resp.Content != "" && len(resp.ToolCalls) > 0 {
			emit(EventThought, map[string]string{"content": resp.Content})
		}

		if len(resp.ToolCalls) == 0 {
			// Stream the final reply token-by-token (simulated chunking for
			// the case where the upstream doesn't natively stream — gives the
			// UI a nice typing animation).
			emitStreamedReply(resp.Content, emit)
			stats.FinalReply = resp.Content
			emit(EventDone, map[string]int{"steps": step + 1})
			return stats, nil
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

// emitStreamedReply chunks the final reply into ~25-char fragments and emits
// `message_delta` events, then a final `message` with the full text. The UI
// can render the deltas live and then snap to the full message for cleanup.
func emitStreamedReply(content string, emit func(string, any)) {
	if content == "" {
		emit(EventMessage, map[string]string{"content": ""})
		return
	}
	const chunkSize = 24
	runes := []rune(content)
	for i := 0; i < len(runes); i += chunkSize {
		end := i + chunkSize
		if end > len(runes) {
			end = len(runes)
		}
		emit("message_delta", map[string]string{"delta": string(runes[i:end])})
	}
	emit(EventMessage, map[string]string{"content": content})
}

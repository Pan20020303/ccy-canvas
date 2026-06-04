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
type Runner struct {
	LLM       *LLMClient
	BaseURL   string // OpenAI-style endpoint, e.g. https://api.openai.com/v1
	APIKey    string
	MaxSteps  int    // safety cap; default 12
	ModelHint string // fallback if agent doesn't specify one
}

// RunInput carries everything Run needs that isn't on the Runner itself.
type RunInput struct {
	SystemPrompt string
	Model        string
	UserMessage  string
	Tools        []Tool
}

// Run executes the agent loop, streaming events via emit.
func (r *Runner) Run(ctx context.Context, in RunInput, emit func(string, any)) error {
	max := r.MaxSteps
	if max == 0 {
		max = 12
	}

	model := in.Model
	if model == "" {
		model = r.ModelHint
	}
	if model == "" {
		return errors.New("no model specified for agent")
	}

	messages := []ChatMessage{
		{Role: "system", Content: in.SystemPrompt},
		{Role: "user", Content: in.UserMessage},
	}
	toolDefs := ToOpenAIDefs(in.Tools)

	for step := 0; step < max; step++ {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		resp, err := r.LLM.Chat(ctx, r.BaseURL, r.APIKey, model, messages, toolDefs)
		if err != nil {
			emit(EventError, map[string]string{"message": err.Error()})
			return err
		}

		// If the model wrote any text alongside its tool calls, surface it as
		// a "thought" — useful for the UI even on tool-call turns.
		if resp.Content != "" && len(resp.ToolCalls) > 0 {
			emit(EventThought, map[string]string{"content": resp.Content})
		}

		// No more tool calls -> finish.
		if len(resp.ToolCalls) == 0 {
			emit(EventMessage, map[string]string{"content": resp.Content})
			emit(EventDone, map[string]int{"steps": step + 1})
			return nil
		}

		// Record the assistant turn with its tool_calls so the API contract
		// is satisfied on the next turn.
		messages = append(messages, ChatMessage{
			Role:      "assistant",
			Content:   resp.Content,
			ToolCalls: resp.ToolCalls,
		})

		// Execute each tool, emit events, append tool results to messages.
		for _, tc := range resp.ToolCalls {
			emit(EventToolCall, map[string]any{
				"id":        tc.ID,
				"name":      tc.Function.Name,
				"arguments": tc.Function.Arguments,
			})

			tool := findTool(in.Tools, tc.Function.Name)
			var (
				result string
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
	return errors.New("max steps exceeded")
}

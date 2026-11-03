package application

import (
	"encoding/json"
	"strings"
	"testing"

	"ccy-canvas/backend/internal/platform/database/sqlc"
)

func TestResolveSlashSkillMessage(t *testing.T) {
	rewriteSpec, _ := json.Marshal(map[string]any{
		"slash_command": "rewrite",
		"content_md":    "Rewrite the user's selected content in a warmer, more premium tone.",
		"user_template": "Rewrite the user's selected content in a warmer, more premium tone.",
	})

	summarySpec, _ := json.Marshal(map[string]any{
		"slash_command": "summary",
		"content_md":    "Summarize the content into concise bullets.",
		"user_template": "Summarize the content into concise bullets.",
	})

	boundSkills := []sqlc.Skill{
		{
			Name:    "Rewrite",
			Kind:    "prompt",
			Spec:    rewriteSpec,
			Enabled: true,
		},
		{
			Name:    "Summary",
			Kind:    "prompt",
			Spec:    summarySpec,
			Enabled: false,
		},
	}

	message, invoked := ResolveSlashSkillMessage("/rewrite Turn this into a warmer launch caption.", boundSkills)
	if invoked != "/rewrite" {
		t.Fatalf("expected /rewrite, got %q", invoked)
	}

	expected := "Use the following bound skill template while answering.\n\n" +
		GuideUsageRules + "\n\n" +
		"Skill: /rewrite\n" +
		"Template:\n" +
		"Rewrite the user's selected content in a warmer, more premium tone.\n\n" +
		"User request:\n" +
		"Turn this into a warmer launch caption."
	if message != expected {
		t.Fatalf("unexpected injected message:\n%s", message)
	}

	raw, none := ResolveSlashSkillMessage("/summary Summarize this launch brief.", boundSkills)
	if none != "" {
		t.Fatalf("expected empty invoked command for unavailable skill, got %q", none)
	}
	if raw != "/summary Summarize this launch brief." {
		t.Fatalf("expected raw message passthrough, got %q", raw)
	}
}

// 前端"从画布添加"参考节点时会把前导拼在消息最前面
// （AgentRunPanel: message: refPreamble + outbound.message）。
// 这时 "/技能名" 依然要能被解析 —— 否则技能会静默失效，模型只看到字面命令。
func TestResolveSlashSkillMessageWithReferencePreamble(t *testing.T) {
	spec, _ := json.Marshal(map[string]any{
		"slash_command": "rewrite",
		"content_md":    "Rewrite the user's content in a warmer tone.",
	})
	boundSkills := []sqlc.Skill{{Name: "Rewrite", Kind: "prompt", Spec: spec, Enabled: true}}

	// 与前端 refPreamble 完全同形（全角括号 + 逗号分隔 + 换行）
	preamble := "（参考画布节点：开场图#a1b2c3，分镜说明#d4e5f6）"
	message, invoked := ResolveSlashSkillMessage(preamble+"\n/rewrite 换更暖的调子", boundSkills)

	if invoked != "/rewrite" {
		t.Fatalf("前导在前的斜杠技能必须被解析，实际 invoked=%q", invoked)
	}
	if !strings.Contains(message, "Skill: /rewrite") {
		t.Fatalf("技能模板未注入:\n%s", message)
	}
	if !strings.Contains(message, "Rewrite the user's content in a warmer tone.") {
		t.Fatalf("模板正文缺失:\n%s", message)
	}
	// 前导是有效上下文，不能丢
	if !strings.Contains(message, "开场图#a1b2c3") {
		t.Fatalf("参考节点前导被丢弃:\n%s", message)
	}
	// 用户请求本体也要在
	if !strings.Contains(message, "换更暖的调子") {
		t.Fatalf("用户请求丢失:\n%s", message)
	}
}

func TestResolveSlashSkillMessagePreambleEdgeCases(t *testing.T) {
	spec, _ := json.Marshal(map[string]any{"slash_command": "rewrite", "content_md": "t"})
	boundSkills := []sqlc.Skill{{Name: "Rewrite", Kind: "prompt", Spec: spec, Enabled: true}}

	// 前导没闭合：不做猜测，原样返回，且不解析
	raw, invoked := ResolveSlashSkillMessage("（参考画布节点：未闭合 /rewrite x", boundSkills)
	if invoked != "" {
		t.Fatalf("未闭合前导不应触发解析，实际 %q", invoked)
	}
	if !strings.Contains(raw, "/rewrite") {
		t.Fatalf("未闭合前导应原样返回，实际 %q", raw)
	}

	// 半角括号不是前导格式：按普通消息处理（首个 token 不是 /，不解析）
	raw2, invoked2 := ResolveSlashSkillMessage("(参考画布节点：x) /rewrite y", boundSkills)
	if invoked2 != "" {
		t.Fatalf("半角括号不应被当作前导，实际 %q", invoked2)
	}
	if !strings.Contains(raw2, "参考画布节点") {
		t.Fatalf("原文应保留，实际 %q", raw2)
	}

	// 只有前导、没有正文：不 panic，返回原文
	raw3, invoked3 := ResolveSlashSkillMessage("（参考画布节点：只有前导）", boundSkills)
	if invoked3 != "" || raw3 == "" {
		t.Fatalf("空正文应原样返回，实际 invoked=%q raw=%q", invoked3, raw3)
	}

	// 前导 + 非斜杠消息：原样返回（保留前导）
	raw4, invoked4 := ResolveSlashSkillMessage("（参考画布节点：x）\n看看这张图", boundSkills)
	if invoked4 != "" {
		t.Fatalf("非斜杠消息不应触发技能，实际 %q", invoked4)
	}
	if !strings.Contains(raw4, "看看这张图") || !strings.Contains(raw4, "参考画布节点") {
		t.Fatalf("应原样返回完整消息，实际 %q", raw4)
	}
}

package application

import (
	"encoding/json"
	"strings"

	"ccy-canvas/backend/internal/platform/database/sqlc"
)

type promptSkillSpec struct {
	SlashCommand string `json:"slash_command"`
	ContentMD    string `json:"content_md"`
	UserTemplate string `json:"user_template"`
}

// referencePreamblePrefix 是前端"从画布添加"参考节点时拼在消息最前面的前导标记
// （见 AgentRunPanel 的 refPreamble）。它出现在消息开头时，后面的 "/技能名" 依然是
// 用户想调用的技能 —— 必须先剥掉前导再做斜杠解析，否则解析会静默失效。
const referencePreamblePrefix = "（参考画布节点："

// splitReferencePreamble 把 "（参考画布节点：…）\n" 前导与正文分开。
// 没有前导（或前导未闭合）时 preamble 为空、body 为原文。
func splitReferencePreamble(raw string) (preamble string, body string) {
	trimmed := strings.TrimSpace(raw)
	if !strings.HasPrefix(trimmed, referencePreamblePrefix) {
		return "", trimmed
	}
	end := strings.Index(trimmed, "）")
	if end < 0 {
		// 前导没闭合：按原样处理，不做任何猜测
		return "", trimmed
	}
	preamble = strings.TrimSpace(trimmed[:end+len("）")])
	body = strings.TrimSpace(trimmed[end+len("）"):])
	return preamble, body
}

// rejoinPreamble 把前导与正文拼回去。
// 未命中技能时必须原样返回整条消息 —— 前导里带着"用户引用了哪些画布节点"，
// 丢掉它会让模型失去上下文（早期实现就踩过这个坑）。
func rejoinPreamble(preamble, body string) string {
	if preamble == "" {
		return body
	}
	if body == "" {
		return preamble
	}
	return preamble + "\n" + body
}

func ResolveSlashSkillMessage(raw string, boundSkills []sqlc.Skill) (string, string) {
	// 先剥掉"参考画布节点"前导，让 "/技能" 能被识别（否则 part[0] 是前导文本）。
	preamble, trimmed := splitReferencePreamble(raw)
	if trimmed == "" {
		return strings.TrimSpace(raw), ""
	}

	parts := strings.Fields(trimmed)
	if len(parts) == 0 || !strings.HasPrefix(parts[0], "/") {
		// 没有斜杠命令：原样返回（保留前导，模型仍能看到引用了哪些节点）
		return strings.TrimSpace(raw), ""
	}

	for _, skill := range boundSkills {
		if !skill.Enabled || skill.Kind != "prompt" {
			continue
		}
		commandName := slashCommandName(skill)
		if !strings.EqualFold(commandName, parts[0]) {
			continue
		}
		requestText := strings.TrimSpace(strings.Join(parts[1:], " "))
		// 前导里带着"用户引用了哪些画布节点"，是有用上下文，不能丢 ——
		// 放回用户请求前面，与未命中技能时的原文语义一致。
		if preamble != "" {
			requestText = strings.TrimSpace(preamble + "\n" + requestText)
		}
		templateBody := promptTemplateBody(skill)
		message := strings.Join([]string{
			"Use the following bound skill template while answering.",
			"",
			// 与工具路径同一份使用规约:自检等仪式内化、提问走 ask_user 选项卡。
			GuideUsageRules,
			"",
			"Skill: " + commandName,
			"Template:",
			templateBody,
			"",
			"User request:",
			requestText,
		}, "\n")
		return message, commandName
	}

	return rejoinPreamble(preamble, trimmed), ""
}

func slashCommandName(skill sqlc.Skill) string {
	var spec promptSkillSpec
	_ = json.Unmarshal(skill.Spec, &spec)
	raw := strings.TrimSpace(spec.SlashCommand)
	if raw == "" {
		raw = strings.ToLower(strings.Join(strings.Fields(skill.Name), "-"))
	}
	if strings.HasPrefix(raw, "/") {
		return raw
	}
	return "/" + raw
}

func promptTemplateBody(skill sqlc.Skill) string {
	var spec promptSkillSpec
	_ = json.Unmarshal(skill.Spec, &spec)
	if body := strings.TrimSpace(spec.ContentMD); body != "" {
		return body
	}
	return strings.TrimSpace(spec.UserTemplate)
}

// PromptSkillContent 导出技能的正文（方法论文本）。
//
// 给 harness 路径用：桥会把技能写成 DSH 的 SKILL.md，让模型能按需加载完整方法论
// （等价于本地 runner 的技能工具，但走 DSH 自己的渐进披露）。
// 与 promptTemplateBody 同源，避免两处各解一遍 spec 而漂移。
func PromptSkillContent(skill sqlc.Skill) string {
	return promptTemplateBody(skill)
}

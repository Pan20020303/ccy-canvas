import { describe, expect, it } from "vitest";

import type { Agent, Skill } from "../../api/skills";
import type { AppProviderConfig } from "../../api/providerConfigs";
import {
  buildPromptSkillSpec,
  getAgentAvailableModels,
  getAgentExperienceHints,
  getSkillCommandName,
  getSkillTemplateBody,
  isPromptTemplateSkill,
} from "./skill-agent-presenters";

const promptSkill: Skill = {
  id: "skill-1",
  scope: "personal",
  name: "Rewrite",
  description: "Rewrite text in a chosen tone.",
  category: "writing",
  icon: "",
  kind: "prompt",
  spec: {
    slash_command: "rewrite",
    content_md: "Rewrite the user text in a warmer tone.",
    system_prompt: "You are an editing assistant.",
    user_template: "Rewrite: {{text}}",
    model_hint: "gpt-4.1-mini",
  },
  input_schema: {},
  output_schema: {},
  enabled: true,
  created_at: "",
  updated_at: "",
};

const httpSkill: Skill = {
  ...promptSkill,
  id: "skill-2",
  name: "Webhook",
  kind: "http",
  spec: { url: "https://example.com", method: "POST" },
};

const agent: Agent = {
  id: "agent-1",
  scope: "personal",
  name: "Brand Assistant",
  description: "Helps with brand-safe writing.",
  avatar: "",
  system_prompt: "Stay on brand.",
  model: "gpt-4.1-mini",
  skill_ids: ["skill-1"],
  canvas_tools: true,
  strategy: "reactive",
  enabled: true,
  created_at: "",
  updated_at: "",
};

describe("skill-agent presenters", () => {
  it("identifies prompt skills as reusable template skills", () => {
    expect(isPromptTemplateSkill(promptSkill)).toBe(true);
    expect(isPromptTemplateSkill(httpSkill)).toBe(false);
  });

  it("derives a slash command name from skill spec or name", () => {
    expect(getSkillCommandName(promptSkill)).toBe("/rewrite");
    expect(getSkillCommandName(httpSkill)).toBe("/webhook");
  });

  it("prefers markdown-like template bodies when available", () => {
    expect(getSkillTemplateBody(promptSkill)).toBe("Rewrite the user text in a warmer tone.");
  });

  it("builds a backward-compatible prompt skill spec from template inputs", () => {
    expect(buildPromptSkillSpec({
      commandName: "summary",
      content: "Summarize the latest notes.",
      systemPrompt: "You are a concise operator.",
      modelHint: "gpt-4.1-mini",
    })).toEqual({
      slash_command: "summary",
      content_md: "Summarize the latest notes.",
      system_prompt: "You are a concise operator.",
      user_template: "Summarize the latest notes.",
      model_hint: "gpt-4.1-mini",
      trigger_mode: "slash",
    });
  });

  it("flattens admin-configured text models for agent selection", () => {
    const models: AppProviderConfig[] = [
      {
        id: "a",
        service_type: "text",
        vendor: "OpenAI",
        name: "OpenAI",
        model_list: ["gpt-4.1-mini", "gpt-4.1"],
        default_model: "gpt-4.1-mini",
        priority: 1,
      },
      {
        id: "b",
        service_type: "image",
        vendor: "OpenAI",
        name: "OpenAI Image",
        model_list: ["gpt-image-1"],
        default_model: "gpt-image-1",
        priority: 1,
      },
      {
        id: "c",
        service_type: "text",
        vendor: "Anthropic",
        name: "Claude",
        model_list: ["claude-sonnet-4"],
        default_model: "claude-sonnet-4",
        priority: 2,
      },
    ];

    expect(getAgentAvailableModels(models, "gpt-4.1-mini")).toEqual([
      "gpt-4.1-mini",
      "gpt-4.1",
      "claude-sonnet-4",
    ]);
  });

  it("summarizes the agent experience in user language", () => {
    expect(getAgentExperienceHints(agent, [promptSkill], true)).toEqual([
      "使用管理员预配的模型",
      "保留当前会话上下文",
      "可通过 /rewrite 调用技能",
    ]);
  });
});

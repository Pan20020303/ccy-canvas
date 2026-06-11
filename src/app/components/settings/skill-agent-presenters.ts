import type { AppProviderConfig } from "../../api/providerConfigs";
import type { Agent, Skill } from "../../api/skills";

type PromptSkillSpec = {
  slash_command?: string;
  content_md?: string;
  system_prompt?: string;
  user_template?: string;
  model_hint?: string;
  trigger_mode?: string;
};

export function isPromptTemplateSkill(skill: Skill) {
  return skill.kind === "prompt";
}

export function getSkillCommandName(skill: Skill) {
  const spec = (skill.spec ?? {}) as PromptSkillSpec;
  const raw = spec.slash_command?.trim() || skill.name.trim().toLowerCase().replace(/\s+/g, "-");
  return raw.startsWith("/") ? raw : `/${raw}`;
}

export function getSkillTemplateBody(skill: Skill) {
  const spec = (skill.spec ?? {}) as PromptSkillSpec;
  return spec.content_md?.trim() || spec.user_template?.trim() || "";
}

export function buildPromptSkillSpec({
  commandName,
  content,
  systemPrompt,
  modelHint,
}: {
  commandName: string;
  content: string;
  systemPrompt: string;
  modelHint: string;
}) {
  return {
    slash_command: commandName.trim().replace(/^\/+/, ""),
    content_md: content,
    system_prompt: systemPrompt,
    user_template: content,
    model_hint: modelHint,
    trigger_mode: "slash",
  };
}

export function getAgentAvailableModels(models: AppProviderConfig[], currentModel?: string) {
  const seen = new Set<string>();
  const output: string[] = [];

  const add = (model: string) => {
    const clean = model.trim();
    if (!clean || seen.has(clean)) {
      return;
    }
    seen.add(clean);
    output.push(clean);
  };

  models
    .filter((model) => model.service_type === "text")
    .sort((a, b) => a.priority - b.priority)
    .forEach((model) => {
      model.model_list.forEach(add);
    });

  return output;
}

export function getAgentExperienceHints(agent: Agent, skills: Skill[], zh: boolean) {
  const firstSkill = agent.skill_ids
    .map((id) => skills.find((skill) => skill.id === id))
    .find(Boolean);

  return [
    zh ? "使用管理员预配的模型" : "Uses an admin-configured model",
    zh ? "保留当前会话上下文" : "Keeps current conversation context",
    firstSkill
      ? zh
        ? `可通过 ${getSkillCommandName(firstSkill)} 调用技能`
        : `Can invoke skills via ${getSkillCommandName(firstSkill)}`
      : zh
        ? "可绑定并调用技能"
        : "Can bind and invoke skills",
  ];
}

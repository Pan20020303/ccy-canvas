import type { Agent, Skill } from "../api/skills";
import { getSkillCommandName, getSkillTemplateBody, isPromptTemplateSkill } from "./settings/skill-agent-presenters";

export function getBoundSlashSkills(agent: Agent, skills: Skill[]) {
  const allowed = new Set(agent.skill_ids);
  return skills.filter((skill) => allowed.has(skill.id) && skill.enabled && isPromptTemplateSkill(skill));
}

// All slash-invokable skills the user can see — regardless of whether they
// are bound to the active agent. Slash discovery should match the user's
// mental model from Claude / Cursor: any installed skill is reachable.
export function getAllInvokableSlashSkills(skills: Skill[]) {
  return skills.filter((skill) => skill.enabled && isPromptTemplateSkill(skill));
}

export function buildAgentRunMessage(
  agent: Agent,
  skills: Skill[],
  rawMessage: string,
  selectedSkillId?: string | null,
) {
  const trimmed = rawMessage.trim();
  const [firstToken, ...rest] = trimmed.split(/\s+/);

  const explicitlySelectedSkill = selectedSkillId
    ? skills.find((skill) => skill.id === selectedSkillId && skill.enabled)
    : undefined;

  if (!firstToken.startsWith("/") && !explicitlySelectedSkill) {
    return {
      message: trimmed,
      invokedSkillName: null,
    };
  }

  // Slash resolution looks across ALL invokable skills, not just bound ones,
  // so a freshly-imported skill is callable immediately without an extra
  // "bind to agent" step.
  const invokable = getAllInvokableSlashSkills(skills);
  const matchedSkill = explicitlySelectedSkill
    ?? invokable.find((skill) => getSkillCommandName(skill).toLowerCase() === firstToken.toLowerCase());

  if (!matchedSkill) {
    return {
      message: trimmed,
      invokedSkillName: null,
    };
  }

  const selectedCommand = getSkillCommandName(matchedSkill);
  const requestText = firstToken.toLowerCase() === selectedCommand.toLowerCase()
    ? rest.join(" ").trim()
    : trimmed;
  const template = getSkillTemplateBody(matchedSkill);

  return {
    message: [
      "Use the following bound skill template while answering.",
      "",
      `Skill: ${selectedCommand}`,
      "Template:",
      template,
      "",
      "User request:",
      requestText,
    ].join("\n"),
    invokedSkillName: selectedCommand,
  };
}

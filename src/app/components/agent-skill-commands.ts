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

export function buildAgentRunMessage(agent: Agent, skills: Skill[], rawMessage: string) {
  const trimmed = rawMessage.trim();
  const [firstToken, ...rest] = trimmed.split(/\s+/);

  if (!firstToken.startsWith("/")) {
    return {
      message: trimmed,
      invokedSkillName: null,
    };
  }

  // Slash resolution looks across ALL invokable skills, not just bound ones,
  // so a freshly-imported skill is callable immediately without an extra
  // "bind to agent" step.
  const invokable = getAllInvokableSlashSkills(skills);
  const matchedSkill = invokable.find((skill) => getSkillCommandName(skill).toLowerCase() === firstToken.toLowerCase());

  if (!matchedSkill) {
    return {
      message: trimmed,
      invokedSkillName: null,
    };
  }

  const requestText = rest.join(" ").trim();
  const template = getSkillTemplateBody(matchedSkill);

  return {
    message: [
      "Use the following bound skill template while answering.",
      "",
      `Skill: ${getSkillCommandName(matchedSkill)}`,
      "Template:",
      template,
      "",
      "User request:",
      requestText,
    ].join("\n"),
    invokedSkillName: getSkillCommandName(matchedSkill),
  };
}

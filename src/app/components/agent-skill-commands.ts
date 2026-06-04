import type { Agent, Skill } from "../api/skills";
import { getSkillCommandName, getSkillTemplateBody, isPromptTemplateSkill } from "./settings/skill-agent-presenters";

export function getBoundSlashSkills(agent: Agent, skills: Skill[]) {
  const allowed = new Set(agent.skill_ids);
  return skills.filter((skill) => allowed.has(skill.id) && skill.enabled && isPromptTemplateSkill(skill));
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

  const boundSkills = getBoundSlashSkills(agent, skills);
  const matchedSkill = boundSkills.find((skill) => getSkillCommandName(skill).toLowerCase() === firstToken.toLowerCase());

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

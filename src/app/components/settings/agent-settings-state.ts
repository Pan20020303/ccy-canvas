import type { Agent, Skill } from "../../api/skills";

type SettledResult<T> = PromiseSettledResult<T>;

export function applyAgentSettingsLoadResults(
  previousAgents: Agent[],
  previousSkills: Skill[],
  agentsResult: SettledResult<Agent[]>,
  skillsResult: SettledResult<Skill[]>,
) {
  return {
    agents: agentsResult.status === "fulfilled" ? agentsResult.value : previousAgents,
    skills: skillsResult.status === "fulfilled" ? skillsResult.value : previousSkills,
  };
}

export function canSaveAgentEditor(input: {
  name: string;
  systemPrompt: string;
  model: string;
}) {
  return input.name.trim().length > 0
    && input.systemPrompt.trim().length > 0
    && input.model.trim().length > 0;
}

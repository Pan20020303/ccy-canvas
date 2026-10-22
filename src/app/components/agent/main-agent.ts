import type { Agent } from "../../api/skills";

/** One stable entrypoint; stale local picker choices must not select a specialist. */
export function selectMainAgent(rows: Agent[]): Agent | null {
  const roots = rows.filter(agent => agent.enabled && !agent.parent_deploy_key);
  return roots.find(agent => agent.deploy_key === "productionAgent")
    ?? roots.find(agent => agent.deploy_key === "universalAi")
    ?? [...roots].sort((a, b) => a.id.localeCompare(b.id))[0]
    ?? null;
}

import { describe, expect, it } from "vitest";

import type { Agent, Skill } from "../../api/skills";
import {
  applyAgentSettingsLoadResults,
  canSaveAgentEditor,
} from "./agent-settings-state";

const agent: Agent = {
  id: "agent-1",
  scope: "personal",
  owner_id: "user-1",
  name: "Brand assistant",
  description: "",
  avatar: "",
  system_prompt: "Stay on brand.",
  model: "mimo-v2.5-pro",
  skill_ids: [],
  canvas_tools: true,
  strategy: "reactive",
  enabled: true,
  created_at: "",
  updated_at: "",
};

const skill: Skill = {
  id: "skill-1",
  scope: "personal",
  owner_id: "user-1",
  name: "Rewrite",
  description: "",
  category: "writing",
  icon: "",
  kind: "prompt",
  spec: {},
  input_schema: {},
  output_schema: {},
  enabled: true,
  created_at: "",
  updated_at: "",
};

describe("agent settings state helpers", () => {
  it("keeps agent list when skills fail to load", () => {
    const next = applyAgentSettingsLoadResults(
      [],
      [],
      { status: "fulfilled", value: [agent] },
      { status: "rejected", reason: new Error("skills failed") },
    );

    expect(next.agents).toEqual([agent]);
    expect(next.skills).toEqual([]);
  });

  it("keeps previous agents when only skills refresh successfully", () => {
    const next = applyAgentSettingsLoadResults(
      [agent],
      [],
      { status: "rejected", reason: new Error("agents failed") },
      { status: "fulfilled", value: [skill] },
    );

    expect(next.agents).toEqual([agent]);
    expect(next.skills).toEqual([skill]);
  });

  it("blocks saving when required agent fields are blank", () => {
    expect(canSaveAgentEditor({ name: "  ", systemPrompt: "Help", model: "mimo-v2.5-pro" })).toBe(false);
    expect(canSaveAgentEditor({ name: "Brand assistant", systemPrompt: "   ", model: "mimo-v2.5-pro" })).toBe(false);
    expect(canSaveAgentEditor({ name: "Brand assistant", systemPrompt: "Help", model: "   " })).toBe(false);
    expect(canSaveAgentEditor({ name: "Brand assistant", systemPrompt: "Help", model: "mimo-v2.5-pro" })).toBe(true);
  });
});

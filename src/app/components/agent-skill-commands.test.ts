import { describe, expect, it } from "vitest";

import type { Agent, Skill } from "../api/skills";
import {
  buildAgentRunMessage,
  getBoundSlashSkills,
} from "./agent-skill-commands";

const skills: Skill[] = [
  {
    id: "skill-1",
    scope: "personal",
    owner_id: "user-1",
    name: "Rewrite",
    description: "Rewrite copy in a warmer tone.",
    category: "writing",
    icon: "",
    kind: "prompt",
    spec: {
      slash_command: "rewrite",
      content_md: "Rewrite the user's selected content in a warmer, more premium tone.",
      user_template: "Rewrite the user's selected content in a warmer, more premium tone.",
      trigger_mode: "slash",
    },
    input_schema: {},
    output_schema: {},
    enabled: true,
    created_at: "",
    updated_at: "",
  },
  {
    id: "skill-2",
    scope: "personal",
    owner_id: "user-1",
    name: "Summary",
    description: "Summarize notes.",
    category: "other",
    icon: "",
    kind: "prompt",
    spec: {
      slash_command: "summary",
      content_md: "Summarize the content into concise bullets.",
      user_template: "Summarize the content into concise bullets.",
      trigger_mode: "slash",
    },
    input_schema: {},
    output_schema: {},
    enabled: true,
    created_at: "",
    updated_at: "",
  },
];

const agent: Agent = {
  id: "agent-1",
  scope: "personal",
  owner_id: "user-1",
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

describe("agent slash-skill commands", () => {
  it("returns only prompt skills bound to the current agent", () => {
    expect(getBoundSlashSkills(agent, skills).map((skill) => skill.name)).toEqual(["Rewrite"]);
  });

  it("passes through plain messages unchanged", () => {
    expect(buildAgentRunMessage(agent, skills, "Help me rewrite this product copy.")).toEqual({
      message: "Help me rewrite this product copy.",
      invokedSkillName: null,
    });
  });

  it("injects the bound slash skill template into the outgoing message", () => {
    expect(buildAgentRunMessage(agent, skills, "/rewrite Turn this into a warmer launch caption.")).toEqual({
      message: [
        "Use the following bound skill template while answering.",
        "",
        "Skill: /rewrite",
        "Template:",
        "Rewrite the user's selected content in a warmer, more premium tone.",
        "",
        "User request:",
        "Turn this into a warmer launch caption.",
      ].join("\n"),
      invokedSkillName: "/rewrite",
    });
  });

  it("ignores slash commands that are not bound to the agent", () => {
    expect(buildAgentRunMessage(agent, skills, "/summary Summarize this launch brief.")).toEqual({
      message: "/summary Summarize this launch brief.",
      invokedSkillName: null,
    });
  });
});

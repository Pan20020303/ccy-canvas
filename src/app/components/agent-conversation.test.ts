import { describe, expect, it } from "vitest";

import {
  appendConversationTurn,
  clearAgentConversationHistory,
  completeAgentConversationTurn,
  conversationTurnsFromHistoryItems,
  getAgentConversationHistory,
  recordAgentConversationTurn,
  type AgentConversationTurn,
} from "./agent-conversation";

describe("agent conversation history", () => {
  it("appends a single turn pair to the conversation history", () => {
    const history = completeAgentConversationTurn([], "Draft a launch headline.", "Here is a sharper launch headline.");

    expect(history).toEqual<AgentConversationTurn[]>([
      { role: "user", content: "Draft a launch headline." },
      { role: "assistant", content: "Here is a sharper launch headline." },
    ]);
  });

  it("keeps only the most recent turns within the history limit", () => {
    const history = Array.from({ length: 6 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `turn-${index + 1}`,
    })) as AgentConversationTurn[];

    const next = completeAgentConversationTurn(
      history,
      "Please tighten the CTA.",
      "Here is a tighter CTA.",
      6,
    );

    expect(next).toEqual<AgentConversationTurn[]>([
      { role: "user", content: "turn-3" },
      { role: "assistant", content: "turn-4" },
      { role: "user", content: "turn-5" },
      { role: "assistant", content: "turn-6" },
      { role: "user", content: "Please tighten the CTA." },
      { role: "assistant", content: "Here is a tighter CTA." },
    ]);
  });

  it("ignores blank turn content instead of polluting history", () => {
    expect(appendConversationTurn([], "user", "   ")).toEqual([]);
    expect(completeAgentConversationTurn([], "Rewrite this copy.", "   ")).toEqual([]);
  });

  it("stores conversation history per agent and keeps their turns isolated", () => {
    const byAgent = recordAgentConversationTurn({}, "agent-brand", "Rewrite this headline.", "Here is a warmer version.");
    const next = recordAgentConversationTurn(byAgent, "agent-story", "Outline scene one.", "Scene one is now outlined.");

    expect(getAgentConversationHistory(next, "agent-brand")).toEqual<AgentConversationTurn[]>([
      { role: "user", content: "Rewrite this headline." },
      { role: "assistant", content: "Here is a warmer version." },
    ]);
    expect(getAgentConversationHistory(next, "agent-story")).toEqual<AgentConversationTurn[]>([
      { role: "user", content: "Outline scene one." },
      { role: "assistant", content: "Scene one is now outlined." },
    ]);
  });

  it("can clear the stored history for a specific agent only", () => {
    const byAgent = recordAgentConversationTurn({}, "agent-brand", "Rewrite this headline.", "Here is a warmer version.");
    const next = recordAgentConversationTurn(byAgent, "agent-story", "Outline scene one.", "Scene one is now outlined.");

    expect(clearAgentConversationHistory(next, "agent-brand")).toEqual({
      "agent-story": [
        { role: "user", content: "Outline scene one." },
        { role: "assistant", content: "Scene one is now outlined." },
      ],
    });
  });

  it("hydrates conversation turns from persisted run history items", () => {
    expect(conversationTurnsFromHistoryItems([
      {
        user_input: "Draft a launch headline.",
        final_reply: "Launch brighter with our summer collection.",
      },
      {
        user_input: "Make it warmer.",
        final_reply: "Here is a warmer launch headline.",
      },
    ])).toEqual<AgentConversationTurn[]>([
      { role: "user", content: "Draft a launch headline." },
      { role: "assistant", content: "Launch brighter with our summer collection." },
      { role: "user", content: "Make it warmer." },
      { role: "assistant", content: "Here is a warmer launch headline." },
    ]);
  });
});

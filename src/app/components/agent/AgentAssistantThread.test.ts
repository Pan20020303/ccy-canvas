import { describe, expect, it } from "vitest";

import {
  buildAgentThreadMessages,
  type ThreadRunStep,
} from "./AgentAssistantThread";

const createNodeStep: ThreadRunStep = {
  kind: "tool",
  id: "step-create-node",
  invocation: {
    id: "call-create-node",
    name: "create_node",
    args: '{"type":"textNode"}',
    status: "running",
  },
};

describe("buildAgentThreadMessages", () => {
  it("keeps a streamed reply in a stable text-only message when a late tool call arrives", () => {
    const beforeTool = buildAgentThreadMessages([], [], "正在创建节点", true);
    const afterTool = buildAgentThreadMessages([], [createNodeStep], "正在创建节点", true);

    expect(beforeTool.map((message) => message.id)).toEqual(["current-run-reply"]);
    expect(afterTool.map((message) => message.id)).toEqual([
      "current-run-steps",
      "current-run-reply",
    ]);
    expect(afterTool[1]?.content).toEqual([
      { type: "text", text: "正在创建节点" },
    ]);
    expect(afterTool[0]?.content).toEqual([
      {
        type: "tool-call",
        toolCallId: "call-create-node",
        toolName: "create_node",
        argsText: '{"type":"textNode"}',
      },
    ]);
  });

  it("places the finished tool timeline before the persisted assistant reply", () => {
    const messages = buildAgentThreadMessages(
      [{ role: "assistant", content: "节点已创建" }],
      [createNodeStep],
      "",
      false,
    );

    expect(messages.map((message) => message.id)).toEqual([
      "current-run-steps",
      "h-0",
    ]);
  });
});

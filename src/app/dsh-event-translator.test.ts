import { describe, expect, it } from "vitest";

import {
  createSessionEventTranslator,
  flattenStreamChunks,
  normalizeToolName,
  textFromBlocks,
  translateSessionEvent,
} from "./dsh-event-translator";

/** 按真实会话日志（dump-event.mjs）构造的 assistant/message 载荷。 */
function assistantMessageEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "assistant/message",
    seq: 15,
    time: 1789033997208,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "你好，我是助手。" }],
        source: { kind: "model", provider: "deepseek-official", model: "deepseek-flash" },
        id: "msg-1",
      },
      usage: {
        inputTokens: 8578,
        outputTokens: 144,
        totalTokens: 8722,
        cacheReadTokens: 0,
        reasoningTokens: 0,
      },
      stream: [
        { type: "chunk", time: 1, chunk: { type: "block-start", index: 0, blockType: "text" } },
        { type: "text-chunks", time0: 2, index: 0, dt: [11, 1, 0], texts: ["你好", "，", "我是助手。"] },
      ],
      ...overrides,
    },
  };
}

describe("normalizeToolName", () => {
  it("去掉 MCP 命名空间前缀", () => {
    expect(normalizeToolName("mcp__ccy__create_text_node")).toBe("create_text_node");
    expect(normalizeToolName("mcp__github__create_issue")).toBe("create_issue");
  });

  it("原生工具名保持不变", () => {
    expect(normalizeToolName("pwsh")).toBe("pwsh");
    expect(normalizeToolName("read")).toBe("read");
  });

  it("容忍畸形输入", () => {
    expect(normalizeToolName(undefined)).toBe("");
    expect(normalizeToolName("mcp__onlyone")).toBe("mcp__onlyone");
  });
});

describe("textFromBlocks", () => {
  it("拼接 text 块，并递归 tool-result 的嵌套 content", () => {
    expect(textFromBlocks([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
    expect(
      textFromBlocks([{ type: "tool-result", content: [{ type: "text", text: "inner" }] }]),
    ).toBe("inner");
  });

  it("非数组输入返回空串", () => {
    expect(textFromBlocks(undefined)).toBe("");
    expect(textFromBlocks("oops")).toBe("");
  });
});

describe("flattenStreamChunks", () => {
  it("按 texts/dt 展开为逐片增量并保留耗时", () => {
    const chunks = flattenStreamChunks([
      { type: "text-chunks", index: 0, dt: [5, 0], texts: ["甲", "乙"] },
      { type: "reasoning-chunks", index: 1, dt: [7], texts: ["想"] },
      { type: "tool-call-chunks", index: 2, dt: [1], id: "c1", name: "read", args: "{}" },
    ]);
    expect(chunks).toEqual([
      { kind: "text", index: 0, text: "甲", delayMs: 5 },
      { kind: "text", index: 0, text: "乙", delayMs: 0 },
      { kind: "reasoning", index: 1, text: "想", delayMs: 7 },
    ]);
  });

  it("缺少 dt 时按 0 处理，空文本片被跳过", () => {
    const chunks = flattenStreamChunks([{ type: "text-chunks", index: 0, texts: ["", "x"] }]);
    expect(chunks).toEqual([{ kind: "text", index: 0, text: "x", delayMs: 0 }]);
  });
});

describe("translateSessionEvent", () => {
  it("非 paced 模式：一次性输出增量全文 + usage + message", () => {
    const out = translateSessionEvent(assistantMessageEvent());
    expect(out.map((item) => item.kind)).toEqual(["message_delta", "usage", "message"]);
    expect(out[0].data).toEqual({ delta: "你好，我是助手。" });
    expect(out[1].data).toEqual({ prompt_tokens: 8578, completion_tokens: 144, total_tokens: 8722 });
    expect(out[2].data).toEqual({ content: "你好，我是助手。" });
  });

  it("paced 模式：逐片输出并带上原始节奏", () => {
    const out = translateSessionEvent(assistantMessageEvent(), { paced: true });
    expect(out.slice(0, 3)).toEqual([
      { kind: "message_delta", data: { delta: "你好" }, delayMs: 11 },
      { kind: "message_delta", data: { delta: "，" }, delayMs: 1 },
      { kind: "message_delta", data: { delta: "我是助手。" }, delayMs: 0 },
    ]);
    // 增量之后仍然要给出 usage 与最终 message
    expect(out.map((item) => item.kind)).toEqual([
      "message_delta",
      "message_delta",
      "message_delta",
      "usage",
      "message",
    ]);
  });

  it("最终回复只取正文，不能把推理混进去（实测故障：思考跑到正文里）", () => {
    // DSH 的 assistant/message 会把推理段也放进 message.content。
    // 早期实现直接取 message.content 当回复 → 面板把它存进会话历史 →
    // 用户看到"思考内容出现在气泡正文里，刷新后还在"。
    const event = {
      type: "assistant/message",
      data: {
        turn: 1,
        step: 1,
        message: {
          role: "assistant",
          // 真实形态：同一条消息里既有推理段又有正文段
          content: [
            { type: "text", text: "用户问我能帮他做什么。我应该简明回答，不需要调用工具。" },
            { type: "text", text: "我是这张画布上的操作代理，能读也能改。" },
          ],
          source: { kind: "model", provider: "deepseek-official", model: "deepseek-flash" },
          id: "m1",
        },
        stream: [
          { type: "reasoning-chunks", index: 0, dt: [1], texts: ["用户问我能帮他做什么。我应该简明回答，不需要调用工具。"] },
          { type: "text-chunks", index: 1, dt: [1], texts: ["我是这张画布上的操作代理，能读也能改。"] },
        ],
      },
    };
    const out = translateSessionEvent(event);
    const finalMessage = out.find((item) => item.kind === "message");
    expect(finalMessage?.data).toEqual({ content: "我是这张画布上的操作代理，能读也能改。" });
    // 推理不能出现在最终回复里
    expect(String((finalMessage?.data as { content: string }).content)).not.toContain("我应该简明回答");
  });

  it("只有推理、没有正文时不产出 message 事件（不能把思考当回复）", () => {
    const event = {
      type: "assistant/message",
      data: {
        turn: 1,
        step: 1,
        message: { role: "assistant", content: [{ type: "text", text: "纯推理内容" }], id: "m2" },
        stream: [{ type: "reasoning-chunks", index: 0, dt: [1], texts: ["纯推理内容"] }],
      },
    };
    const out = translateSessionEvent(event);
    expect(out.some((item) => item.kind === "message")).toBe(false);
    // 推理仍要作为 thought_delta 送出去（不能丢）
    expect(out.some((item) => item.kind === "thought_delta")).toBe(true);
  });

  it("有 stream 时正文以 stream 的 text-chunks 为准（权威是流，不是 message.content）", () => {
    const event = assistantMessageEvent({
      stream: [
        { type: "reasoning-chunks", index: 0, dt: [3], texts: ["先思考"] },
        { type: "text-chunks", index: 0, dt: [4], texts: ["再回答"] },
      ],
    });
    const out = translateSessionEvent(event);
    expect(out[0]).toEqual({ kind: "thought_delta", data: { delta: "先思考" } });
    expect(out[1]).toEqual({ kind: "message_delta", data: { delta: "再回答" } });
    // 最终 message 取 text-chunks；message.content 里混着推理，不能直接用
    expect(out.at(-1)?.data).toEqual({ content: "再回答" });
  });

  it("流缺失时回退到 message.content", () => {
    const event = assistantMessageEvent({ stream: undefined });
    const out = translateSessionEvent(event);
    expect(out[0]).toEqual({ kind: "message_delta", data: { delta: "你好，我是助手。" } });
  });

  it("interrupted 轮次额外给出提示", () => {
    const event = assistantMessageEvent({ interrupted: true });
    const out = translateSessionEvent(event);
    expect(out.at(-1)?.kind).toBe("thought");
  });

  it("tool/call 归一化工具名", () => {
    const out = translateSessionEvent({
      type: "tool/call",
      data: { turn: 1, step: 1, callId: "call_1", name: "mcp__ccy__create_image_node", arguments: '{"prompt":"x"}' },
    });
    expect(out).toEqual([
      {
        kind: "tool_call",
        data: { id: "call_1", name: "create_image_node", arguments: '{"prompt":"x"}' },
      },
    ]);
  });

  it("tool/result 提取文本与成败（name 留空待对账）", () => {
    const out = translateSessionEvent({
      type: "tool/result",
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [
            { type: "tool-result", toolCallId: "call_1", content: [{ type: "text", text: '{"ok":true}' }], isError: false },
          ],
        },
      },
    });
    expect(out).toEqual([
      { kind: "tool_result", data: { id: "call_1", name: "", ok: true, result: '{"ok":true}' } },
    ]);
  });

  it("tool/result 失败时把错误文本放进 error 字段", () => {
    const out = translateSessionEvent({
      type: "tool/result",
      data: {
        turn: 1,
        step: 1,
        error: { name: "ToolError", code: "E_TOOL" },
        message: {
          content: [
            { type: "tool-result", toolCallId: "call_2", content: [{ type: "text", text: "boom" }], isError: true },
          ],
        },
      },
    });
    expect(out[0]).toEqual({ kind: "tool_result", data: { id: "call_2", name: "", ok: false, error: "boom" } });
  });

  it("turn/end → done", () => {
    expect(translateSessionEvent({ type: "turn/end", data: { turn: 3, reason: "success" } })).toEqual([
      { kind: "done", data: { steps: 3 } },
    ]);
  });

  it("过程性事件不进 UI 时间线", () => {
    for (const type of ["turn/start", "step/start", "step/end", "system/message", "request/header"]) {
      expect(translateSessionEvent({ type, data: {} })).toEqual([]);
    }
  });
});

describe("createSessionEventTranslator", () => {
  it("按 sessionId 过滤（session.event 是全 runtime 广播）", () => {
    const translator = createSessionEventTranslator("sess-a");
    const other = translator.translate({
      sessionId: "sess-b",
      event: { type: "turn/end", data: { turn: 1 } },
    });
    expect(other).toEqual([]);

    const mine = translator.translate({
      sessionId: "sess-a",
      event: { type: "turn/end", data: { turn: 1 } },
    });
    expect(mine).toEqual([{ kind: "done", data: { steps: 1 } }]);
  });

  it("用 callId 给 tool/result 补上工具名（DSH 的 result 只有 callId）", () => {
    const translator = createSessionEventTranslator("s1");
    translator.translate({
      sessionId: "s1",
      event: { type: "tool/call", data: { callId: "c9", name: "mcp__ccy__connect_nodes", arguments: "{}" } },
    });
    const out = translator.translate({
      sessionId: "s1",
      event: {
        type: "tool/result",
        data: { message: { content: [{ type: "tool-result", toolCallId: "c9", content: [], isError: false }] } },
      },
    });
    expect(out[0].data).toMatchObject({ id: "c9", name: "connect_nodes", ok: true });
    expect(translator.knownToolNames()).toEqual({ c9: "connect_nodes" });
  });

  it("未知 callId 回退为 tool，不抛错", () => {
    const translator = createSessionEventTranslator("s1");
    const out = translator.translate({
      sessionId: "s1",
      event: {
        type: "tool/result",
        data: { message: { content: [{ type: "tool-result", toolCallId: "unknown", content: [], isError: false }] } },
      },
    });
    expect(out[0].data).toMatchObject({ name: "tool" });
  });
});

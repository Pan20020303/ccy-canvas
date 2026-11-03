import { describe, expect, it } from "vitest";

import { buildTimeline, canvasStepsToParts, finalReplyOf, previewText, runStepsToThreadParts, summarizeCanvasPatch, toRenderableUnits } from "./agent-timeline";
import type { TimelineEvent } from "./agent-timeline";

/** 从真实会话日志抄下来的典型事件序列（含 354 条增量的压缩版）。 */
function realisticEvents(): TimelineEvent[] {
  const events: TimelineEvent[] = [
    { id: 1, type: "conversation", data: { id: "conv-1" }, at: 1000 },
    { id: 2, type: "thought_delta", data: { delta: "先看" }, at: 1100 },
    { id: 3, type: "thought_delta", data: { delta: "画布" }, at: 1110 },
    { id: 4, type: "tool_call", data: { id: "c1", name: "canvas_overview", arguments: "{}" }, at: 1200 },
    { id: 5, type: "tool_result", data: { id: "c1", name: "canvas_overview", ok: true, result: "revision=0" }, at: 1250 },
    { id: 6, type: "message_delta", data: { delta: "好" }, at: 1300 },
    { id: 7, type: "message_delta", data: { delta: "的" }, at: 1310 },
    { id: 8, type: "tool_call", data: { id: "c2", name: "mcp__ccy__create_image_node", arguments: '{"prompt":"x"}' }, at: 1400 },
    { id: 9, type: "canvas_patch", data: { op: "add_node", node: { id: "n1", type: "image", data: { title: "图" } }, revision: 1, base_revision: 0 }, at: 1450 },
    { id: 10, type: "tool_result", data: { id: "c2", name: "create_image_node", ok: true, result: '{"ok":true}' }, at: 1460 },
    { id: 11, type: "usage", data: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }, at: 1500 },
    { id: 12, type: "message", data: { content: "已完成：新建 n1" }, at: 1600 },
    { id: 13, type: "done", data: { steps: 2 }, at: 1700 },
  ];
  return events;
}

describe("buildTimeline", () => {
  it("把连续增量合并成单个块，并记录原始片数", () => {
    const { steps } = buildTimeline(realisticEvents());
    const reasoning = steps.find((step) => step.kind === "reasoning");
    expect(reasoning).toMatchObject({ text: "先看画布", chunkCount: 2 });

    const messages = steps.filter((step) => step.kind === "message");
    // 前两条 message_delta 合并 + 最后一条完整 message
    expect(messages[0]).toMatchObject({ text: "好的", chunkCount: 2 });
    expect(messages[1]).toMatchObject({ text: "已完成：新建 n1", chunkCount: 0 });
  });

  it("按 callId 配对工具调用与结果，并保留步骤顺序", () => {
    const { steps } = buildTimeline(realisticEvents());
    const tools = steps.filter((step) => step.kind === "tool");
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ name: "canvas_overview", ok: true, result: "revision=0" });
    expect(tools[1]).toMatchObject({ name: "create_image_node", ok: true });
    // 原始 MCP 名保留在 rawName 里供排障
    expect(tools[1].rawName).toBe("mcp__ccy__create_image_node");
    // 工具结果不能变成额外步骤
    expect(steps.filter((step) => step.kind === "tool")).toHaveLength(2);
  });

  it("工具失败时记 error 而不是 result", () => {
    const { steps } = buildTimeline([
      { id: 1, type: "tool_call", data: { id: "c1", name: "create_node", arguments: "{}" }, at: 1 },
      { id: 2, type: "tool_result", data: { id: "c1", name: "create_node", ok: false, error: "boom" }, at: 2 },
    ]);
    expect(steps[0]).toMatchObject({ kind: "tool", ok: false, error: "boom" });
    expect((steps[0] as { result?: string }).result).toBeUndefined();
  });

  it("未配对的工具结果以 notice 呈现，不静默丢弃", () => {
    const { steps } = buildTimeline([
      { id: 1, type: "tool_result", data: { id: "orphan", name: "x", ok: true, result: "ok" }, at: 1 },
    ]);
    expect(steps[0].kind).toBe("notice");
    expect(JSON.stringify(steps[0])).toContain("orphan");
  });

  it("画布变更单列并给出可读摘要", () => {
    const { steps, summary } = buildTimeline(realisticEvents());
    const canvas = steps.filter((step) => step.kind === "canvas");
    expect(canvas).toHaveLength(1);
    expect(canvas[0]).toMatchObject({ op: "add_node", revision: 1, baseRevision: 0, summary: "n1 [image] 图" });
    expect(summary.canvasOps).toBe(1);
  });

  it("统计：工具数 / 增量数 / token / 时长 / 步数", () => {
    const { summary } = buildTimeline(realisticEvents());
    expect(summary).toMatchObject({
      status: "success",
      toolCalls: 2,
      canvasOps: 1,
      reasoningChunks: 2,
      messageChunks: 2,
      totalTokens: 120,
      steps: 2,
      durationMs: 700, // 首个事件 1000ms → 最后一个 1700ms
    });
  });

  it("error 变成 error 级 notice，不改写成成功", () => {
    const { steps, summary } = buildTimeline([
      { id: 1, type: "message", data: { content: "部分" }, at: 1 },
      { id: 2, type: "error", data: { message: "模型报错" }, at: 2 },
    ]);
    const notice = steps.find((step) => step.kind === "notice");
    expect(notice).toMatchObject({ level: "error", text: "模型报错" });
    // 没有 done 事件时状态不应被写成 success
    expect(summary.status).toBe("unknown");
  });

  it("thought 过程说明单独成条，不并进正文", () => {
    const { steps } = buildTimeline([
      { id: 1, type: "message_delta", data: { delta: "答" }, at: 1 },
      { id: 2, type: "thought", data: { content: "已加载技能：xxx" }, at: 2 },
      { id: 3, type: "message_delta", data: { delta: "案" }, at: 3 },
    ]);
    expect(steps.map((step) => step.kind)).toEqual(["message", "notice", "message"]);
  });

  it("连接层事件不进时间线", () => {
    const { steps } = buildTimeline([
      { id: 1, type: "conversation", data: { id: "c" }, at: 1 },
      { id: 2, type: "connection_status", data: { state: "reconnecting" }, at: 2 },
      { id: 3, type: "done", data: { steps: 1 }, at: 3 },
    ]);
    expect(steps).toHaveLength(0);
  });

  it("空事件流不炸，并给出保守默认步数", () => {
    const { steps, summary } = buildTimeline([]);
    expect(steps).toHaveLength(0);
    expect(summary.steps).toBe(1);
    expect(summary.durationMs).toBeNull();
  });

  it("大量增量被压成单块（避免工具调用被淹没）", () => {
    const events: TimelineEvent[] = [];
    for (let index = 0; index < 354; index++) {
      events.push({ id: index + 1, type: "thought_delta", data: { delta: "思" }, at: 1000 + index });
    }
    events.push({ id: 400, type: "tool_call", data: { id: "c", name: "canvas_overview", arguments: "{}" }, at: 2000 });
    const { steps, summary } = buildTimeline(events);
    expect(steps.filter((step) => step.kind === "reasoning")).toHaveLength(1);
    expect(steps.filter((step) => step.kind === "tool")).toHaveLength(1);
    expect(summary.reasoningChunks).toBe(354);
  });
});

describe("summarizeCanvasPatch", () => {
  it("覆盖各 op 的可读摘要", () => {
    expect(summarizeCanvasPatch({ op: "add_edge", edge: { source: "n2", target: "n1" } })).toBe("n2 → n1");
    expect(summarizeCanvasPatch({ op: "delete_node", node_id: "n3" })).toBe("n3");
    expect(summarizeCanvasPatch({ op: "move_node", node_id: "n1", position: { x: 5, y: 6 } })).toBe("n1 → (5, 6)");
    expect(summarizeCanvasPatch({ op: "patch_node_data", node_id: "n1", patch: { promptDraft: "x" } })).toBe(
      "n1 字段: promptDraft",
    );
    expect(summarizeCanvasPatch({ op: "run_node", node_id: "n1", model: "flux" })).toBe("n1 model=flux");
    expect(summarizeCanvasPatch({ op: "create_group", name: "镜头", node_ids: ["n1", "n2"] })).toBe("镜头: n1, n2");
    expect(summarizeCanvasPatch({ op: "unknown_op" })).toBe("unknown_op");
  });
});

describe("finalReplyOf", () => {
  it("取最后一条非空 message", () => {
    expect(finalReplyOf(realisticEvents())).toBe("已完成：新建 n1");
    expect(finalReplyOf([{ id: 1, type: "message", data: { content: "" }, at: 1 }])).toBe("");
    expect(finalReplyOf([])).toBe("");
  });
});

describe("previewText", () => {
  it("压成单行并截断", () => {
    expect(previewText("a\n\nb   c")).toBe("a b c");
    expect(previewText("x".repeat(300), 10)).toBe("xxxxxxxxxx…");
    expect(previewText(undefined)).toBe("");
  });
});

describe("runStepsToThreadParts（面板 → 线程 part 的唯一映射）", () => {
  const present = (patch: { op: string }, zh: boolean) => ({
    action: `动作:${patch.op}`,
    entity: "node",
    title: "标题",
    detail: "详情",
  });

  it("相邻思考合并成一个块（碎块太多是实际观感问题）", () => {
    const parts = runStepsToThreadParts(
      [
        { kind: "thought", id: "t1", content: "先看画布" },
        { kind: "thought", id: "t2", content: "再建节点" },
        { kind: "thought", id: "t3", content: "然后连线" },
      ],
      present,
      true,
    );
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({ type: "reasoning", text: "先看画布\n再建节点\n然后连线" });
  });

  it("被工具调用隔开的思考不合并（那是两段不同推理，顺序也不能乱）", () => {
    const parts = runStepsToThreadParts(
      [
        { kind: "thought", id: "t1", content: "第一段" },
        { kind: "tool", id: "tool1", invocation: { id: "c1", name: "canvas_overview", args: "{}", status: "success", output: "{}" } },
        { kind: "thought", id: "t2", content: "第二段" },
      ],
      present,
      true,
    );
    expect(parts.map((part) => part.type)).toEqual(["reasoning", "tool-call", "reasoning"]);
    expect((parts[0] as { text: string }).text).toBe("第一段");
    expect((parts[2] as { text: string }).text).toBe("第二段");
  });

  it("空白思考被丢弃，不会产生空块", () => {
    const parts = runStepsToThreadParts(
      [
        { kind: "thought", id: "t1", content: "   " },
        { kind: "thought", id: "t2", content: "有内容" },
      ],
      present,
      true,
    );
    expect(parts).toHaveLength(1);
    expect((parts[0] as { text: string }).text).toBe("有内容");
  });

  it("工具调用映射成 tool-call，running 时不带 result", () => {
    const running = runStepsToThreadParts(
      [{ kind: "tool", id: "x", invocation: { id: "c1", name: "create_text_node", args: '{"a":1}', status: "running" } }],
      present,
      true,
    );
    expect(running[0]).toMatchObject({ type: "tool-call", toolCallId: "c1", toolName: "create_text_node", argsText: '{"a":1}' });
    expect((running[0] as { result?: unknown }).result).toBeUndefined();

    const done = runStepsToThreadParts(
      [{ kind: "tool", id: "x", invocation: { id: "c1", name: "t", args: "", status: "success", output: "ok" } }],
      present,
      true,
    );
    expect(done[0]).toMatchObject({ result: "ok", argsText: "{}", isError: false });

    const failed = runStepsToThreadParts(
      [{ kind: "tool", id: "x", invocation: { id: "c1", name: "t", args: "{}", status: "error", output: "boom" } }],
      present,
      true,
    );
    expect(failed[0]).toMatchObject({ isError: true });
  });

  it("画布变更按发生顺序插在工具之间", () => {
    const parts = runStepsToThreadParts(
      [
        { kind: "thought", id: "t1", content: "思考" },
        { kind: "tool", id: "tool1", invocation: { id: "c1", name: "create_image_node", args: "{}", status: "success", output: "{}" } },
        { kind: "canvas", id: "cv1", patch: { op: "add_node", node: { id: "n1", type: "imageNode", data: {} }, revision: 1 } },
        { kind: "tool", id: "tool2", invocation: { id: "c2", name: "connect_nodes", args: "{}", status: "success", output: "{}" } },
      ],
      present,
      true,
    );
    expect(parts.map((part) => part.type)).toEqual(["reasoning", "tool-call", "data-canvas-op", "tool-call"]);
  });

  it("空输入返回空数组", () => {
    expect(runStepsToThreadParts([], present, true)).toEqual([]);
  });

  it("容忍畸形步骤（缺 invocation / 缺字段）不抛错", () => {
    expect(() =>
      runStepsToThreadParts([{ kind: "tool", id: "x" }, { kind: "canvas", id: "y" }], present, true),
    ).not.toThrow();
  });
});

describe("canvasStepsToParts", () => {
  /** 与真实 presenter 同形的假实现，避免测试耦合到文案细节。 */
  const present = (patch: { op: string }, zh: boolean) => ({
    action: zh ? `动作:${patch.op}` : `action:${patch.op}`,
    entity: "node",
    title: `标题:${patch.op}`,
    detail: "详情",
    nodeId: "n1",
    position: "0, 0",
  });

  it("只挑 canvas 步骤，保留顺序与 revision", () => {
    const parts = canvasStepsToParts(
      [
        { kind: "thought", id: "t1", content: "x" },
        { kind: "canvas", id: "c1", patch: { op: "add_node", revision: 1 } },
        { kind: "tool", id: "tool1", invocation: {} },
        { kind: "canvas", id: "c2", patch: { op: "add_edge", revision: 2 } },
      ],
      present,
      true,
    );
    expect(parts.map((part) => part.data.op)).toEqual(["add_node", "add_edge"]);
    expect(parts.map((part) => part.data.revision)).toEqual([1, 2]);
    // 必须是 data- 前缀：运行时的 convertDataPrefixedPart 靠它翻成
    // { type:"data", name:"canvas-op", data }（写 type:"data" 会运行时抛错）。
    expect(parts[0]).toMatchObject({ type: "data-canvas-op" });
    expect(parts[0].data).toMatchObject({ id: "c1", action: "动作:add_node" });
  });

  it("本地化跟 zh 走", () => {
    const zh = canvasStepsToParts([{ kind: "canvas", id: "c", patch: { op: "add_node" } }], present, true);
    const en = canvasStepsToParts([{ kind: "canvas", id: "c", patch: { op: "add_node" } }], present, false);
    expect(zh[0].data.action).toBe("动作:add_node");
    expect(en[0].data.action).toBe("action:add_node");
  });

  it("呈现函数抛错时跳过该条，而不是让整条消息渲染失败", () => {
    const boom = () => {
      throw new Error("presenter boom");
    };
    const parts = canvasStepsToParts(
      [
        { kind: "canvas", id: "bad", patch: { op: "weird" } },
        { kind: "canvas", id: "good", patch: { op: "add_node" } },
      ],
      boom,
      true,
    );
    expect(parts).toHaveLength(0);
  });

  it("缺 patch 的步骤被跳过，不产生半个 part", () => {
    const parts = canvasStepsToParts([{ kind: "canvas", id: "c" }], present, true);
    expect(parts).toHaveLength(0);
  });

  it("空输入返回空数组", () => {
    expect(canvasStepsToParts([], present, true)).toEqual([]);
  });
});

describe("toRenderableUnits", () => {
  it("把步骤映射成可渲染单元且不丢信息", () => {
    const { steps } = buildTimeline(realisticEvents());
    const units = toRenderableUnits({ steps, summary: buildTimeline(realisticEvents()).summary });
    const kinds = units.map((unit) => unit.type);
    expect(kinds).toContain("thinking");
    expect(kinds).toContain("tool");
    expect(kinds).toContain("canvas");
    expect(kinds).toContain("answer");
    expect(kinds).toContain("usage");
    const tool = units.find((unit) => unit.type === "tool");
    expect(tool).toMatchObject({ name: "canvas_overview", ok: true });
  });
});

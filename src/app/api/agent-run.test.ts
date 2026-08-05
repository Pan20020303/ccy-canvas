// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  advanceCanvasPatchRevision,
  getActiveAgentJob,
  resumeAgentJob,
  runAgent,
  type AgentEventMeta,
  type AgentSSEEvent,
} from "./agent-run";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("durable agent jobs", () => {
  it("accepts contiguous canvas patches and rejects duplicates or gaps", () => {
    const first = advanceCanvasPatchRevision(0, {
      op: "move_node",
      node_id: "n1",
      position: { x: 10, y: 20 },
      base_revision: 0,
      revision: 1,
    });
    expect(first).toEqual({ accepted: true, nextRevision: 1 });

    const duplicate = advanceCanvasPatchRevision(first.nextRevision, {
      op: "delete_node",
      node_id: "n1",
      base_revision: 0,
      revision: 1,
    });
    expect(duplicate.accepted).toBe(false);

    const gap = advanceCanvasPatchRevision(first.nextRevision, {
      op: "create_group",
      node_ids: ["n1", "n2"],
      base_revision: 2,
      revision: 3,
    });
    expect(gap.accepted).toBe(false);
  });

  it("bootstraps a resumed stream and accepts legacy unversioned patches", () => {
    expect(advanceCanvasPatchRevision(null, {
      op: "delete_node",
      node_id: "n1",
      base_revision: 8,
      revision: 9,
    })).toEqual({ accepted: true, nextRevision: 9 });
    expect(advanceCanvasPatchRevision(9, { op: "delete_node", node_id: "legacy" }))
      .toEqual({ accepted: true, nextRevision: 9 });
  });

  it("restores the saved event cursor", () => {
    localStorage.setItem("ccy:agent-job:agent-1", JSON.stringify({
      agentId: "agent-1",
      jobId: "job-1",
      conversationId: "conversation-1",
      after: 17,
      message: "继续整理分镜",
    }));

    expect(getActiveAgentJob("agent-1")).toEqual({
      agentId: "agent-1",
      jobId: "job-1",
      conversationId: "conversation-1",
      after: 17,
      message: "继续整理分镜",
    });
  });

  it("unwraps the API envelope and observes the persisted SSE stream", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { job_id: "job-2", conversation_id: "conversation-2", status: "queued" },
        request_id: "req-test",
      }), { status: 202, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(
        "id: 1\nevent: thought_delta\ndata: {\"delta\":\"正在\"}\n\n"
          + "id: 2\nevent: thought_delta\ndata: {\"delta\":\"处理\"}\n\n"
          + "id: 3\nevent: done\ndata: {\"steps\":1}\n\n",
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ));
    vi.stubGlobal("fetch", fetchMock);
    const events: AgentSSEEvent[] = [];

    const stop = await runAgent("agent-2", {
      message: "（参考画布节点：long-hash.jpg#node-1）\n生成分镜",
      displayMessage: "生成分镜",
      nodes: [],
      edges: [],
    }, (event) => events.push(event));

    await vi.waitFor(() => expect(events.some((event) => event.type === "done")).toBe(true));
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/app/agents/agent-2/jobs");
    const sentBody = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(sentBody.message).toContain("long-hash.jpg#node-1");
    expect(sentBody).not.toHaveProperty("displayMessage");
    expect(String(fetchMock.mock.calls[1][0])).toContain("/api/app/agent-jobs/job-2/events?after=0");
    expect(events[0]).toEqual({ type: "conversation", data: { id: "conversation-2" } });
    expect(events.filter((event) => event.type === "thought_delta")).toEqual([
      { type: "thought_delta", data: { delta: "正在处理" } },
    ]);
    expect(getActiveAgentJob("agent-2")).toBeNull();
    stop();
  });

  it("finishes from durable status when the SSE done frame is missing", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { job_id: "job-3", conversation_id: "conversation-3", status: "queued" },
      }), { status: 202, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response("", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: { status: "success", final_reply: "你好，我在。", steps: 1 },
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const events: AgentSSEEvent[] = [];

    const stop = await runAgent("agent-3", {
      message: "你好",
      nodes: [],
      edges: [],
    }, (event) => events.push(event));

    await vi.waitFor(() => expect(events.some((event) => event.type === "done")).toBe(true));
    expect(events).toContainEqual({ type: "message", data: { content: "你好，我在。" } });
    expect(getActiveAgentJob("agent-3")).toBeNull();
    stop();
  });

  it("replays the complete process on resume and marks already-seen canvas events", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(
      "id: 10\nevent: thought\ndata: {\"content\":\"分析画面\"}\n\n"
        + "id: 11\nevent: tool_call\ndata: {\"id\":\"tool-1\",\"name\":\"analyze_image\",\"arguments\":\"{}\"}\n\n"
        + "id: 12\nevent: canvas_patch\ndata: {\"op\":\"add_node\",\"node\":{\"id\":\"node-1\"}}\n\n"
        + "id: 13\nevent: done\ndata: {\"steps\":2}\n\n",
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const observed: Array<{ event: AgentSSEEvent; meta?: AgentEventMeta }> = [];

    const stop = await resumeAgentJob({
      agentId: "agent-4",
      jobId: "job-4",
      conversationId: "conversation-4",
      after: 12,
    }, (event, meta) => observed.push({ event, meta }));

    await vi.waitFor(() => expect(observed.some(({ event }) => event.type === "done")).toBe(true));
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/app/agent-jobs/job-4/events?after=0");
    expect(observed.find(({ event }) => event.type === "tool_call")?.meta?.replayed).toBe(true);
    expect(observed.find(({ event }) => event.type === "canvas_patch")?.meta?.replayed).toBe(true);
    expect(observed.find(({ event }) => event.type === "done")?.meta?.replayed).toBe(false);
    stop();
  });
});

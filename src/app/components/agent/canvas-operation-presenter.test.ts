import { describe, expect, it } from "vitest";

import { presentCanvasOperation } from "./canvas-operation-presenter";

describe("presentCanvasOperation", () => {
  it("turns an internal add_node patch into a concise Chinese operation", () => {
    const result = presentCanvasOperation({
      op: "add_node",
      node: {
        id: "agent-node-1",
        type: "videoNode",
        position: { x: 1700.4, y: -499.6 },
        data: { customTitle: "15 秒视频提示词" },
      },
    }, true);

    expect(result).toEqual({
      action: "已新增",
      entity: "video",
      title: "15 秒视频提示词",
      detail: "视频节点",
      nodeId: "agent-node-1",
      position: "1700, -500",
    });
  });

  it("uses a compact content preview when a node has no explicit title", () => {
    const result = presentCanvasOperation({
      op: "add_node",
      node: {
        id: "agent-node-2",
        type: "textNode",
        position: { x: 0, y: 0 },
        data: { content: "第一行\n第二行，这是一段用于测试截断的长文本内容，后面还有更多更多更多更多的内容需要被隐藏" },
      },
    }, true);

    expect(result.entity).toBe("text");
    expect(result.title).not.toContain("\n");
    expect(result.title.endsWith("…")).toBe(true);
  });

  it("describes connections without exposing the raw operation name", () => {
    const result = presentCanvasOperation({
      op: "add_edge",
      edge: { id: "edge-1", source: "node-a", target: "node-b" },
    }, true);

    expect(result.action).toBe("已连接");
    expect(result.title).toBe("节点连接");
    expect(result.detail).toBe("node-a → node-b");
  });
});

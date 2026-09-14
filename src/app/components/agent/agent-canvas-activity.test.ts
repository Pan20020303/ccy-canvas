import { describe, expect, it } from "vitest";

import { describeAgentCanvasPatch } from "./agent-canvas-activity";

describe("describeAgentCanvasPatch", () => {
  it("maps a newly-created image node to the image generation activity", () => {
    const result = describeAgentCanvasPatch({
      op: "add_node",
      node: {
        id: "image-1",
        type: "imageNode",
        position: { x: 120, y: 80 },
        data: { customTitle: "角色定妆照" },
      },
    }, [], true);

    expect(result).toMatchObject({
      entity: "image",
      title: "正在生成图片",
      detail: "图片节点",
      nodeId: "image-1",
    });
  });

  it("uses the existing target node type when the agent starts a node", () => {
    const result = describeAgentCanvasPatch({
      op: "run_node",
      node_id: "video-1",
      model: "grok-imagine-video-1.5-fast",
    }, [{
      id: "video-1",
      type: "videoNode",
      position: { x: 0, y: 0 },
      data: {},
    }], true);

    expect(result).toMatchObject({
      entity: "video",
      title: "正在生成视频",
      nodeId: "video-1",
    });
  });
});

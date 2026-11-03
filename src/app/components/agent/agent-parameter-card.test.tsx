import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { PendingRunCard } from "../AgentRunPanel";

describe("agent image parameter confirmation card", () => {
  it("shows the full image request, references, and editable model parameters before approval", () => {
    const markup = renderToStaticMarkup(
      <PendingRunCard
        step={{
          kind: "pending_run",
          id: "pending-1",
          nodeId: "image-1",
          nodeType: "imageNode",
          nodeTitle: "角色三视图",
          serviceType: "image",
          prompt: "正面、侧面、背面三视图，保持服装一致。",
          availableModels: ["doubao-seedream-5-0-pro-260628"],
          chosenModel: "doubao-seedream-5-0-pro-260628",
          aspectRatio: "21:9",
          resolution: "2k",
          referenceImages: ["/uploads/reference.png"],
          status: "pending",
        }}
        zh
        onConfirm={vi.fn()}
        onSkip={vi.fn()}
        onPickModel={vi.fn()}
        onPickAspectRatio={vi.fn()}
        onPickResolution={vi.fn()}
        modelDisplayName={(model) => model}
      />,
    );

    expect(markup).toContain("图片生成确认");
    expect(markup).toContain("角色三视图");
    expect(markup).toContain("正面、侧面、背面三视图，保持服装一致。");
    expect(markup).toContain("参考图 1 张");
    expect(markup).toContain("21:9");
    expect(markup).toContain("2K");
    expect(markup).toContain("确认并生成");
  });
});

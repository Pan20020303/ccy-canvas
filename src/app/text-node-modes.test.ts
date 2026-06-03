import { describe, expect, it } from "vitest";

import {
  canUseReversePrompt,
  filterReversePromptModels,
  getFirstUpstreamReferenceImage,
  getTextNodeMode,
  splitFilenameExtension,
} from "./text-node-modes";

describe("text node modes", () => {
  it("defaults text node mode to chooser", () => {
    expect(getTextNodeMode(undefined)).toBe("chooser");
  });

  it("enables reverse prompt only when a reference image exists", () => {
    expect(canUseReversePrompt([] as any)).toBe(false);
    expect(
      canUseReversePrompt([
        { id: "n1", type: "referenceImageNode", data: { url: "/uploads/a.png" } },
      ] as any),
    ).toBe(true);
  });

  it("uses only the first upstream reference image", () => {
    const result = getFirstUpstreamReferenceImage([
      { id: "v1", type: "referenceVideoNode", data: { url: "/uploads/v.mp4" } },
      { id: "i1", type: "referenceImageNode", data: { url: "/uploads/a.png" } },
      { id: "i2", type: "referenceImageNode", data: { url: "/uploads/b.png" } },
    ] as any);

    expect((result?.data as any)?.url).toBe("/uploads/a.png");
  });

  it("filters reverse-prompt models to vision-capable entries only", () => {
    const result = filterReversePromptModels([
      { service_type: "image", vendor: "OpenAI", name: "plain-image", model_list: ["dall-e-3"], default_model: "", id: "a", priority: 1 },
      { service_type: "image", vendor: "Zhipu", name: "GVLM 3.1", model_list: ["gvlm-3.1"], default_model: "", id: "b", priority: 1 },
      { service_type: "text", vendor: "OpenAI", name: "gpt-4.1-mini", model_list: ["gpt-4.1-mini"], default_model: "", id: "c", priority: 1 },
    ] as any);

    expect(result.map((item) => item.name)).toEqual(["GVLM 3.1"]);
  });

  it("splits filename extension while preserving extension semantics", () => {
    expect(splitFilenameExtension("demo.png")).toEqual({ basename: "demo", extension: ".png" });
    expect(splitFilenameExtension("story")).toEqual({ basename: "story", extension: "" });
  });
});

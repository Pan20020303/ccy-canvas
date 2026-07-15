import { describe, expect, it } from "vitest";

import { canSubmitEmptyPromptForReferences } from "./CustomNodes";

describe("canSubmitEmptyPromptForReferences", () => {
  it("allows video generation with connected references and an empty prompt", () => {
    expect(canSubmitEmptyPromptForReferences("video", { images: 1, videos: 0 })).toBe(true);
  });

  it("still blocks empty prompts when no reference media is connected", () => {
    expect(canSubmitEmptyPromptForReferences("video", { images: 0, videos: 0 })).toBe(false);
    expect(canSubmitEmptyPromptForReferences("text", { images: 1, videos: 0 })).toBe(false);
  });
});

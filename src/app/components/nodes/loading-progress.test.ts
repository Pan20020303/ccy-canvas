import { describe, expect, it } from "vitest";

import { getGenerationProgressPercent } from "./loading-progress";

describe("getGenerationProgressPercent", () => {
  it("starts with a small visible progress value", () => {
    expect(getGenerationProgressPercent(1000, 1000)).toBe(3);
  });

  it("increases over time but does not prematurely reach 100", () => {
    expect(getGenerationProgressPercent(0, 1_000)).toBeGreaterThan(3);
    expect(getGenerationProgressPercent(0, 30_000)).toBeLessThan(95);
    expect(getGenerationProgressPercent(0, 5 * 60_000)).toBe(95);
  });
});

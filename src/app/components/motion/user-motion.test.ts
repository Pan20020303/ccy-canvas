import { describe, expect, it } from "vitest";

import { getUserMotionPreset, userMotionTokens } from "./user-motion";

describe("user motion tokens", () => {
  it("exposes the shared timing and easing values used by frontend motion", () => {
    expect(userMotionTokens.enter.fast).toBe(0.28);
    expect(userMotionTokens.enter.base).toBe(0.45);
    expect(userMotionTokens.enter.slow).toBe(0.8);
    expect(userMotionTokens.stagger.tight).toBe(0.06);
    expect(userMotionTokens.ease.emphasized).toBe("power3.out");
  });

  it("returns travel-based motion values when reduced motion is off", () => {
    expect(getUserMotionPreset(false)).toEqual({
      autoAlpha: 0,
      x: 0,
      y: 18,
      scale: 0.985,
      duration: 0.45,
      ease: "power2.out",
    });
  });

  it("collapses travel-heavy animation when reduced motion is on", () => {
    expect(getUserMotionPreset(true)).toEqual({
      autoAlpha: 1,
      x: 0,
      y: 0,
      scale: 1,
      duration: 0.01,
      ease: "none",
    });
  });
});

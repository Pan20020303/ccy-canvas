import { describe, expect, it } from "vitest";

import {
  isModeSatisfied,
  modesForModel,
  firstSatisfiedMode,
  happyHorseSuffixSatisfied,
  REFERENCE_MODE_SPECS,
  REFERENCE_MODE_ORDER,
  type ReferenceModeKey,
} from "./reference-modes";

describe("happyHorseSuffixSatisfied", () => {
  it("t2v accepts no references", () => {
    expect(happyHorseSuffixSatisfied("t2v", { images: 0, videos: 0 })).toBe(true);
    expect(happyHorseSuffixSatisfied("t2v", { images: 1, videos: 0 })).toBe(false);
    expect(happyHorseSuffixSatisfied("t2v", { images: 0, videos: 1 })).toBe(false);
  });

  it("i2v needs exactly 1 image and no video", () => {
    expect(happyHorseSuffixSatisfied("i2v", { images: 0, videos: 0 })).toBe(false);
    expect(happyHorseSuffixSatisfied("i2v", { images: 1, videos: 0 })).toBe(true);
    expect(happyHorseSuffixSatisfied("i2v", { images: 2, videos: 0 })).toBe(false);
    expect(happyHorseSuffixSatisfied("i2v", { images: 1, videos: 1 })).toBe(false);
  });

  it("r2v needs 1-9 images and no video", () => {
    expect(happyHorseSuffixSatisfied("r2v", { images: 0, videos: 0 })).toBe(false);
    expect(happyHorseSuffixSatisfied("r2v", { images: 1, videos: 0 })).toBe(true);
    expect(happyHorseSuffixSatisfied("r2v", { images: 9, videos: 0 })).toBe(true);
    expect(happyHorseSuffixSatisfied("r2v", { images: 10, videos: 0 })).toBe(false);
    expect(happyHorseSuffixSatisfied("r2v", { images: 1, videos: 1 })).toBe(false);
  });

  it("video-edit needs exactly 1 video and at most 5 images", () => {
    expect(happyHorseSuffixSatisfied("video-edit", { images: 0, videos: 1 })).toBe(true);
    expect(happyHorseSuffixSatisfied("video-edit", { images: 5, videos: 1 })).toBe(true);
    expect(happyHorseSuffixSatisfied("video-edit", { images: 6, videos: 1 })).toBe(false);
    expect(happyHorseSuffixSatisfied("video-edit", { images: 0, videos: 0 })).toBe(false);
    expect(happyHorseSuffixSatisfied("video-edit", { images: 0, videos: 2 })).toBe(false);
  });
});

describe("isModeSatisfied", () => {
  it("first-last needs 1-2 images and no videos", () => {
    expect(isModeSatisfied("first-last", { images: 0, videos: 0 })).toBe(false);
    expect(isModeSatisfied("first-last", { images: 1, videos: 0 })).toBe(true);
    expect(isModeSatisfied("first-last", { images: 2, videos: 0 })).toBe(true);
    expect(isModeSatisfied("first-last", { images: 3, videos: 0 })).toBe(false);
    expect(isModeSatisfied("first-last", { images: 1, videos: 1 })).toBe(false);
  });

  it("motion-mimic needs exactly 1 video", () => {
    expect(isModeSatisfied("motion-mimic", { images: 0, videos: 0 })).toBe(false);
    expect(isModeSatisfied("motion-mimic", { images: 0, videos: 1 })).toBe(true);
    expect(isModeSatisfied("motion-mimic", { images: 1, videos: 1 })).toBe(true);
    expect(isModeSatisfied("motion-mimic", { images: 2, videos: 1 })).toBe(false);
    expect(isModeSatisfied("motion-mimic", { images: 0, videos: 2 })).toBe(false);
  });

  it("video-edit needs exactly 1 video", () => {
    expect(isModeSatisfied("video-edit", { images: 0, videos: 1 })).toBe(true);
    expect(isModeSatisfied("video-edit", { images: 0, videos: 0 })).toBe(false);
  });

  it("multi-image needs at least 1 image", () => {
    expect(isModeSatisfied("multi-image", { images: 0, videos: 0 })).toBe(false);
    expect(isModeSatisfied("multi-image", { images: 1, videos: 0 })).toBe(true);
    expect(isModeSatisfied("multi-image", { images: 9, videos: 0 })).toBe(true);
  });
});

describe("modesForModel", () => {
  it("falls back to multi-image when model declares nothing", () => {
    expect(modesForModel(undefined)).toEqual(["multi-image"]);
    expect(modesForModel([])).toEqual(["multi-image"]);
  });

  it("returns declared modes in registry order", () => {
    // Pass in an out-of-order subset; output should follow REFERENCE_MODE_ORDER.
    const got = modesForModel(["video-edit", "first-last", "multi-image"]);
    expect(got).toEqual(["first-last", "multi-image", "video-edit"]);
  });

  it("ignores unknown keys", () => {
    expect(modesForModel(["nonsense", "first-last"])).toEqual(["first-last"]);
  });
});

describe("firstSatisfiedMode", () => {
  it("returns the first candidate that the inputs satisfy", () => {
    const candidates: ReferenceModeKey[] = ["motion-mimic", "first-last", "multi-image"];
    // 1 image, no video → motion-mimic fails, first-last passes.
    expect(firstSatisfiedMode(candidates, { images: 1, videos: 0 })).toBe("first-last");
  });

  it("falls back to the first candidate when none are satisfied", () => {
    const candidates: ReferenceModeKey[] = ["motion-mimic", "video-edit"];
    // No inputs at all → nothing satisfied → first candidate.
    expect(firstSatisfiedMode(candidates, { images: 0, videos: 0 })).toBe("motion-mimic");
  });

  it("returns undefined for an empty candidate list", () => {
    expect(firstSatisfiedMode([], { images: 5, videos: 5 })).toBeUndefined();
  });
});

describe("registry integrity", () => {
  it("every ordered key has a spec and they agree", () => {
    for (const key of REFERENCE_MODE_ORDER) {
      const spec = REFERENCE_MODE_SPECS[key];
      expect(spec).toBeDefined();
      expect(spec.key).toBe(key);
      expect(spec.backendMode).toBeTruthy();
    }
  });
});

import { describe, expect, it } from "vitest";

import {
  buildModelRequestBody,
  getModelTemplate,
  getTemplatesForServiceType,
  modelTemplates,
} from "./model-templates";

describe("model templates", () => {
  it("looks up a concrete model template by model name", () => {
    const template = getModelTemplate("runway-gen3");
    expect(template?.serviceType).toBe("video");
    expect(template?.supportsDuration).toBe(true);
  });

  it("returns only templates for the requested service type", () => {
    const templates = getTemplatesForServiceType("image");
    expect(templates.every((template) => template.serviceType === "image")).toBe(true);
  });

  it("keeps vendor and model controls separate", () => {
    const template = getModelTemplate("gpt-image-2");
    expect(template?.vendor).toBeTruthy();
    expect(template?.modelName).toBe("gpt-image-2");
  });

  it("defines duration support for video templates only when the model supports it", () => {
    expect(getModelTemplate("runway-gen3")?.durationRange?.defaultValue).toBe(5);
    expect(getModelTemplate("gpt-image-2")?.durationRange).toBeUndefined();
  });

  it("recognizes configured sora video models as template-driven video models", () => {
    const template = getModelTemplate("sora-v3-fast");
    expect(template?.serviceType).toBe("video");
    expect(template?.supportsDuration).toBe(true);
    expect(template?.supportsAspectRatio).toBe(true);
    expect(template?.supportsResolution).toBe(true);
  });

  it("matches sora-v3-fast options from relay-video-test html", () => {
    const template = getModelTemplate("sora-v3-fast");
    expect(template?.supportsMode).toBeFalsy();
    expect(template?.supportsAutoAspect).toBeFalsy();
    expect(template?.aspectRatioOptions).toEqual(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]);
    expect(template?.resolutionOptions).toEqual(["480p", "720p"]);
    expect(template?.durationRange).toEqual({
      min: 5,
      max: 15,
      step: 1,
      defaultValue: 5,
    });
  });

  it("matches sora-2 options from relay-video-test html", () => {
    const template = getModelTemplate("sora-2");
    expect(template?.supportsMode).toBeFalsy();
    expect(template?.supportsAutoAspect).toBeFalsy();
    expect(template?.aspectRatioOptions).toEqual(["16:9", "9:16"]);
    expect(template?.resolutionOptions).toEqual(["720p"]);
    expect(template?.durationRange).toEqual({
      min: 4,
      max: 12,
      step: 4,
      defaultValue: 8,
    });
  });

  it("exposes aspect ratio controls for HappyHorse image-to-video models", () => {
    for (const model of ["happyhorse-1.1-i2v", "happyhorse-1.0-i2v"]) {
      const template = getModelTemplate(model);
      expect(template?.supportsAspectRatio).toBe(true);
      expect(template?.aspectRatioOptions).toEqual(["16:9", "9:16", "1:1", "4:3", "3:4", "4:5", "5:4", "9:21", "21:9"]);
      expect(template?.defaults?.aspectRatio).toBe("16:9");
    }
  });

  it("exports a non-empty template registry", () => {
    expect(Object.keys(modelTemplates).length).toBeGreaterThan(0);
  });

  it("builds a request body from supported model params only", () => {
    const template = getModelTemplate("runway-gen3");
    expect(
      buildModelRequestBody(template, "test prompt", {
        model: "runway-gen3",
        mode: "Fast",
        resolution: "720p",
        aspectRatio: "5:4",
        durationSeconds: 10,
      }),
    ).toMatchObject({
      prompt: "test prompt",
      model: "runway-gen3",
      mode: "Fast",
      size: "720p",
      aspect_ratio: "5:4",
      duration: 10,
    });
  });

  it("uses quality controls for gpt-image-2 instead of legacy resolution presets", () => {
    const template = getModelTemplate("gpt-image-2");
    expect(template?.supportsQuality).toBe(true);
    expect(template?.qualityOptions).toEqual(["Auto", "High", "Medium", "Low"]);
    expect(template?.supportsResolution).not.toBe(true);
  });

  it("exposes quality controls for volcengine seedream image models", () => {
    const template = getModelTemplate("doubao-seedream-5-0-260128");
    expect(template?.supportsQuality).toBe(true);
    expect(template?.qualityOptions).toEqual(["Auto", "High", "Medium", "Low"]);
    expect(template?.supportsAspectRatio).toBe(true);
  });
});

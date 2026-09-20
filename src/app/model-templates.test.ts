import { describe, expect, it } from "vitest";
import { isModeSatisfied } from "./reference-modes";

import { VENDOR_TEMPLATES } from "./api/providerConfigs";
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

  it("matches the ManjuAPI MiniMax H3 video contract", () => {
    const template = getModelTemplate("MiniMax H3");
    expect(template?.vendor).toBe("ManjuAPI");
    expect(template?.serviceType).toBe("video");
    expect(template?.resolutionOptions).toEqual(["2k"]);
    expect(template?.aspectRatioOptions).toEqual(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);
    expect(template?.durationOptions).toEqual([10, 15]);
    expect(template?.referenceModes).toEqual(["text-to-video", "multi-image"]);
    expect(template?.referenceImageRange).toEqual({ min: 2, max: 5 });
    expect(template?.defaults).toEqual({ resolution: "2k", aspectRatio: "16:9" });
  });

  it("keeps extended H3 reference modes on the local ComfyUI model", () => {
    const local = getModelTemplate("minimax-h3-t2v-ref2v-turbo-local");
    expect(local?.vendor).toBe("ComfyUI");
    expect(local?.referenceModes).toEqual(["text-to-video", "multi-image", "three-view", "all-in-one"]);
    expect(local?.referenceImageRange).toEqual({ min: 1, max: 9 });
    expect(local?.resolutionOptions).toEqual(["480p", "768p"]);
    expect(local?.qualityOptions).toEqual(["极速", "官方8步", "音画分采8步", "均衡二采", "高质二采"]);
  });

  it.each(["provider", "model"] as const)("preserves separate H3 audio/video sampling through the %s schema", (schemaLevel) => {
    const model = "minimax-h3-t2v-ref2v-turbo-local";
    const schema = VENDOR_TEMPLATES.video.find((item) => item.models.includes(model))?.parameterSchema;
    expect(schema).toBeDefined();
    const template = getModelTemplate(model, {
      service_type: "video",
      vendor: "ComfyUI",
      parameter_schema: schemaLevel === "provider" ? { ...schema, models: undefined } : schema,
    });

    expect(template?.supportsQuality).toBe(true);
    expect(template?.qualityOptions).toContain("音画分采8步");
    expect(template?.defaults?.quality).toBe("极速");
    expect(buildModelRequestBody(template, "测试对白与环境声", {
      model,
      quality: "音画分采8步",
      resolution: "768p",
      durationSeconds: 5,
    })).toMatchObject({ model, quality: "音画分采8步", size: "768p", duration: 5 });
  });

  it("exposes the local MiniMax H3 long-video Director", () => {
    const director = getModelTemplate("minimax-h3-director-local");
    expect(director).toMatchObject({
      vendor: "ComfyUI",
      durationRange: { min: 15, max: 120, step: 5, defaultValue: 30 },
      qualityOptions: ["极速", "均衡二采", "高质二采"],
      referenceImageRange: { min: 1, max: 9 },
      defaults: { resolution: "480p", aspectRatio: "9:16", quality: "极速" },
    });
  });

  it("exposes both U09 dual-stage workflows and the drama workbench", () => {
    expect(getModelTemplate("minimax-h3-u09-redraw-dual-fast-local")).toMatchObject({
      durationRange: { min: 1, max: 15, step: 1, defaultValue: 5 },
      qualityOptions: ["平衡 8+3步", "精细 12+4步"],
      defaults: { resolution: "768p" },
    });
    expect(getModelTemplate("minimax-h3-u09-no-codec-dual-upscale-local")).toMatchObject({
      durationRange: { min: 1, max: 15, step: 1, defaultValue: 5 },
      qualityOptions: ["原生 20+3步", "精细 24+4步"],
      defaults: { resolution: "768p" },
    });
    expect(getModelTemplate("minimax-h3-drama-workbench-local")).toMatchObject({
      durationRange: { min: 15, max: 120, step: 5, defaultValue: 30 },
      referenceImageRange: { min: 1, max: 9 },
    });
  });

  it("exposes the local LTX-2.5 production range", () => {
    const local = getModelTemplate("ltx-2.5-distilled-av-local");
    expect(local?.durationRange).toEqual({ min: 3, max: 15, step: 1, defaultValue: 5 });
    expect(local?.durationOptions).toBeUndefined();
    expect(local?.referenceModes).toEqual(["text-to-video", "multi-image"]);
    expect(local?.referenceImageRange).toEqual({ min: 0, max: 6 });
  });

  it("matches the ManjuAPI Grok Imagine video contracts", () => {
    const text = getModelTemplate("grok-imagine-video");
    expect(text).toMatchObject({
      serviceType: "video",
      resolutionOptions: ["720p"],
      aspectRatioOptions: ["16:9", "9:16"],
      durationOptions: [6, 10],
      referenceModes: ["text-to-video"],
    });

    const fast = getModelTemplate("grok-imagine-video-1.5-fast");
    expect(fast).toMatchObject({
      vendor: "ManjuAPI",
      resolutionOptions: ["720p"],
      durationOptions: [6, 10, 15],
      referenceModes: ["first-frame", "multi-image"],
      referenceImageRange: { min: 2, max: 7 },
    });

    const preview = getModelTemplate("grok-imagine-video-1.5-preview");
    expect(preview).toMatchObject({
      vendor: "ManjuAPI",
      resolutionOptions: ["720p"],
      durationOptions: [10, 15],
      referenceModes: ["first-frame"],
    });
  });

  it("exposes official Seedance 2.5 controls and accepts the one-image/six-video contract", () => {
    const template = getModelTemplate("doubao-seedance-2-5-260628");
    expect(template).toMatchObject({
      vendor: "Volcengine", serviceType: "video",
      resolutionOptions: ["480p", "720p", "1080p"],
      durationRange: { min: 4, max: 30, step: 1, defaultValue: 5 },
      referenceImageRange: { min: 1, max: 30 },
      audioSettingOptions: ["on", "off"],
      supportsOutputFormat: true, outputFormatOptions: ["mp4", "mov"],
    });
    const override = template?.referenceRequirements?.["all-in-one"];
    expect(isModeSatisfied("all-in-one", { images: 1, videos: 6 }, override)).toBe(true);
    expect(isModeSatisfied("all-in-one", { images: 30, videos: 10, audios: 10 }, override)).toBe(true);
    for (const counts of [{ images: 31, videos: 0 }, { images: 0, videos: 11 }, { images: 0, videos: 0, audios: 11 }]) {
      expect(isModeSatisfied("all-in-one", counts, override)).toBe(false);
    }
    // 2.0 is still limited to three videos, and gains no 2.5-only controls.
    const previous = getModelTemplate("doubao-seedance-2-0-260128");
    expect(isModeSatisfied("all-in-one", { images: 1, videos: 6 }, previous?.referenceRequirements?.["all-in-one"])).toBe(false);
    expect(previous?.supportsOutputFormat).toBeFalsy();
  });

  it("keeps 1080p available for official Seedance 2.5 aliases without changing the default", () => {
    for (const model of ["doubao-seedance-2-5-260628", "doubao-seedance-2.5"]) {
      const template = getModelTemplate(model, { vendor: "Volcengine", service_type: "video" });
      expect(template?.resolutionOptions).toEqual(["480p", "720p", "1080p"]);
      expect(template?.defaults?.resolution).toBe("720p");
    }
  });

  it("exposes 4k only for the official Seedance 2.0 standard model", () => {
    const standard = getModelTemplate("doubao-seedance-2-0-260128");
    expect(standard?.resolutionOptions).toEqual(["480p", "720p", "1080p", "4k"]);
    expect(standard?.defaults?.resolution).toBe("720p");

    expect(getModelTemplate("doubao-seedance-2-0-fast-260128")?.resolutionOptions)
      .toEqual(["480p", "720p"]);
    expect(getModelTemplate("doubao-seedance-2-5-260628")?.resolutionOptions)
      .toEqual(["480p", "720p", "1080p"]);
    expect(getModelTemplate("doubao-seedance-1-5-pro-251215")?.resolutionOptions)
      .not.toContain("4k");
  });

  it("matches HopBase Seedance 2.5 capabilities", () => {
    const template = getModelTemplate("dreamina-seedance-2-5-260628", {
      vendor: "HopBase",
      service_type: "video",
      parameter_schema: undefined,
    });
    expect(template?.vendor).toBe("HopBase");
    expect(template?.serviceType).toBe("video");
    expect(template?.resolutionOptions).toEqual(["480p", "720p"]);
    expect(template?.aspectRatioOptions).toContain("adaptive");
    expect(template?.durationRange).toEqual({ min: 4, max: 30, step: 1, defaultValue: 5 });
    expect(template?.referenceImageRange).toEqual({ min: 1, max: 30 });
    expect(template?.referenceRequirements?.["all-in-one"]).toEqual({
      images: { min: 0, max: 30 }, videos: { min: 0, max: 10 }, audios: { min: 0, max: 10 },
    });
    expect(template?.referenceModes).toContain("video-edit");
  });

  it("matches official Grok Imagine Video 1.5 capabilities", () => {
    const template = getModelTemplate("grok-imagine-video-1.5", {
      vendor: "HopBase",
      service_type: "video",
      parameter_schema: undefined,
    });
    expect(template).toMatchObject({
      vendor: "xAI",
      serviceType: "video",
      resolutionOptions: ["480p", "720p", "1080p"],
      aspectRatioOptions: ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3"],
      durationRange: { min: 1, max: 15, step: 1, defaultValue: 10 },
      audioSettingOptions: ["on", "off"],
      referenceModes: ["text-to-video", "first-frame", "multi-image"],
      referenceImageRange: { min: 2, max: 7 },
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

  it("hides aspect ratio controls for HappyHorse first-frame (i2v) models", () => {
    // Per the DashScope docs, i2v output aspect auto-follows the first frame and
    // the model REJECTS a ratio param — so the template must not expose one.
    for (const model of ["happyhorse-1.1-i2v", "happyhorse-1.0-i2v"]) {
      const template = getModelTemplate(model);
      expect(template?.supportsAspectRatio).toBeFalsy();
      expect(template?.aspectRatioOptions).toBeUndefined();
      expect(template?.defaults?.aspectRatio).toBeUndefined();
      // resolution + duration are still supported.
      expect(template?.supportsResolution).toBe(true);
      expect(template?.supportsDuration).toBe(true);
    }
  });

  it("exposes aspect ratio controls for HappyHorse reference (r2v) models", () => {
    // r2v DOES accept ratio (unlike i2v) — the tab must keep the ratio picker.
    for (const model of ["happyhorse-1.1-r2v", "happyhorse-1.0-r2v"]) {
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

  it("keeps quality controls and exposes relay resolution tiers for gpt-image-2", () => {
    const template = getModelTemplate("gpt-image-2");
    expect(template?.supportsQuality).toBe(true);
    expect(template?.qualityOptions).toEqual(["Auto", "High", "Medium", "Low"]);
    expect(template?.supportsResolution).toBe(true);
    expect(template?.resolutionOptions).toEqual(["1k", "2k", "4k"]);
  });

  it("exposes explicit resolution tiers for volcengine seedream image models", () => {
    const template = getModelTemplate("doubao-seedream-5-0-260128");
    expect(template?.supportsResolution).toBe(true);
    expect(template?.resolutionOptions).toEqual(["1k", "2k", "4k"]);
    expect(template?.supportsQuality).not.toBe(true);
    expect(template?.supportsAspectRatio).toBe(true);
  });

  it("uses Pro-specific tiers, formats and references for the official Seedream channel", () => {
    const template = getModelTemplate("doubao-seedream-5-0-pro-260628", { vendor: "Volcengine", service_type: "image" });
    expect(template?.resolutionOptions).toEqual(["1k", "1.5k", "2k"]);
    expect(template?.supportsAspectRatio).toBe(true);
    expect(template?.outputFormatOptions).toEqual(["jpeg", "png"]);
    expect(template?.referenceImageRange).toEqual({ min: 0, max: 10 });
    expect(template?.supportsQuality).not.toBe(true);
  });
});

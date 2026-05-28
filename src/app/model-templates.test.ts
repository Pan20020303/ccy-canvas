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
});

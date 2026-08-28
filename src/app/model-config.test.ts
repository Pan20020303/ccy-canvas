import { describe, expect, it, vi } from "vitest";

import type { ModelConfig } from "./model-config";
import {
  getDefaultSubmitEndpoint,
  getEnabledConfigsForServiceType,
  normalizeModelList,
  normalizeModelBaseUrl,
  probeModelConfigConnection,
  resolveModelConfigForSelection,
  resolvePreferredModelConfig,
} from "./model-config";

function makeConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    id: "cfg",
    serviceType: "text",
    vendor: "OpenAI",
    protocol: "openai",
    name: "OpenAI Text",
    baseUrl: "https://api.openai.com",
    apiKey: "",
    submitEndpoint: "",
    queryEndpoint: "",
    modelList: ["gpt-4.1-mini"],
    defaultModel: "gpt-4.1-mini",
    priority: 1,
    enabled: true,
    isDefault: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("normalizeModelList", () => {
  it("splits comma and newline separated model names and removes blanks", () => {
    expect(normalizeModelList("gpt-4.1-mini, gpt-4.1\n\n sora-2 ")).toEqual([
      "gpt-4.1-mini",
      "gpt-4.1",
      "sora-2",
    ]);
  });
});

describe("resolvePreferredModelConfig", () => {
  it("prefers enabled default config before lower-priority alternatives", () => {
    const configs = [
      makeConfig({ id: "fallback", priority: 1 }),
      makeConfig({ id: "default", priority: 5, isDefault: true }),
      makeConfig({ id: "disabled", isDefault: true, enabled: false }),
    ];

    expect(resolvePreferredModelConfig(configs, "text")?.id).toBe("default");
  });

  it("falls back to lowest priority enabled config when no default exists", () => {
    const configs = [
      makeConfig({ id: "p4", priority: 4 }),
      makeConfig({ id: "p1", priority: 1 }),
      makeConfig({ id: "video", serviceType: "video" }),
    ];

    expect(resolvePreferredModelConfig(configs, "text")?.id).toBe("p1");
  });
});

describe("resolveModelConfigForSelection", () => {
  it("prefers the config that contains the selected model name", () => {
    const configs = [
      makeConfig({ id: "openai", modelList: ["gpt-4.1-mini"], defaultModel: "gpt-4.1-mini" }),
      makeConfig({
        id: "deepseek",
        vendor: "DeepSeek",
        name: "DeepSeek Text",
        baseUrl: "https://api.deepseek.com/v1",
        modelList: ["deepseek-chat"],
        defaultModel: "deepseek-chat",
      }),
    ];

    expect(resolveModelConfigForSelection(configs, "text", "deepseek-chat")?.id).toBe("deepseek");
  });
});

describe("getEnabledConfigsForServiceType", () => {
  it("returns enabled configs for a specific service type", () => {
    const configs = [
      makeConfig({ id: "image-on", serviceType: "image", enabled: true }),
      makeConfig({ id: "image-off", serviceType: "image", enabled: false }),
      makeConfig({ id: "video-on", serviceType: "video", enabled: true }),
    ];

    expect(getEnabledConfigsForServiceType(configs, "image").map((config) => config.id)).toEqual(["image-on"]);
  });
});

describe("probeModelConfigConnection", () => {
  it("uses a real POST request against the configured endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { message: "bad request" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await probeModelConfigConnection(
      makeConfig({
        serviceType: "image",
        apiKey: "test-key",
        submitEndpoint: "/images/generations",
        modelList: ["gpt-image-2"],
        defaultModel: "gpt-image-2",
      }),
    );

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/images/generations");
    expect(init.method).toBe("POST");
    expect(String(init.body)).toContain("gpt-image-2");
  });
});

describe("normalizeModelBaseUrl", () => {
  it("adds /v1 for plain vendor roots and trims trailing slashes", () => {
    expect(normalizeModelBaseUrl("https://api.openai.com/")).toBe("https://api.openai.com/v1");
  });
});

describe("getDefaultSubmitEndpoint", () => {
  it("returns service-specific defaults when no custom endpoint is provided", () => {
    expect(getDefaultSubmitEndpoint(makeConfig({ serviceType: "text" }))).toBe("/chat/completions");
    expect(getDefaultSubmitEndpoint(makeConfig({ serviceType: "image" }))).toBe("/images/generations");
    expect(getDefaultSubmitEndpoint(makeConfig({ serviceType: "video" }))).toBe("/generations");
  });

  it("preserves a custom submit endpoint", () => {
    expect(getDefaultSubmitEndpoint(makeConfig({ submitEndpoint: "/custom/run" }))).toBe("/custom/run");
  });
});

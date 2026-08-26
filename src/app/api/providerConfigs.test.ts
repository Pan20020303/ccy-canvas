import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getProviderModelDisplayName,
  getProviderModelPresentation,
  getEndpointPreview,
  previewProviderConfigTSImport,
  supportsCustomSubmitQueryEndpoints,
  testChannelConnectivity,
  VENDOR_TEMPLATES,
} from "./providerConfigs";

describe("provider model display names", () => {
  it("uses the configured display name without replacing the real model id", () => {
    const presentation = getProviderModelPresentation([
      {
        parameter_schema: {
          vendor_models: [
            { name: "qwen3.7-max", modelName: "qwen3.7-max-2026-06-08", type: "text" },
            { name: "内部模型", model_name: "hidden-model", hidden: true },
          ],
        },
      },
    ]);

    expect(getProviderModelDisplayName("qwen3.7-max-2026-06-08", presentation)).toBe("qwen3.7-max");
    expect(getProviderModelDisplayName("unknown-model", presentation)).toBe("unknown-model");
    expect(presentation.hiddenModels.has("hidden-model")).toBe(true);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("supportsCustomSubmitQueryEndpoints", () => {
  it("only allows custom profiles to configure submit/query endpoints", () => {
    expect(supportsCustomSubmitQueryEndpoints("custom")).toBe(true);
    expect(supportsCustomSubmitQueryEndpoints("openai")).toBe(false);
    expect(supportsCustomSubmitQueryEndpoints("ark")).toBe(false);
  });
});

describe("ManjuAPI MiniMax H3 provider template", () => {
  it("uses the dedicated videos endpoint and fixed H3 capabilities", () => {
    const template = VENDOR_TEMPLATES.video.find((item) => item.models.includes("MiniMax H3"));
    expect(template).toMatchObject({
      vendor: "ManjuAPI",
      baseURL: "https://manjuapi.com",
      apiSpec: "custom",
      submitEndpoint: "/v1/videos",
      queryEndpoint: "/v1/videos/{taskId}",
    });
    expect(template?.parameterSchema?.resolution_options).toEqual(["2k"]);
    expect(template?.parameterSchema?.duration_options).toEqual([10, 15]);
    expect(template?.parameterSchema?.defaults).toMatchObject({
      duration: 10,
      aspect_ratio: "16:9",
      resolution: "2k",
      input_reference_min: 2,
      input_reference_max: 5,
    });
  });
});

describe("ManjuAPI Grok Imagine provider templates", () => {
  it("separates the legacy text endpoint from the 1.5 videos endpoint", () => {
    const text = VENDOR_TEMPLATES.video.find((item) => item.models.includes("grok-imagine-video"));
    expect(text).toMatchObject({
      vendor: "ManjuAPI",
      submitEndpoint: "/v1/chat/completions",
      queryEndpoint: "/v1/videos/{taskId}",
    });
    expect(text?.parameterSchema?.duration_options).toEqual([6, 10]);

    const grok15 = VENDOR_TEMPLATES.video.find((item) => item.models.includes("grok-imagine-video-1.5-fast"));
    expect(grok15).toMatchObject({
      vendor: "ManjuAPI",
      submitEndpoint: "/v1/videos",
      queryEndpoint: "/v1/videos/{taskId}",
    });
    expect(grok15?.models).toContain("grok-imagine-video-1.5-preview");
    expect(grok15?.parameterSchema?.models?.["grok-imagine-video-1.5-fast"]?.duration_options).toEqual([6, 10, 15]);
    expect(grok15?.parameterSchema?.models?.["grok-imagine-video-1.5-fast"]?.defaults).toMatchObject({
      input_reference_min: 1,
      input_reference_max: 7,
    });
    expect(grok15?.parameterSchema?.models?.["grok-imagine-video-1.5-preview"]?.duration_options).toEqual([10, 15]);
  });
});

describe("HopBase Seedance provider template", () => {
  it("uses the documented task endpoints and exposes 2.5 plus 2.0 variants", () => {
    const template = VENDOR_TEMPLATES.video.find((item) => item.vendor === "HopBase");
    expect(template).toMatchObject({
      baseURL: "https://api.hop-base.com",
      apiSpec: "custom",
      protocol: "native",
      submitEndpoint: "/v1/video/generate",
      queryEndpoint: "/v1/video/tasks/{taskId}",
    });
    expect(template?.models).toContain("dreamina-seedance-2-5-260628");
    expect(template?.models).toContain("doubao-seedance-2-0-260128-a");
    expect(template?.parameterSchema?.models?.["dreamina-seedance-2-5-260628"]?.resolution_options).toEqual(["480p", "720p"]);
    expect(template?.parameterSchema?.models?.["dreamina-seedance-2-0-260128"]?.resolution_options).toContain("4k");
  });
});

describe("getEndpointPreview", () => {
  it("shows separate OpenAI-compatible image generation and edit endpoints", () => {
    expect(getEndpointPreview("image", "openai")).toBe(
      "生成 /images/generations · 编辑 /images/edits",
    );
  });

  it("shows RelayBases image endpoints with the documented v1 prefix", () => {
    expect(
      getEndpointPreview(
        "image",
        "openai",
        "",
        "",
        "https://image-2.relaybases.com",
      ),
    ).toBe("生成 /v1/images/generations · 编辑 /v1/images/edits");
  });

  it("shows Ark image references using the generations endpoint", () => {
    expect(getEndpointPreview("image", "ark")).toBe(
      "生成 /images/generations · 编辑 /images/generations",
    );
  });

  it("derives a custom image edit sibling from a generations submit endpoint", () => {
    expect(
      getEndpointPreview("image", "custom", "/v1/images/generations"),
    ).toBe("生成 /v1/images/generations · 编辑 /v1/images/edits");
  });

  it("shows Ark video task endpoints", () => {
    expect(getEndpointPreview("video", "ark")).toBe(
      "提交 /contents/generations/tasks · 查询 /contents/generations/tasks/{taskId}",
    );
  });
});

describe("previewProviderConfigTSImport", () => {
  it("posts TS code to the admin preview endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            service_type: "image",
            vendor: "Demo",
            name: "Demo TS",
            api_spec: "custom",
            protocol: "openai_compatible",
            base_url: "https://example.com/v1",
            model_list: ["demo-image"],
            icon: { key: "openai" },
          },
          request_id: "req_test",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const preview = await previewProviderConfigTSImport("export const vendor = {}");

    expect(preview.icon?.key).toBe("openai");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/provider-configs/import-ts/preview",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ code: "export const vendor = {}" }),
      }),
    );
  });
});

describe("testChannelConnectivity", () => {
  it("accepts the Huma raw success body returned by the backend test endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          $schema: "http://127.0.0.1:8800/schemas/TestChannelOutputBody.json",
          ok: true,
          http_status: 200,
          latency_ms: 54,
          request_id: "req_test",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(testChannelConnectivity("provider-1")).resolves.toEqual({
      ok: true,
      http_status: 200,
      latency_ms: 54,
      error_msg: undefined,
    });
  });
});

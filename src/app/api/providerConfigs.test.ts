import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getEndpointPreview,
  previewProviderConfigTSImport,
  supportsCustomSubmitQueryEndpoints,
  testChannelConnectivity,
} from "./providerConfigs";

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

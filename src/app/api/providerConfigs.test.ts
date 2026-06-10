import { describe, expect, it } from "vitest";

import {
  getEndpointPreview,
  supportsCustomSubmitQueryEndpoints,
} from "./providerConfigs";

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

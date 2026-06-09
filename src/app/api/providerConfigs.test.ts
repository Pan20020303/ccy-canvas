import { describe, expect, it } from "vitest";

import { supportsCustomSubmitQueryEndpoints } from "./providerConfigs";

describe("supportsCustomSubmitQueryEndpoints", () => {
  it("allows image and video services to configure submit/query endpoints", () => {
    expect(supportsCustomSubmitQueryEndpoints("image")).toBe(true);
    expect(supportsCustomSubmitQueryEndpoints("video")).toBe(true);
  });

  it("does not require submit/query endpoints for text or audio services", () => {
    expect(supportsCustomSubmitQueryEndpoints("text")).toBe(false);
    expect(supportsCustomSubmitQueryEndpoints("audio")).toBe(false);
  });
});

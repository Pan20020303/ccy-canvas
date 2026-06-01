import { describe, expect, it } from "vitest";

import {
  clearReferencePayloadValue,
  getReferencePayloadValue,
  getReferenceNodeTypeFromMimeType,
  resolveBackendAssetUrl,
  setReferencePayloadValue,
} from "./reference-media";

describe("reference media helpers", () => {
  it("maps image mime types to reference image nodes", () => {
    expect(getReferenceNodeTypeFromMimeType("image/png")).toBe("referenceImageNode");
  });

  it("maps video mime types to reference video nodes", () => {
    expect(getReferenceNodeTypeFromMimeType("video/mp4")).toBe("referenceVideoNode");
  });

  it("returns null for unsupported mime types", () => {
    expect(getReferenceNodeTypeFromMimeType("application/pdf")).toBeNull();
  });

  it("returns null when mime type is missing", () => {
    expect(getReferenceNodeTypeFromMimeType("")).toBeNull();
    expect(getReferenceNodeTypeFromMimeType(undefined as never)).toBeNull();
  });

  it("resolves backend-relative asset urls against the api base url", () => {
    expect(resolveBackendAssetUrl("/uploads/2026-06/example.png", "http://127.0.0.1:8080")).toBe(
      "http://127.0.0.1:8080/uploads/2026-06/example.png",
    );
  });

  it("returns an empty string when asset url is missing", () => {
    expect(resolveBackendAssetUrl(undefined as never, "http://127.0.0.1:8080")).toBe("");
  });

  it("prefers transient reference payload values over preview urls", () => {
    setReferencePayloadValue("ref-image-1", "data:image/png;base64,abc");

    expect(getReferencePayloadValue("ref-image-1", { url: "https://example.com/preview.png" })).toBe(
      "data:image/png;base64,abc",
    );

    clearReferencePayloadValue("ref-image-1");
  });
});

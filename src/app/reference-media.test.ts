import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearReferencePayloadValue,
  getReferencePayloadValue,
  getReferenceNodeTypeFromMimeType,
  isTransientBrowserMediaUrl,
  isPublicHttpAssetUrl,
  resolveBackendAssetUrl,
  setReferencePayloadValue,
  toRenderableMediaUrl,
} from "./reference-media";

describe("reference media helpers", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("maps image mime types to reference image nodes", () => {
    expect(getReferenceNodeTypeFromMimeType("image/png")).toBe("referenceImageNode");
  });

  it("maps video mime types to reference video nodes", () => {
    expect(getReferenceNodeTypeFromMimeType("video/mp4")).toBe("referenceVideoNode");
  });

  it("maps audio mime types to reference audio nodes", () => {
    expect(getReferenceNodeTypeFromMimeType("audio/mpeg")).toBe("referenceAudioNode");
    expect(getReferenceNodeTypeFromMimeType("audio/wav")).toBe("referenceAudioNode");
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

  it("preserves the deployed sub-path for generated uploads", () => {
    expect(resolveBackendAssetUrl("/uploads/generated/example.jpeg", "https://cylaigc.com/ccy")).toBe(
      "https://cylaigc.com/ccy/uploads/generated/example.jpeg",
    );
    vi.stubEnv("VITE_API_BASE_URL", "https://cylaigc.com/ccy");
    expect(toRenderableMediaUrl("/uploads/generated/example.jpeg")).toBe(
      "https://cylaigc.com/ccy/uploads/generated/example.jpeg",
    );
    expect(toRenderableMediaUrl("/uploads/generated/example.jpeg", { thumbWidth: 720 })).toBe(
      "https://cylaigc.com/ccy/api/app/media-thumbnail?path=%2Fuploads%2Fgenerated%2Fexample.jpeg&w=720",
    );
  });

  it("returns an empty string when asset url is missing", () => {
    expect(resolveBackendAssetUrl(undefined as never, "http://127.0.0.1:8080")).toBe("");
  });

  it("detects transient browser-only media urls", () => {
    expect(isTransientBrowserMediaUrl("blob:http://localhost:5173/abc")).toBe(true);
    expect(isTransientBrowserMediaUrl("data:image/png;base64,abc")).toBe(true);
    expect(isTransientBrowserMediaUrl("/uploads/2026-06/example.png")).toBe(false);
  });

  it("detects provider-accessible public http urls", () => {
    expect(isPublicHttpAssetUrl("https://ccy-canvas-1334659054.cos.ap-beijing.myqcloud.com/a.png")).toBe(true);
    expect(isPublicHttpAssetUrl("/uploads/2026-06/example.png")).toBe(false);
    expect(isPublicHttpAssetUrl("http://localhost:8080/uploads/example.png")).toBe(false);
    expect(isPublicHttpAssetUrl("http://192.168.1.8/uploads/example.png")).toBe(false);
    expect(isPublicHttpAssetUrl("data:image/png;base64,abc")).toBe(false);
  });

  it("prefers transient reference payload values over preview urls", () => {
    setReferencePayloadValue("ref-image-1", "data:image/png;base64,abc");

    expect(getReferencePayloadValue("ref-image-1", { url: "https://example.com/preview.png" })).toBe(
      "data:image/png;base64,abc",
    );

    clearReferencePayloadValue("ref-image-1");
  });
});

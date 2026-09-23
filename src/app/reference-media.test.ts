import { describe, expect, it, vi } from "vitest";

import {
  clearReferencePayloadValue,
  getReferencePayloadValue,
  getReferenceNodeTypeFromMimeType,
  isTransientBrowserMediaUrl,
  isPublicHttpAssetUrl,
  resolveBackendAssetUrl,
  setReferencePayloadValue,
  toRenderableMediaUrl,
  localMediaThumbnailWidth,
  isLocalMediaThumbnailUrl,
} from "./reference-media";

describe("reference media helpers", () => {
  it("requests fixed-tier local thumbnails but leaves original download URLs unchanged", () => {
    expect(toRenderableMediaUrl('/uploads/photo.png', { thumbWidth: 720 })).toBe('/uploads/photo.png?w=768');
    expect(toRenderableMediaUrl('/uploads/photo.png', { thumbWidth: 640 })).toBe('/uploads/photo.png?w=768');
    expect(toRenderableMediaUrl('/uploads/photo.png')).toBe('/uploads/photo.png');
    expect(toRenderableMediaUrl('/other/photo.png', { thumbWidth: 720 })).toBe('/other/photo.png');
    expect(localMediaThumbnailWidth(99999)).toBe(1280);
    expect(localMediaThumbnailWidth(NaN)).toBeNull();
  });

  it("identifies derivative requests and invalidates old version hints when changing tier", () => {
    expect(isLocalMediaThumbnailUrl('/uploads/photo.png?w=768&v=old')).toBe(true);
    expect(isLocalMediaThumbnailUrl('/uploads/photo.png')).toBe(false);
    expect(toRenderableMediaUrl('/uploads/photo.png?w=768&v=old', { thumbWidth: 256 })).toBe('/uploads/photo.png?w=256');
  });

  it("uses same-origin absolute uploads locally without redirecting foreign uploads to this server", () => {
    vi.stubGlobal('window', { location: { origin: 'http://canvas.local' } });
    try {
      expect(toRenderableMediaUrl('http://canvas.local/uploads/photo.png', { thumbWidth: 720 })).toBe('http://canvas.local/uploads/photo.png?w=768');
      expect(toRenderableMediaUrl('https://foreign.example/uploads/photo.png', { thumbWidth: 720 })).toContain('/api/app/proxy-media?url=');
    } finally { vi.unstubAllGlobals(); }
  });

  it("only appends a finite thumbnail hint and retains the original signed URL", () => {
    const source = 'https://example.com/photo.png?signature=a%2Bb';
    expect(toRenderableMediaUrl(source, { thumbWidth: 720 })).toBe(`/api/app/proxy-media?url=${encodeURIComponent(source)}&w=720`);
    expect(toRenderableMediaUrl(source, { thumbWidth: Infinity })).not.toContain('&w=');
  });
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

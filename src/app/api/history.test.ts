import { afterEach, describe, expect, it, vi } from "vitest";

import { deleteHistoryFromServer, listHistoryFromServer, saveHistoryToServer } from "./history";
import type { HistoryItem } from "../store";

afterEach(() => {
  vi.unstubAllGlobals();
});

function envelope(data: unknown) {
  return new Response(JSON.stringify({ data, request_id: "req_test" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const sampleItem: HistoryItem = {
  id: "gen-1",
  spaceId: "space-personal",
  spaceType: "personal",
  projectId: "p1",
  title: "whale",
  type: "image",
  mediaType: "image",
  timestamp: 1735660000000,
  thumbnail: "https://example.com/w.png",
  aspectRatio: "square",
  promptExcerpt: "a whale",
};

describe("listHistoryFromServer", () => {
  it("builds a scoped query string and unwraps the data array", async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope([sampleItem]));
    vi.stubGlobal("fetch", fetchMock);

    const items = await listHistoryFromServer({ spaceId: "space-personal", type: "image" });

    expect(items).toEqual([sampleItem]);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/api/app/history?");
    expect(url).toContain("spaceId=space-personal");
    expect(url).toContain("type=image");
  });

  it("omits empty query params", async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope([]));
    vi.stubGlobal("fetch", fetchMock);

    await listHistoryFromServer();

    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/app/history");
  });
});

describe("saveHistoryToServer", () => {
  it("POSTs the item as JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await saveHistoryToServer(sampleItem);

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toMatchObject({ id: "gen-1", mediaType: "image" });
  });
});

describe("deleteHistoryFromServer", () => {
  it("sends a DELETE with the id list in the body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(envelope({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await deleteHistoryFromServer(["a", "b"]);

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(String(init.body))).toEqual({ ids: ["a", "b"] });
  });

  it("no-ops on an empty id list", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await deleteHistoryFromServer([]);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

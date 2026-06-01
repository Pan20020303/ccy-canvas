import { beforeEach, describe, expect, it, vi } from "vitest";

type StoreModule = typeof import("./store");

function createStorageMock(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.has(key) ? values.get(key)! : null;
    },
    key(index) {
      return Array.from(values.keys())[index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

async function loadStore(): Promise<StoreModule> {
  vi.resetModules();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: createStorageMock(),
  });

  return import("./store");
}

describe("workspace project state", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("creates a new project with its own empty canvas snapshot", async () => {
    const { useStore } = await loadStore();

    useStore.getState().createGroup(["1", "2"]);
    useStore.getState().createProject("Storyboard B");

    const state = useStore.getState();
    expect(state.projects).toHaveLength(2);
    expect(state.activeProjectId).not.toBe("p-default");
    expect(state.nodes).toEqual([]);
    expect(state.edges).toEqual([]);
    expect(state.groups).toEqual([]);
  });

  it("restores the correct nodes, edges, and groups when switching projects", async () => {
    const { useStore } = await loadStore();

    useStore.getState().addNode({
      id: "text-1",
      type: "textNode",
      position: { x: 40, y: 60 },
      data: { content: "Project A" },
    } as never);
    useStore.getState().createGroup(["1", "text-1"]);
    useStore.getState().createProject("Storyboard B");
    useStore.getState().addNode({
      id: "image-1",
      type: "imageNode",
      position: { x: 120, y: 140 },
      data: { caption: "Project B" },
    } as never);

    useStore.getState().switchProject("p-default");

    const state = useStore.getState();
    expect(state.nodes.some((node) => node.id === "text-1")).toBe(true);
    expect(state.nodes.some((node) => node.id === "image-1")).toBe(false);
    expect(state.groups).toHaveLength(1);
  });

  it("starts in the authenticated user's personal space", async () => {
    const { useStore } = await loadStore();

    const state = useStore.getState() as Record<string, unknown>;
    expect(state.activeSpaceId).toBe("space-personal");
    expect(state.activeSpaceType).toBe("personal");
  });

  it("switches spaces and restores the correct space-scoped project list", async () => {
    const { useStore } = await loadStore();

    useStore.getState().switchSpace("space-team-alpha");
    useStore.getState().createProject("Team Board");
    useStore.getState().switchSpace("space-personal");

    const personalState = useStore.getState();
    expect(personalState.projects.some((project) => project.name === "Team Board")).toBe(false);

    useStore.getState().switchSpace("space-team-alpha");
    expect(useStore.getState().projects.some((project) => project.name === "Team Board")).toBe(true);
  });
});

describe("workspace history state", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("stores history items with masonry-friendly metadata defaults", async () => {
    const { useStore } = await loadStore();

    useStore.getState().addHistory({
      id: "h-1",
      title: "Hero portrait",
      type: "image",
      timestamp: 1,
      thumbnail: "https://example.com/image.png",
    });

    const [item] = useStore.getState().history as Array<Record<string, unknown>>;
    expect(item.mediaType).toBe("image");
    expect(item.aspectRatio).toBe("square");
    expect(item.projectId).toBe("p-default");
  });

  it("stores history inside the active space only", async () => {
    const { useStore } = await loadStore();

    useStore.getState().addHistory({
      id: "h-1",
      title: "Personal",
      type: "image",
      timestamp: 1,
      thumbnail: "x",
    });
    useStore.getState().switchSpace("space-team-alpha");

    expect(useStore.getState().history).toEqual([]);
  });
});

describe("workspace control bar state", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("starts with minimap hidden and grid snap disabled", async () => {
    const { useStore } = await loadStore();

    const state = useStore.getState() as Record<string, unknown>;
    expect(state.showMiniMap).toBe(false);
    expect(state.snapToGrid).toBe(false);
  });

  it("toggles minimap and grid snap independently", async () => {
    const { useStore } = await loadStore();

    useStore.getState().setShowMiniMap(true);
    useStore.getState().setSnapToGrid(true);

    const state = useStore.getState();
    expect(state.showMiniMap).toBe(true);
    expect(state.snapToGrid).toBe(true);
  });

  it("updates aspect ratio for only the targeted node", async () => {
    const { useStore } = await loadStore();

    useStore.getState().addNode({
      id: "video-2",
      type: "videoNode",
      position: { x: 0, y: 0 },
      data: {},
    } as never);

    useStore.getState().updateNodeGenerationParams("1", { aspectRatio: "5:4" });

    const first = useStore.getState().nodes.find((node) => node.id === "1");
    const second = useStore.getState().nodes.find((node) => node.id === "video-2");
    expect((first?.data as Record<string, unknown>)?.generationParams).toMatchObject({ aspectRatio: "5:4" });
    expect((second?.data as Record<string, unknown>)?.generationParams).toBeUndefined();
  });

  it("stores video duration on a single node", async () => {
    const { useStore } = await loadStore();

    useStore.getState().updateNodeGenerationParams("1", { durationSeconds: 10 });
    const first = useStore.getState().nodes.find((node) => node.id === "1");
    expect((first?.data as Record<string, unknown>)?.generationParams).toMatchObject({ durationSeconds: 10 });
  });

  it("sends generation requests through the backend app api instead of calling vendors directly", async () => {
    const { useStore } = await loadStore();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify({
        error: {
          code: "backend_generation_error",
          message: "backend generation unavailable",
        },
        request_id: "req-backend-error",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await useStore.getState().runNode("2", { prompt: "test", model: "gpt-image-2" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/app/generate");
    const imageNode = useStore.getState().nodes.find((node) => node.id === "2");
    expect((imageNode?.data as Record<string, unknown>)?.status).toBe("error");
    expect((imageNode?.data as Record<string, unknown>)?.error).toContain("backend generation unavailable");
  });

  it("includes upstream reference images in image generation payloads", async () => {
    const { useStore } = await loadStore();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify({
        data: { type: "url", content: "https://example.com/generated.png" },
        request_id: "req-image-ref",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    useStore.getState().addNode({
      id: "ref-image-1",
      type: "referenceImageNode",
      position: { x: 0, y: 0 },
      data: { url: "https://example.com/reference.png" },
    } as never);
    useStore.getState().onConnect({
      source: "ref-image-1",
      target: "2",
      sourceHandle: null,
      targetHandle: null,
    });

    await useStore.getState().runNode("2", { prompt: "use the reference", model: "gpt-image-2" });

    const [, init] = fetchMock.mock.calls[0];
    expect(String(init.body)).toContain("\"reference_images\":[\"https://example.com/reference.png\"]");
  });

  it("includes upstream reference images and videos in video generation payloads", async () => {
    const { useStore } = await loadStore();
    const { setReferencePayloadValue } = await import("./reference-media");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify({
        data: { type: "url", content: "https://example.com/generated.mp4" },
        request_id: "req-video-ref",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    useStore.getState().addNode({
      id: "video-gen-1",
      type: "videoNode",
      position: { x: 0, y: 0 },
      data: {},
    } as never);
    useStore.getState().addNode({
      id: "ref-image-2",
      type: "referenceImageNode",
      position: { x: 0, y: 0 },
      data: { url: "https://example.com/reference-2.png" },
    } as never);
    useStore.getState().addNode({
      id: "ref-video-1",
      type: "referenceVideoNode",
      position: { x: 0, y: 0 },
      data: { url: "https://example.com/reference.mp4" },
    } as never);
    useStore.getState().onConnect({
      source: "ref-image-2",
      target: "video-gen-1",
      sourceHandle: null,
      targetHandle: null,
    });
    useStore.getState().onConnect({
      source: "ref-video-1",
      target: "video-gen-1",
      sourceHandle: null,
      targetHandle: null,
    });
    setReferencePayloadValue("ref-image-2", "data:image/png;base64,from-drop");
    setReferencePayloadValue("ref-video-1", "data:video/mp4;base64,from-drop");

    await useStore.getState().runNode("video-gen-1", { prompt: "animate this", model: "sora-v3-fast" });

    const [, init] = fetchMock.mock.calls[0];
    expect(String(init.body)).toContain("\"reference_images\":[\"data:image/png;base64,from-drop\"]");
    expect(String(init.body)).toContain("\"reference_video\":\"data:video/mp4;base64,from-drop\"");
    expect(String(init.body)).not.toContain("https://example.com/reference-2.png");
    expect(String(init.body)).not.toContain("https://example.com/reference.mp4");
  });
});

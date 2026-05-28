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

  it("uses node generation params when dispatching a run", async () => {
    const { useStore } = await loadStore();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [{ url: "https://example.com/out.png" }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const imageConfig = useStore.getState().modelConfigs.find((config) => config.serviceType === "image");
    if (!imageConfig) {
      throw new Error("Expected seeded image config");
    }
    useStore.getState().upsertModelConfig({ ...imageConfig, apiKey: "test-key" });

    useStore.getState().updateNodeGenerationParams("2", {
      aspectRatio: "5:4",
      resolution: "2K",
      model: "gpt-image-2",
    });

    await useStore.getState().runNode("2", { prompt: "test", model: "gpt-image-2" });

    const [, init] = fetchMock.mock.calls[0];
    expect(String(init.body)).toContain("5:4");
    expect(String(init.body)).toContain("2K");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

type StoreModule = typeof import("./store");

function createStorageMock(values: Map<string, string> = new Map()): Storage {
  const store = values;

  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key) {
      store.delete(key);
    },
    setItem(key, value) {
      store.set(key, value);
    },
  };
}

async function loadStore(storage = createStorageMock()): Promise<StoreModule> {
  vi.resetModules();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: storage,
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

  it("creates groups with persisted geometry around selected nodes", async () => {
    const { useStore } = await loadStore();

    useStore.getState().addNode({
      id: "a",
      type: "imageNode",
      position: { x: 100, y: 100 },
      width: 200,
      height: 160,
      data: {},
    } as never);
    useStore.getState().addNode({
      id: "b",
      type: "textNode",
      position: { x: 360, y: 200 },
      width: 180,
      height: 140,
      data: {},
    } as never);

    useStore.getState().createGroup(["a", "b"]);

    const group = useStore.getState().groups.at(-1);
    expect(group).toMatchObject({
      nodeIds: ["a", "b"],
      position: { x: 68, y: 32 },
      width: 504,
      height: 340,
    });
  });

  it("moves a whole group together with all member nodes", async () => {
    const { useStore } = await loadStore();

    useStore.getState().addNode({
      id: "group-image",
      type: "imageNode",
      position: { x: 100, y: 100 },
      width: 200,
      height: 160,
      data: {},
    } as never);
    useStore.getState().addNode({
      id: "group-text",
      type: "textNode",
      position: { x: 360, y: 200 },
      width: 180,
      height: 140,
      data: {},
    } as never);
    useStore.getState().createGroup(["group-image", "group-text"]);

    const groupId = useStore.getState().groups.at(-1)?.id;
    expect(groupId).toBeTruthy();

    useStore.getState().moveGroup(groupId!, { x: 48, y: 24 }, { captureUndo: true });

    const state = useStore.getState();
    expect(state.groups.at(-1)?.position).toMatchObject({ x: 116, y: 56 });
    expect(state.nodes.find((node) => node.id === "group-image")?.position).toEqual({ x: 148, y: 124 });
    expect(state.nodes.find((node) => node.id === "group-text")?.position).toEqual({ x: 408, y: 224 });
  });

  it("undoes the last canvas mutation with ctrl-z semantics", async () => {
    const { useStore } = await loadStore();

    useStore.getState().addNode({
      id: "undo-a",
      type: "textNode",
      position: { x: 10, y: 20 },
      data: {},
    } as never);

    expect(useStore.getState().nodes.some((node) => node.id === "undo-a")).toBe(true);

    useStore.getState().undoCanvas();

    expect(useStore.getState().nodes.some((node) => node.id === "undo-a")).toBe(false);
  });

  it("copies selected nodes and pastes them with a new offset", async () => {
    const { useStore } = await loadStore();
    const initialNodeCount = useStore.getState().nodes.length;
    const initialEdgeCount = useStore.getState().edges.length;

    useStore.getState().addNode({
      id: "copy-a",
      type: "textNode",
      selected: true,
      position: { x: 100, y: 120 },
      data: {},
    } as never);
    useStore.getState().addNode({
      id: "copy-b",
      type: "imageNode",
      selected: true,
      position: { x: 180, y: 240 },
      data: {},
    } as never);
    useStore.getState().onConnect({ source: "copy-a", sourceHandle: null, target: "copy-b", targetHandle: null });

    useStore.getState().copySelectedNodes();
    useStore.getState().pasteCopiedNodes();

    const state = useStore.getState();
    expect(state.nodes).toHaveLength(initialNodeCount + 4);
    expect(state.edges).toHaveLength(initialEdgeCount + 2);
    const pastedNodes = state.nodes.filter((node) => node.id !== "copy-a" && node.id !== "copy-b");
    expect(pastedNodes.map((node) => node.position)).toEqual(
      expect.arrayContaining([
        { x: 148, y: 168 },
        { x: 228, y: 288 },
      ]),
    );
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

  it("toggles the history assets modal open state", async () => {
    const { useStore } = await loadStore();

    expect((useStore.getState() as Record<string, unknown>).isHistoryAssetsOpen).toBe(false);

    useStore.getState().setHistoryAssetsOpen(true);
    expect((useStore.getState() as Record<string, unknown>).isHistoryAssetsOpen).toBe(true);

    useStore.getState().setHistoryAssetsOpen(false);
    expect((useStore.getState() as Record<string, unknown>).isHistoryAssetsOpen).toBe(false);
  });

  it("removes selected history items only from the active space", async () => {
    const { useStore } = await loadStore();

    useStore.getState().addHistory({
      id: "personal-1",
      title: "Personal 1",
      type: "image",
      timestamp: 1,
      thumbnail: "x",
    });
    useStore.getState().addHistory({
      id: "personal-2",
      title: "Personal 2",
      type: "video",
      timestamp: 2,
      thumbnail: "y",
    });
    useStore.getState().switchSpace("space-team-alpha");
    useStore.getState().addHistory({
      id: "team-1",
      title: "Team 1",
      type: "image",
      timestamp: 3,
      thumbnail: "z",
    });

    useStore.getState().switchSpace("space-personal");
    useStore.getState().removeHistoryItems(["personal-1"]);

    expect(useStore.getState().history.map((item) => item.id)).toEqual(["personal-2"]);

    useStore.getState().switchSpace("space-team-alpha");
    expect(useStore.getState().history.map((item) => item.id)).toEqual(["team-1"]);
  });

  it("reuses selected image and video history items as reference nodes", async () => {
    const { useStore } = await loadStore();

    useStore.getState().addHistory({
      id: "hist-image",
      title: "Image ref",
      type: "image",
      timestamp: 1,
      thumbnail: "https://example.com/reuse-image.png",
    });
    useStore.getState().addHistory({
      id: "hist-video",
      title: "Video ref",
      type: "video",
      timestamp: 2,
      thumbnail: "https://example.com/reuse-video.mp4",
    });
    useStore.getState().addHistory({
      id: "hist-audio",
      title: "Audio ref",
      type: "audio",
      timestamp: 3,
      thumbnail: "https://example.com/reuse-audio.mp3",
    });

    const beforeCount = useStore.getState().nodes.length;
    useStore.getState().reuseHistoryItems(["hist-image", "hist-video", "hist-audio"]);
    const appendedNodes = useStore.getState().nodes.slice(beforeCount);

    expect(appendedNodes).toHaveLength(2);
    expect(appendedNodes.map((node) => node.type).sort()).toEqual(["referenceImageNode", "referenceVideoNode"]);
    expect(appendedNodes.map((node) => (node.data as Record<string, unknown>)?.url).sort()).toEqual([
      "https://example.com/reuse-image.png",
      "https://example.com/reuse-video.mp4",
    ]);
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

  it("clears stale node errors when generation succeeds", async () => {
    const { useStore } = await loadStore();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify({
        data: { type: "url", content: "https://example.com/generated.png" },
        request_id: "req-clear-error",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    useStore.getState().updateNodeData("2", { status: "error", error: "previous failure" });

    await useStore.getState().runNode("2", { prompt: "recover", model: "gpt-image-2" });

    const imageNode = useStore.getState().nodes.find((node) => node.id === "2");
    expect((imageNode?.data as Record<string, unknown>)?.status).toBe("done");
    expect((imageNode?.data as Record<string, unknown>)?.error).toBeUndefined();
  });

  it("upgrades uploaded reference images to public urls for chat-image providers", async () => {
    vi.stubEnv("VITE_API_BASE_URL", "https://canvas.example.com");
    try {
      const { useStore } = await loadStore();
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => JSON.stringify({
          data: { type: "url", content: "https://example.com/generated.png" },
          request_id: "req-chat-image-ref",
        }),
      });
      vi.stubGlobal("fetch", fetchMock);

      useStore.getState().setBackendModels([
        {
          id: "pc-manju",
          service_type: "image",
          vendor: "ManjuAPI",
          name: "ManjuAPI / Chat 图片生成",
          protocol: "openai_compatible",
          model_list: ["GPT Image 2"],
          default_model: "GPT Image 2",
          priority: 0,
          parameter_schema: {
            reference_request_format: "chat_completions_image",
          },
        },
      ]);
      useStore.getState().addNode({
        id: "ref-image-upload",
        type: "referenceImageNode",
        position: { x: 0, y: 0 },
        data: { url: "http://localhost:8080/uploads/2026-06/reference.png" },
      } as never);
      useStore.getState().onConnect({
        source: "ref-image-upload",
        target: "2",
        sourceHandle: null,
        targetHandle: null,
      });

      await useStore.getState().runNode("2", { prompt: "use upload", model: "GPT Image 2" });

      const [, init] = fetchMock.mock.calls[0];
      expect(String(init.body)).toContain("\"reference_images\":[\"https://canvas.example.com/uploads/2026-06/reference.png\"]");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("drops non-public reference images for chat-image providers", async () => {
    const { useStore } = await loadStore();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify({
        data: { type: "queued", task_id: "task-no-private-ref", status: "pending" },
        request_id: "req-no-private-ref",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    useStore.getState().setBackendModels([
      {
        id: "manju-private-ref",
        service_type: "image",
        vendor: "ManjuAPI",
        name: "ManjuAPI / Chat 图片生成",
        protocol: "openai_compatible",
        model_list: ["gemini-2.5-flash-image"],
        default_model: "gemini-2.5-flash-image",
        priority: 0,
        parameter_schema: {
          reference_request_format: "chat_completions_image",
        },
      },
    ]);
    useStore.getState().addNode({
      id: "ref-image-private-upload",
      type: "referenceImageNode",
      position: { x: 0, y: 0 },
      data: { url: "/uploads/2026-06/private-reference.png" },
    } as never);
    useStore.getState().onConnect({
      source: "ref-image-private-upload",
      target: "2",
      sourceHandle: null,
      targetHandle: null,
    });

    await useStore.getState().runNode("2", { prompt: "generate store", model: "gemini-2.5-flash-image" });

    const [, init] = fetchMock.mock.calls[0];
    expect(String(init.body)).not.toContain("reference_images");
  });

  it("upgrades uploaded reference images when the preferred vendor is not the chat-image adapter", async () => {
    vi.stubEnv("VITE_API_BASE_URL", "https://canvas.example.com");
    try {
      const { useStore } = await loadStore();
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => JSON.stringify({
          data: { type: "queued", task_id: "task-gemini-ref", status: "pending" },
          request_id: "req-gemini-ref",
        }),
      });
      vi.stubGlobal("fetch", fetchMock);

      useStore.getState().setBackendModels([
        {
          id: "google-template",
          service_type: "image",
          vendor: "Google",
          name: "Google Imagen",
          protocol: "openai_compatible",
          model_list: ["gemini-2.5-flash-image"],
          default_model: "gemini-2.5-flash-image",
          priority: 0,
          parameter_schema: {},
        },
        {
          id: "manju-adapter",
          service_type: "image",
          vendor: "ManjuAPI",
          name: "ManjuAPI / Chat 图片生成",
          protocol: "openai_compatible",
          model_list: ["gemini-2.5-flash-image"],
          default_model: "gemini-2.5-flash-image",
          priority: 1,
          parameter_schema: {
            reference_request_format: "chat_completions_image",
          },
        },
      ]);
      useStore.getState().updateNodeGenerationParams("2", { vendor: "Google" });
      useStore.getState().addNode({
        id: "ref-image-gemini-upload",
        type: "referenceImageNode",
        position: { x: 0, y: 0 },
        data: { url: "/uploads/2026-06/gemini-reference.png" },
      } as never);
      useStore.getState().onConnect({
        source: "ref-image-gemini-upload",
        target: "2",
        sourceHandle: null,
        targetHandle: null,
      });

      await useStore.getState().runNode("2", { prompt: "use upload", model: "gemini-2.5-flash-image" });

      const [, init] = fetchMock.mock.calls[0];
      expect(String(init.body)).toContain("\"reference_images\":[\"https://canvas.example.com/uploads/2026-06/gemini-reference.png\"]");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("uploads generated data urls so image nodes survive refresh", async () => {
    const { useStore } = await loadStore();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (input === "/api/app/generate") {
        return {
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          text: async () => JSON.stringify({
            data: { type: "url", content: "data:image/png;base64,ZmFrZQ==" },
            request_id: "req-generate-data-url",
          }),
        };
      }
      if (input === "data:image/png;base64,ZmFrZQ==") {
        return {
          ok: true,
          blob: async () => new Blob(["fake"], { type: "image/png" }),
        };
      }
      if (input === "/api/app/upload") {
        return {
          ok: true,
          text: async () => JSON.stringify({
            data: { url: "/uploads/2026-06/generated.png", filename: "generated.png", content_type: "image/png" },
            request_id: "req-upload-generated",
          }),
        };
      }
      throw new Error(`Unexpected fetch input: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await useStore.getState().runNode("2", { prompt: "test upload persisted image", model: "gpt-image-2" });

    const imageNode = useStore.getState().nodes.find((node) => node.id === "2");
    expect((imageNode?.data as Record<string, unknown>)?.url).toBe("/uploads/2026-06/generated.png");
    expect(useStore.getState().history[0]?.thumbnail).toBe("/uploads/2026-06/generated.png");
    expect(fetchMock).toHaveBeenCalledWith("/api/app/upload", expect.objectContaining({ method: "POST", credentials: "include" }));
  });

  it("downloads remote generated image urls into uploads before persisting", async () => {
    const { useStore } = await loadStore();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (input === "/api/app/generate") {
        return {
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          text: async () => JSON.stringify({
            data: { type: "url", content: "https://example.com/generated-remote.png" },
            request_id: "req-generate-remote-url",
          }),
        };
      }
      // Remote URLs are now fetched through the backend proxy to avoid
      // CORS / referer / mixed-content failures on third-party hosts.
      if (
        typeof input === "string"
        && input.startsWith("/api/app/proxy-media?url=")
        && input.includes(encodeURIComponent("https://example.com/generated-remote.png"))
      ) {
        return {
          ok: true,
          blob: async () => new Blob(["remote"], { type: "image/png" }),
        };
      }
      if (input === "/api/app/upload") {
        return {
          ok: true,
          text: async () => JSON.stringify({
            data: { url: "/uploads/2026-06/generated-remote.png", filename: "generated-remote.png", content_type: "image/png" },
            request_id: "req-upload-remote-generated",
          }),
        };
      }
      throw new Error(`Unexpected fetch input: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await useStore.getState().runNode("2", { prompt: "persist remote image", model: "gpt-image-2" });

    const imageNode = useStore.getState().nodes.find((node) => node.id === "2");
    expect((imageNode?.data as Record<string, unknown>)?.url).toBe("/uploads/2026-06/generated-remote.png");
    expect(useStore.getState().history[0]?.thumbnail).toBe("/uploads/2026-06/generated-remote.png");
    // Should hit the backend proxy with the encoded remote URL, NOT the
    // remote URL directly.
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/api/app/proxy-media?url=${encodeURIComponent("https://example.com/generated-remote.png")}`),
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith("/api/app/upload", expect.objectContaining({ method: "POST", credentials: "include" }));
  });

  it("rehydrates generated image history after a reload", async () => {
    const sharedStorage = createStorageMock();
    const firstModule = await loadStore(sharedStorage);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (input === "/api/app/generate") {
        return {
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          text: async () => JSON.stringify({
            data: { type: "url", content: "data:image/png;base64,ZmFrZQ==" },
            request_id: "req-rehydrate-data-url",
          }),
        };
      }
      if (input === "data:image/png;base64,ZmFrZQ==") {
        return {
          ok: true,
          blob: async () => new Blob(["fake"], { type: "image/png" }),
        };
      }
      if (input === "/api/app/upload") {
        return {
          ok: true,
          text: async () => JSON.stringify({
            data: { url: "/uploads/2026-06/rehydrated.png", filename: "rehydrated.png", content_type: "image/png" },
            request_id: "req-upload-rehydrated",
          }),
        };
      }
      throw new Error(`Unexpected fetch input: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await firstModule.useStore.getState().runNode("2", { prompt: "persist across reload", model: "gpt-image-2" });

    const secondModule = await loadStore(sharedStorage);
    const rehydratedState = secondModule.useStore.getState();
    const imageNode = rehydratedState.nodes.find((node) => node.id === "2");

    expect((imageNode?.data as Record<string, unknown>)?.url).toBe("/uploads/2026-06/rehydrated.png");
    expect(rehydratedState.history[0]?.mediaType).toBe("image");
    expect(rehydratedState.history[0]?.thumbnail).toBe("/uploads/2026-06/rehydrated.png");
  });

  it("drops transient blob urls from persisted nodes and history on reload", async () => {
    const sharedStorage = createStorageMock();
    const firstModule = await loadStore(sharedStorage);

    firstModule.useStore.getState().addNode({
      id: "blob-ref-image",
      type: "referenceImageNode",
      position: { x: 24, y: 24 },
      data: { url: "blob:http://localhost:5173/temp-image" },
    } as never);
    firstModule.useStore.getState().addHistory({
      id: "blob-history-image",
      title: "Transient image",
      type: "image",
      timestamp: 1,
      thumbnail: "blob:http://localhost:5173/temp-history",
    });

    const secondModule = await loadStore(sharedStorage);
    const rehydratedState = secondModule.useStore.getState();
    const blobNode = rehydratedState.nodes.find((node) => node.id === "blob-ref-image");

    expect((blobNode?.data as Record<string, unknown>)?.url).toBe("");
    expect(rehydratedState.history.find((item) => item.id === "blob-history-image")?.thumbnail).toBe("");
  });

  it("strips inline image mentions when structured reference images are present", async () => {
    const { useStore } = await loadStore();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify({
        data: { type: "url", content: "https://example.com/generated.png" },
        request_id: "req-image-ref-strip",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    useStore.getState().addNode({
      id: "ref-image-strip",
      type: "referenceImageNode",
      position: { x: 0, y: 0 },
      data: { url: "https://example.com/reference.png" },
    } as never);
    useStore.getState().onConnect({
      source: "ref-image-strip",
      target: "2",
      sourceHandle: null,
      targetHandle: null,
    });

    await useStore.getState().runNode("2", { prompt: "make it glossy @ref-image-st", model: "gpt-image-2" });

    const [, init] = fetchMock.mock.calls[0];
    expect(String(init.body)).toContain("\"prompt\":\"make it glossy\"");
    expect(String(init.body)).not.toContain("/uploads/");
    expect(String(init.body)).not.toContain("@ref-image-st");
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
      data: { url: "http://localhost:8080/uploads/2026-01/ref-2.png" },
    } as never);
    useStore.getState().addNode({
      id: "ref-video-1",
      type: "referenceVideoNode",
      position: { x: 0, y: 0 },
      data: { url: "http://localhost:8080/uploads/2026-01/ref.mp4" },
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
    // Backend-relative /uploads/ paths are extracted so the backend can read local files.
    expect(String(init.body)).toContain("\"reference_images\":[\"/uploads/2026-01/ref-2.png\"]");
    expect(String(init.body)).toContain("\"reference_video\":\"/uploads/2026-01/ref.mp4\"");
    expect(String(init.body)).not.toContain("data:image/png;base64,from-drop");
    expect(String(init.body)).not.toContain("data:video/mp4;base64,from-drop");
  });

  it("passes through video derivation fields and records source metadata in history", async () => {
    const { useStore } = await loadStore();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify({
        data: { type: "url", content: "https://example.com/derived.mp4" },
        request_id: "req-video-derive",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    useStore.getState().addNode({
      id: "video-source",
      type: "videoNode",
      position: { x: 0, y: 0 },
      data: { url: "http://localhost:8080/uploads/2026-01/source.mp4" },
    } as never);
    useStore.getState().addNode({
      id: "video-derived",
      type: "videoNode",
      position: { x: 0, y: 0 },
      data: {
        derivedFromNodeId: "video-source",
        derivationAction: "trim",
        generationParams: {
          trimRange: { start: 1.5, end: 4.2 },
          cropRect: { x: 0.1, y: 0.2, width: 0.7, height: 0.6 },
          targetTracks: ["video", "audio"],
          outputFormat: "mp4",
          editOperation: "trim",
          deriveFromNodeId: "video-source",
          referenceVideo: "http://localhost:8080/uploads/2026-01/source.mp4",
        },
      },
    } as never);

    await useStore.getState().runNode("video-derived", { prompt: "trim this clip", model: "sora-v3-fast" });

    const [, init] = fetchMock.mock.calls[0];
    expect(String(init.body)).toContain("\"trim_range\":{\"start\":1.5,\"end\":4.2}");
    expect(String(init.body)).toContain("\"crop_rect\":{\"x\":0.1,\"y\":0.2,\"width\":0.7,\"height\":0.6}");
    expect(String(init.body)).toContain("\"target_tracks\":[\"video\",\"audio\"]");
    expect(String(init.body)).toContain("\"output_format\":\"mp4\"");
    expect(String(init.body)).toContain("\"derive_from_node_id\":\"video-source\"");

    expect(useStore.getState().history[0]).toMatchObject({
      sourceNodeId: "video-source",
      derivationAction: "trim",
    });
  });

  it("updates arbitrary node ui state through updateNodeData", async () => {
    const { useStore } = await loadStore();

    useStore.getState().addNode({
      id: "text-mode-node",
      type: "textNode",
      position: { x: 0, y: 0 },
      data: {},
    } as never);

    useStore.getState().updateNodeData("text-mode-node", {
      textMode: "reverse_prompt",
      reversePromptDraft: "draft content",
      customTitle: "自定义标题",
    });

    const node = useStore.getState().nodes.find((item) => item.id === "text-mode-node");
    expect(node?.data).toMatchObject({
      textMode: "reverse_prompt",
      reversePromptDraft: "draft content",
      customTitle: "自定义标题",
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const toastWarningMock = vi.hoisted(() => vi.fn());

vi.mock("sonner", () => ({
  toast: {
    warning: toastWarningMock,
  },
}));

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
    toastWarningMock.mockReset();
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

  it("reuses selected image, video and audio history items as reference nodes", async () => {
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

    expect(appendedNodes).toHaveLength(3);
    expect(appendedNodes.map((node) => node.type).sort()).toEqual([
      "referenceAudioNode",
      "referenceImageNode",
      "referenceVideoNode",
    ]);
    expect(appendedNodes.map((node) => (node.data as Record<string, unknown>)?.url).sort()).toEqual([
      "https://example.com/reuse-audio.mp3",
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

  it("keeps the node and shows an admin contact hint when credits are insufficient", async () => {
    const { useStore } = await loadStore();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify({
        error: {
          code: "insufficient_credits",
          message: "积分不足，请充值或开通会员后重试",
        },
        request_id: "req-insufficient-credits",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await useStore.getState().runNode("2", { prompt: "test", model: "gpt-image-2" });

    const imageNode = useStore.getState().nodes.find((node) => node.id === "2");
    expect(imageNode).toBeDefined();
    expect((imageNode?.data as Record<string, unknown>)?.status).toBe("error");
    expect((imageNode?.data as Record<string, unknown>)?.error).toBe("积分不足请联系管理员");
    expect(toastWarningMock).toHaveBeenCalledWith("积分不足请联系管理员", {
      id: "insufficient-credits",
      duration: 3200,
    });
    expect(useStore.getState().nodes.some((node) => node.id === "2")).toBe(true);
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

  it("keeps queued generations running until task success writes back to the node", async () => {
    const { useStore } = await loadStore();
    let resolveTask!: (response: Response) => void;
    const taskLookup = new Promise<Response>((resolve) => {
      resolveTask = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/app/generate") {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          text: async () => JSON.stringify({
            data: { type: "queued", task_id: "task-queued-success", status: "pending" },
            request_id: "req-queued-success",
          }),
        } as Response);
      }
      if (url === "/api/app/tasks/task-queued-success") {
        return taskLookup;
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    await useStore.getState().runNode("2", { prompt: "queued wolf", model: "doubao-seedream-5-0-260128" });

    let imageNode = useStore.getState().nodes.find((node) => node.id === "2");
    expect((imageNode?.data as Record<string, unknown>)?.status).toBe("running");
    expect((imageNode?.data as Record<string, unknown>)?.taskId).toBe("task-queued-success");
    expect(useStore.getState().activeRun?.nodeId).toBe("2");

    resolveTask({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify({
        data: {
          id: "task-queued-success",
          node_id: "2",
          service_type: "image",
          model: "doubao-seedream-5-0-260128",
          status: "success",
          result_url: "https://example.com/queued-wolf.png",
          error_msg: "",
          duration_ms: 33000,
          created_at: new Date().toISOString(),
        },
        request_id: "req-task-success",
      }),
    } as Response);
    await taskLookup;
    await new Promise((resolve) => setTimeout(resolve, 0));

    imageNode = useStore.getState().nodes.find((node) => node.id === "2");
    expect((imageNode?.data as Record<string, unknown>)?.status).toBe("done");
    // Persisted value is the raw upstream URL; proxy wrapping happens at render time.
    expect((imageNode?.data as Record<string, unknown>)?.url).toBe("https://example.com/queued-wolf.png");
    expect((imageNode?.data as Record<string, unknown>)?.output).toBe("https://example.com/queued-wolf.png");
    expect((imageNode?.data as Record<string, unknown>)?.originalUrl).toBe("https://example.com/queued-wolf.png");
    expect(useStore.getState().activeRun).toBeNull();
  });

  it("settles a running node from a task stream event even when the task id was not persisted", async () => {
    let eventSource: { onmessage: ((message: MessageEvent) => void) | null } | null = null;
    class MockEventSource {
      onmessage: ((message: MessageEvent) => void) | null = null;
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      close = vi.fn();

      constructor() {
        eventSource = this;
      }
    }
    vi.stubGlobal("EventSource", MockEventSource as unknown as typeof EventSource);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/app/tasks/active") {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          text: async () => JSON.stringify({ data: [], request_id: "req-active-empty" }),
        } as Response);
      }
      return Promise.reject(new Error(`unexpected fetch ${String(input)}`));
    }));

    try {
      const { useStore } = await loadStore();
      useStore.getState().updateNodeData("2", {
        status: "running",
        taskId: undefined,
        queuedAfterTimeout: true,
        runningStartedAt: Date.now(),
      });

      const stream = eventSource as { onmessage: ((message: MessageEvent) => void) | null } | null;
      expect(stream).not.toBeNull();
      stream!.onmessage?.({
        data: JSON.stringify({
          task_id: "task-stream-lost-binding",
          node_id: "2",
          service_type: "image",
          status: "success",
          result_url: "https://example.com/stream-result.png",
          error_msg: "",
          duration_ms: 161000,
        }),
      } as MessageEvent);

      const imageNode = useStore.getState().nodes.find((node) => node.id === "2");
      expect((imageNode?.data as Record<string, unknown>)?.status).toBe("done");
      expect((imageNode?.data as Record<string, unknown>)?.taskId).toBe("task-stream-lost-binding");
      expect((imageNode?.data as Record<string, unknown>)?.url).toBe("https://example.com/stream-result.png");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("recovers a running node without a task id from the batch task poller", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-29T10:00:00.000Z"));
    const taskCreatedAt = new Date(Date.now() - 5000).toISOString();
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/app/tasks/active") {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          text: async () => JSON.stringify({ data: [], request_id: "req-active-empty" }),
        } as Response);
      }
      if (url === "/api/app/tasks/batch") {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          text: async () => JSON.stringify({
            data: [
              {
                id: "task-batch-lost-binding",
                node_id: "2",
                service_type: "image",
                model: "gpt-image-2",
                status: "success",
                result_url: "https://example.com/batch-result.png",
                error_msg: "",
                duration_ms: 161000,
                created_at: taskCreatedAt,
              },
            ],
            request_id: "req-batch-success",
          }),
        } as Response);
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const { useStore } = await loadStore();
      useStore.getState().updateNodeData("2", {
        status: "running",
        taskId: undefined,
        queuedAfterTimeout: true,
        runningStartedAt: Date.now(),
      });

      await vi.advanceTimersByTimeAsync(8000);

      const imageNode = useStore.getState().nodes.find((node) => node.id === "2");
      expect((imageNode?.data as Record<string, unknown>)?.status).toBe("done");
      expect((imageNode?.data as Record<string, unknown>)?.taskId).toBe("task-batch-lost-binding");
      expect((imageNode?.data as Record<string, unknown>)?.url).toBe("https://example.com/batch-result.png");
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
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

  it("keeps public COS reference image urls intact for chat-image providers", async () => {
    const { useStore } = await loadStore();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify({
        data: { type: "url", content: "https://example.com/generated.png" },
        request_id: "req-cos-ref",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    useStore.getState().setBackendModels([
      {
        id: "pc-manju-cos",
        service_type: "image",
        vendor: "ManjuAPI",
        name: "ManjuAPI / Chat image generation",
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
      id: "ref-image-cos",
      type: "referenceImageNode",
      position: { x: 0, y: 0 },
      data: {
        url: "https://ccy-canvas-1334659054.cos.ap-beijing.myqcloud.com/ccy-canvas/uploads/2026-06/reference.png",
      },
    } as never);
    useStore.getState().onConnect({
      source: "ref-image-cos",
      target: "2",
      sourceHandle: null,
      targetHandle: null,
    });

    await useStore.getState().runNode("2", { prompt: "use cos reference", model: "gemini-2.5-flash-image" });

    const [, init] = fetchMock.mock.calls[0];
    expect(String(init.body)).toContain(
      "\"reference_images\":[\"https://ccy-canvas-1334659054.cos.ap-beijing.myqcloud.com/ccy-canvas/uploads/2026-06/reference.png\"]",
    );
  });

  it("blocks non-public reference images for chat-image providers", async () => {
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

    expect(fetchMock).not.toHaveBeenCalled();
    const imageNode = useStore.getState().nodes.find((node) => node.id === "2");
    expect((imageNode?.data as Record<string, unknown>)?.status).toBe("error");
    expect((imageNode?.data as Record<string, unknown>)?.error).toContain("公网");
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
      expect(String(init.body)).toContain("\"provider_config_id\":\"manju-adapter\"");
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

  it("treats malformed saved assets from persisted state as an empty list", async () => {
    const sharedStorage = createStorageMock(new Map([
      ["cineflow-store", JSON.stringify({
        state: {
          nodes: [
            { id: "legacy-image", type: "imageNode", position: { x: 0, y: 0 }, data: {} },
          ],
          edges: [],
          history: [],
          groups: [],
          projects: [{ id: "p-default", name: "Untitled", createdAt: 1, updatedAt: 1 }],
          activeProjectId: "p-default",
          projectStateById: {
            "p-default": {
              nodes: [
                { id: "legacy-image", type: "imageNode", position: { x: 0, y: 0 }, data: {} },
              ],
              edges: [],
              groups: [],
            },
          },
          savedAssets: null,
        },
        version: 5,
      })],
    ]));
    const { useStore } = await loadStore(sharedStorage);

    expect(useStore.getState().savedAssets).toEqual([]);
    expect(() => {
      useStore.getState().updateNodeGenerationParams("legacy-image", { aspectRatio: "16:9" });
    }).not.toThrow();
  });

  it("does not persist heavy inline media fields that can exceed browser storage quota", async () => {
    const sharedStorage = createStorageMock();
    const { useStore } = await loadStore(sharedStorage);
    const inlineImage = "data:image/png;base64," + "x".repeat(1024);

    useStore.getState().addNode({
      id: "inline-heavy-image",
      type: "imageNode",
      position: { x: 24, y: 24 },
      data: {
        url: inlineImage,
        output: inlineImage,
        referenceValue: inlineImage,
        generationParams: {
          referenceImages: [inlineImage, "/uploads/2026-06/reference.png"],
          maskImage: inlineImage,
        },
        versions: [
          { id: "bad", url: inlineImage, timestamp: 1 },
          { id: "good", url: "/uploads/2026-06/version.png", thumbnail: inlineImage, timestamp: 2 },
        ],
      },
    } as never);

    const persistedValues: string[] = [];
    for (let index = 0; index < sharedStorage.length; index += 1) {
      const key = sharedStorage.key(index);
      if (key) persistedValues.push(sharedStorage.getItem(key) ?? "");
    }
    const persisted = persistedValues.join("\n");

    expect(persisted).not.toContain(inlineImage);
    expect(persisted).toContain("/uploads/2026-06/reference.png");
    expect(persisted).toContain("/uploads/2026-06/version.png");
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
    // Node "2" has the default upstream text node ("1") wired in, so its content
    // is auto-referenced into the prompt (connect = auto-reference). The user's
    // own prompt still survives and the @mention is still stripped.
    expect(String(init.body)).toContain("make it glossy");
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

  it("sends seed + audio_setting for a HappyHorse video-edit run that has them set", async () => {
    const { useStore } = await loadStore();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify({
        data: { type: "url", content: "https://example.com/generated.mp4" },
        request_id: "req-vedit",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    useStore.getState().addNode({ id: "vedit-gen", type: "videoNode", position: { x: 0, y: 0 }, data: {} } as never);
    useStore.getState().addNode({
      id: "vedit-src",
      type: "referenceVideoNode",
      position: { x: 0, y: 0 },
      data: { url: "https://example.com/source.mp4" },
    } as never);
    useStore.getState().onConnect({ source: "vedit-src", target: "vedit-gen", sourceHandle: null, targetHandle: null });
    useStore.getState().updateNodeGenerationParams("vedit-gen", { seed: 12345, audioSetting: "origin" });

    await useStore.getState().runNode("vedit-gen", { prompt: "restyle it", model: "happyhorse-1.0-video-edit" });

    const [, init] = fetchMock.mock.calls[0];
    expect(String(init.body)).toContain("\"seed\":12345");
    expect(String(init.body)).toContain("\"audio_setting\":\"origin\"");
  });

  it("omits audio_setting for a mode that doesn't support it, and seed when unset", async () => {
    const { useStore } = await loadStore();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify({
        data: { type: "url", content: "https://example.com/generated.mp4" },
        request_id: "req-t2v",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    // t2v supports seed but has NO audioSettingOptions; seed is left unset here.
    useStore.getState().addNode({ id: "t2v-gen", type: "videoNode", position: { x: 0, y: 0 }, data: {} } as never);
    await useStore.getState().runNode("t2v-gen", { prompt: "a city at night", model: "happyhorse-1.1-t2v" });

    const [, init] = fetchMock.mock.calls[0];
    expect(String(init.body)).not.toContain("audio_setting");
    expect(String(init.body)).not.toContain("\"seed\"");
  });

  it("uses original public urls instead of proxy media urls for video references", async () => {
    const { useStore } = await loadStore();
    const remoteImageUrl = "https://ark-acg-cn-beijing.tos-cn-beijing.volces.com/doubao-seedream-5-0/reference.jpeg?X-Tos-Expires=86400&X-Tos-Signature=abc";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify({
        data: { type: "url", content: "https://example.com/generated.mp4" },
        request_id: "req-video-proxy-ref",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    useStore.getState().addNode({
      id: "video-gen-proxy-ref",
      type: "videoNode",
      position: { x: 0, y: 0 },
      data: {},
    } as never);
    useStore.getState().addNode({
      id: "generated-image-ref",
      type: "imageNode",
      position: { x: 0, y: 0 },
      data: {
        url: `/api/app/proxy-media?url=${encodeURIComponent(remoteImageUrl)}`,
        originalUrl: remoteImageUrl,
      },
    } as never);
    useStore.getState().onConnect({
      source: "generated-image-ref",
      target: "video-gen-proxy-ref",
      sourceHandle: null,
      targetHandle: null,
    });

    await useStore.getState().runNode("video-gen-proxy-ref", { prompt: "animate this", model: "doubao-seedance" });

    const [, init] = fetchMock.mock.calls[0];
    expect(String(init.body)).toContain(`"reference_images":["${remoteImageUrl}"]`);
    expect(String(init.body)).not.toContain("/api/app/proxy-media");
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

describe("keyboard shortcuts + undo/redo/delete", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("eventMatchesShortcut honors defaults (Ctrl+Z undo, Ctrl+Y redo, Delete)", async () => {
    const { DEFAULT_SHORTCUTS, eventMatchesShortcut, formatShortcutCombo } = await loadStore();
    const sc = { ...DEFAULT_SHORTCUTS };
    const ev = (o: Partial<KeyboardEvent>) =>
      ({ ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...o } as KeyboardEvent);

    expect(formatShortcutCombo(ev({ ctrlKey: true, key: "z" }))).toBe("Ctrl+Z");
    expect(formatShortcutCombo(ev({ ctrlKey: true, shiftKey: true, key: "z" }))).toBe("Ctrl+Shift+Z");
    expect(eventMatchesShortcut(ev({ ctrlKey: true, key: "z" }), "undo", sc)).toBe(true);
    expect(eventMatchesShortcut(ev({ ctrlKey: true, key: "y" }), "redo", sc)).toBe(true);
    expect(eventMatchesShortcut(ev({ key: "Delete" }), "delete_node", sc)).toBe(true);
    // A custom binding is respected over the default.
    expect(eventMatchesShortcut(ev({ ctrlKey: true, key: "d" }), "delete_node", { ...sc, delete_node: "Ctrl+D" })).toBe(true);
    expect(eventMatchesShortcut(ev({ ctrlKey: true, key: "z" }), "redo", sc)).toBe(false);
  });

  it("delete → undo → redo round-trips the selected node", async () => {
    const { useStore } = await loadStore();
    useStore.getState().addNode({ id: "kbd-1", type: "textNode", position: { x: 0, y: 0 }, data: {} } as never);
    // Mark it selected (Del acts on the current selection).
    useStore.setState({ nodes: useStore.getState().nodes.map((n) => (n.id === "kbd-1" ? { ...n, selected: true } : n)) } as never);

    useStore.getState().deleteSelectedNodes();
    expect(useStore.getState().nodes.find((n) => n.id === "kbd-1")).toBeUndefined();

    useStore.getState().undoCanvas();
    expect(useStore.getState().nodes.find((n) => n.id === "kbd-1")).toBeDefined();

    useStore.getState().redoCanvas();
    expect(useStore.getState().nodes.find((n) => n.id === "kbd-1")).toBeUndefined();
  });

  it("a whole drag is one undo step (position changes don't spam the undo stack)", async () => {
    const { useStore } = await loadStore();
    useStore.getState().addNode({ id: "drag-1", type: "textNode", position: { x: 0, y: 0 }, data: {} } as never);
    const baseUndo = useStore.getState().undoStack.length;

    // Simulate a drag: pre-drag snapshot once, then many per-frame position changes.
    useStore.getState().pushUndoSnapshot();
    for (let i = 1; i <= 20; i++) {
      useStore.getState().onNodesChange([
        { type: "position", id: "drag-1", position: { x: i, y: i }, dragging: true } as never,
      ]);
    }
    // Exactly one snapshot for the whole drag — not 20+.
    expect(useStore.getState().undoStack.length).toBe(baseUndo + 1);
    expect(useStore.getState().nodes.find((n) => n.id === "drag-1")?.position).toEqual({ x: 20, y: 20 });

    // One undo restores the pre-drag position in a single step.
    useStore.getState().undoCanvas();
    expect(useStore.getState().nodes.find((n) => n.id === "drag-1")?.position).toEqual({ x: 0, y: 0 });
  });

  it("a fresh edit after undo clears the redo stack", async () => {
    const { useStore } = await loadStore();
    useStore.getState().addNode({ id: "kbd-a", type: "textNode", position: { x: 0, y: 0 }, data: {} } as never);
    useStore.getState().undoCanvas();
    expect(useStore.getState().redoStack.length).toBeGreaterThan(0);
    // Any node change (a fresh edit) invalidates redo.
    useStore.getState().onNodesChange([{ type: "add", item: { id: "kbd-b", type: "textNode", position: { x: 10, y: 10 }, data: {} } } as never]);
    expect(useStore.getState().redoStack.length).toBe(0);
  });
});

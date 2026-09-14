import { describe, expect, it, vi } from "vitest";

import { createCanvasPatchApplier, type CanvasPatchBindings } from "./canvas-patch-apply";
import type { CanvasPatch } from "./api/agent-run";

function makeBindings(overrides: Partial<CanvasPatchBindings> = {}) {
  const calls = {
    addNode: vi.fn(),
    onConnect: vi.fn(),
    updateNodeData: vi.fn(),
    moveNodeTo: vi.fn(),
    deleteNodes: vi.fn(),
    createGroup: vi.fn(),
    runNode: vi.fn(),
  };
  const bindings: CanvasPatchBindings = {
    ...calls,
    getNode: () => undefined,
    backendModels: [],
    ...overrides,
  };
  return { bindings, calls };
}

describe("createCanvasPatchApplier", () => {
  it("按 op 分发到对应 store 动作，并记录 revision", () => {
    const { bindings, calls } = makeBindings();
    const applier = createCanvasPatchApplier(bindings);
    applier.reset(0);

    const addResult = applier.applyPatch({
      op: "add_node",
      node: { id: "n1", type: "imageNode", position: { x: 0, y: 0 }, data: { promptDraft: "a" } },
      base_revision: 0,
      revision: 1,
    } as unknown as CanvasPatch);

    expect(addResult).toEqual({ applied: true, op: "add_node", revision: 1 });
    expect(calls.addNode).toHaveBeenCalledTimes(1);
    expect(applier.currentRevision()).toBe(1);

    applier.applyPatch({
      op: "patch_node_data",
      node_id: "n1",
      patch: { promptDraft: "b" },
      base_revision: 1,
      revision: 2,
    } as unknown as CanvasPatch);
    expect(calls.updateNodeData).toHaveBeenCalledWith("n1", { promptDraft: "b" });

    applier.applyPatch({
      op: "delete_node",
      node_id: "n1",
      base_revision: 2,
      revision: 3,
    } as unknown as CanvasPatch);
    expect(calls.deleteNodes).toHaveBeenCalledWith(["n1"]);
  });

  it("add_node 缺失 data 时兜底补空对象，避免节点渲染器崩溃", () => {
    const { bindings, calls } = makeBindings();
    const applier = createCanvasPatchApplier(bindings);
    applier.reset(0);

    applier.applyPatch({
      op: "add_node",
      node: { id: "n1", type: "textNode", position: { x: 0, y: 0 } },
      base_revision: 0,
      revision: 1,
    } as unknown as CanvasPatch);

    expect(calls.addNode).toHaveBeenCalledWith(expect.objectContaining({ id: "n1", data: {} }));
  });

  it("add_edge 把 handle 归一化为 null", () => {
    const { bindings, calls } = makeBindings();
    const applier = createCanvasPatchApplier(bindings);
    applier.reset(0);

    applier.applyPatch({
      op: "add_edge",
      edge: { id: "e1", source: "n1", target: "n2" },
      base_revision: 0,
      revision: 1,
    } as unknown as CanvasPatch);

    expect(calls.onConnect).toHaveBeenCalledWith({
      source: "n1",
      target: "n2",
      sourceHandle: null,
      targetHandle: null,
    });
  });

  it("revision 不连续时拒绝应用并保留原 revision", () => {
    const { bindings, calls } = makeBindings();
    const onRejected = vi.fn();
    const applier = createCanvasPatchApplier(bindings, { onRejected });
    applier.reset(3);

    const result = applier.applyPatch({
      op: "delete_node",
      node_id: "n9",
      base_revision: 7,
      revision: 8,
    } as unknown as CanvasPatch);

    expect(result.applied).toBe(false);
    expect(calls.deleteNodes).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledTimes(1);
    expect(applier.currentRevision()).toBe(3);
  });

  it("接受不带版本信息的旧 patch（向后兼容）", () => {
    const { bindings, calls } = makeBindings();
    const applier = createCanvasPatchApplier(bindings);
    applier.reset(5);

    const result = applier.applyPatch({
      op: "create_group",
      node_ids: ["n1"],
      name: "镜头组",
    } as unknown as CanvasPatch);

    expect(result.applied).toBe(true);
    expect(calls.createGroup).toHaveBeenCalledWith(["n1"], "镜头组");
  });

  it("run_node 只入队、不臆造完成状态，并把缺省模型按 service_type 归一化", () => {
    const runNode = vi.fn();
    const { bindings, calls } = makeBindings({
      runNode,
      getNode: () => ({ id: "n2", type: "videoNode", data: { promptDraft: "镜头推进" } }) as never,
      backendModels: [
        { service_type: "image", model_list: ["img-a"] },
        { service_type: "video", model_list: ["vid-a", "vid-b"] },
      ],
    });
    const applier = createCanvasPatchApplier(bindings);
    applier.reset(0);

    applier.applyPatch({
      op: "run_node",
      node_id: "n2",
      base_revision: 0,
      revision: 1,
    } as unknown as CanvasPatch);

    expect(runNode).toHaveBeenCalledWith("n2", { prompt: "镜头推进", model: "vid-a" });
    expect(calls.updateNodeData).not.toHaveBeenCalled();
  });

  it("run_node 自带 prompt/model 时使用 patch 内的值，避免与 store 竞态", () => {
    const runNode = vi.fn();
    const { bindings, calls } = makeBindings({ runNode });
    const applier = createCanvasPatchApplier(bindings);
    applier.reset(0);

    applier.applyPatch({
      op: "run_node",
      node_id: "n2",
      prompt: "patch 内的提示词",
      model: "img-explicit",
      base_revision: 0,
      revision: 1,
    } as unknown as CanvasPatch);

    expect(calls.updateNodeData).toHaveBeenCalledWith("n2", { model: "img-explicit" });
    expect(runNode).toHaveBeenCalledWith("n2", { prompt: "patch 内的提示词", model: "img-explicit" });
  });

  it("run_node 没有可用提示词时不触发生成", () => {
    const runNode = vi.fn();
    const { bindings } = makeBindings({
      runNode,
      getNode: () => ({ id: "n2", type: "imageNode", data: {} }) as never,
    });
    const applier = createCanvasPatchApplier(bindings);
    applier.reset(0);

    applier.applyPatch({ op: "run_node", node_id: "n2", base_revision: 0, revision: 1 } as unknown as CanvasPatch);

    expect(runNode).not.toHaveBeenCalled();
  });

  it("applyEvent 只处理 canvas_patch，其它事件返回 null", () => {
    const { bindings, calls } = makeBindings();
    const applier = createCanvasPatchApplier(bindings);
    applier.reset(0);

    expect(applier.applyEvent({ type: "message", data: { content: "hi" } })).toBeNull();
    expect(calls.addNode).not.toHaveBeenCalled();

    const applied = applier.applyEvent({
      type: "canvas_patch",
      data: {
        op: "move_node",
        node_id: "n1",
        position: { x: 10, y: 20 },
        base_revision: 0,
        revision: 1,
      } as unknown as CanvasPatch,
    });
    expect(applied?.applied).toBe(true);
    expect(calls.moveNodeTo).toHaveBeenCalledWith("n1", { x: 10, y: 20 });
  });
});

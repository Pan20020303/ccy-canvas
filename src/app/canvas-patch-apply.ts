/**
 * 画布 patch 应用器 —— 把一条 canvas_patch 落到 store 上。
 *
 * 为什么单独抽出来：申请人（agent SSE 流、AgentNode 内联运行、dev 侧 bridge 回灌）
 * 越来越多，而"revision 校验 + op 分发"的规则必须只有一份，否则不同入口会各自漂移。
 *
 * 与后端契约：patch 形如
 *   { op: "add_node", node, base_revision?, revision? }
 * 版本校验复用 `advanceCanvasPatchRevision`（旧的无版本 patch 仍然接受）。
 */

import type { Edge, Node } from "@xyflow/react";

import { advanceCanvasPatchRevision, type AgentSSEEvent, type CanvasPatch } from "./api/agent-run";

/** 应用 patch 时需要的 store 能力。用窄接口而不是整个 store，方便测试与复用。 */
export type CanvasPatchBindings = {
  addNode: (node: Node) => void;
  onConnect: (connection: {
    source: string;
    target: string;
    sourceHandle?: string | null;
    targetHandle?: string | null;
  }) => void;
  updateNodeData: (nodeId: string, patch: Record<string, unknown>) => void;
  moveNodeTo: (nodeId: string, position: { x: number; y: number }) => void;
  deleteNodes: (nodeIds: string[]) => void;
  createGroup: (nodeIds: string[], name?: string) => void;
  runNode: (nodeId: string, payload: { prompt: string; model?: string }) => void | Promise<void>;
  /** 读取当前节点（run_node 需要按节点类型挑选模型）。 */
  getNode: (nodeId: string) => Node | undefined;
  /** 后端已配置的模型清单，用于按节点 service_type 归一化模型选择。 */
  backendModels: readonly { service_type: string; model_list?: string[] }[];
};

export type CanvasPatchHooks = {
  /** 校验失败（patch 版本不连续 / 与当前画布冲突）。 */
  onRejected?: (reason: string, patch: CanvasPatch) => void;
  /** 成功应用到画布之后（用于飞行定位、日志等）。 */
  onApplied?: (patch: CanvasPatch, revision: number | null) => void;
};

/** 节点类型 → 后端 service_type。与 AgentRunPanel 内的映射保持一致。 */
const SERVICE_TYPE_BY_NODE_TYPE: Record<string, string> = {
  textNode: "text",
  imageNode: "image",
  videoNode: "video",
  audioNode: "audio",
};

/**
 * 按 service_type 归一化模型清单：匹配节点类型的排前面，其余保留在后 —— 与面板里
 * 的行为一致（用户可能故意跨族选模型，但不该让默认值随机）。
 */
function sortModelsForServiceType(
  backendModels: CanvasPatchBindings["backendModels"],
  serviceType: string,
): string[] {
  const ordered = [...backendModels].sort((a, b) => {
    const aMatch = a.service_type === serviceType ? 0 : 1;
    const bMatch = b.service_type === serviceType ? 0 : 1;
    return aMatch - bMatch;
  });
  const seen = new Set<string>();
  const models: string[] = [];
  for (const config of ordered) {
    for (const model of config.model_list ?? []) {
      if (!seen.has(model)) {
        seen.add(model);
        models.push(model);
      }
    }
  }
  return models;
}

export type CanvasPatchResult =
  | { applied: true; op: CanvasPatch["op"]; revision: number | null }
  | { applied: false; op: CanvasPatch["op"]; reason: string };

export type CanvasPatchApplier = {
  /** 确保给定 revision 之后的下一条 patch 会被接受（切会话/重新连接时调用）。 */
  reset: (revision: number | null) => void;
  currentRevision: () => number | null;
  applyPatch: (patch: CanvasPatch) => CanvasPatchResult;
  /** 便捷入口：只有 canvas_patch 事件会被处理，其它事件静默忽略。 */
  applyEvent: (event: AgentSSEEvent) => CanvasPatchResult | null;
};

export function createCanvasPatchApplier(
  bindings: CanvasPatchBindings,
  hooks: CanvasPatchHooks = {},
): CanvasPatchApplier {
  let revision: number | null = null;

  function applyPatch(patch: CanvasPatch): CanvasPatchResult {
    const revisionResult = advanceCanvasPatchRevision(revision, patch);
    if (!revisionResult.accepted) {
      hooks.onRejected?.(revisionResult.reason, patch);
      return { applied: false, op: patch.op, reason: revisionResult.reason };
    }
    revision = revisionResult.nextRevision;

    switch (patch.op) {
      case "add_node": {
        // 兜底补 data：上游序列化可能省略它，缺了会让节点渲染器崩。
        const incoming = patch.node as Node;
        bindings.addNode({
          ...incoming,
          data: (incoming.data ?? {}) as Record<string, unknown>,
        });
        break;
      }
      case "add_edge": {
        const edge = patch.edge as Edge;
        bindings.onConnect({
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle ?? null,
          targetHandle: edge.targetHandle ?? null,
        });
        break;
      }
      case "patch_node_data":
        bindings.updateNodeData(patch.node_id, patch.patch);
        break;
      case "move_node":
        bindings.moveNodeTo(patch.node_id, patch.position);
        break;
      case "delete_node":
        bindings.deleteNodes([patch.node_id]);
        break;
      case "create_group":
        bindings.createGroup(patch.node_ids, patch.name);
        break;
      case "run_node": {
        // patch 自带 prompt/model，避免"建节点→写提示词→触发"三段流式事件与
        // React store 竞态导致跑到空提示词上。
        if (typeof patch.model === "string" && patch.model.trim()) {
          bindings.updateNodeData(patch.node_id, { model: patch.model.trim() });
        }
        const node = bindings.getNode(patch.node_id);
        const data = (node?.data ?? {}) as Record<string, string>;
        const prompt = typeof patch.prompt === "string" ? patch.prompt : (data.promptDraft ?? data.content ?? "");
        if (!prompt.trim()) break;
        const serviceType = SERVICE_TYPE_BY_NODE_TYPE[node?.type ?? ""] ?? "text";
        const explicitModel = typeof patch.model === "string" && patch.model.trim() ? patch.model.trim() : undefined;
        const fallbackModel = explicitModel ?? sortModelsForServiceType(bindings.backendModels, serviceType)[0];
        void bindings.runNode(patch.node_id, fallbackModel ? { prompt, model: fallbackModel } : { prompt });
        break;
      }
    }

    hooks.onApplied?.(patch, revision);
    return { applied: true, op: patch.op, revision };
  }

  return {
    reset: (next) => {
      revision = next;
    },
    currentRevision: () => revision,
    applyPatch,
    applyEvent: (event) => (event.type === "canvas_patch" ? applyPatch(event.data) : null),
  };
}

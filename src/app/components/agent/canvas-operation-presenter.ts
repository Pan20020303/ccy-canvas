import type { CanvasPatch } from "../../api/agent-run";

export type CanvasOperationEntity = "text" | "image" | "video" | "audio" | "node" | "connection" | "task";

export type CanvasOperationPresentation = {
  action: string;
  entity: CanvasOperationEntity;
  title: string;
  detail: string;
  nodeId?: string;
  position?: string;
};

const NODE_TYPE_LABELS: Record<string, { zh: string; en: string; entity: CanvasOperationEntity }> = {
  textNode: { zh: "文本节点", en: "Text node", entity: "text" },
  imageNode: { zh: "图片节点", en: "Image node", entity: "image" },
  referenceImageNode: { zh: "参考图片", en: "Reference image", entity: "image" },
  videoNode: { zh: "视频节点", en: "Video node", entity: "video" },
  referenceVideoNode: { zh: "参考视频", en: "Reference video", entity: "video" },
  audioNode: { zh: "音频节点", en: "Audio node", entity: "audio" },
};

function compactText(value: unknown, limit = 34): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function nodeTitle(data: Record<string, unknown>): string {
  const explicit = [data.customTitle, data.title, data.name, data.label]
    .map((value) => compactText(value))
    .find(Boolean);
  if (explicit) return explicit;
  return compactText(data.content ?? data.promptDraft ?? data.prompt);
}

function nodePresentation(node: CanvasPatch & { op: "add_node" }, zh: boolean): CanvasOperationPresentation {
  const data = (node.node.data ?? {}) as Record<string, unknown>;
  const nodeType = node.node.type ?? "";
  const type = NODE_TYPE_LABELS[nodeType] ?? { zh: "画布节点", en: "Canvas node", entity: "node" as const };
  const fallback = zh ? type.zh : type.en;
  const title = nodeTitle(data) || fallback;
  const x = Math.round(node.node.position?.x ?? 0);
  const y = Math.round(node.node.position?.y ?? 0);

  return {
    action: zh ? "已新增" : "Added",
    entity: type.entity,
    title,
    detail: fallback,
    nodeId: node.node.id,
    position: `${x}, ${y}`,
  };
}

export function presentCanvasOperation(patch: CanvasPatch, zh: boolean): CanvasOperationPresentation {
  switch (patch.op) {
    case "add_node":
      return nodePresentation(patch, zh);
    case "add_edge":
      return {
        action: zh ? "已连接" : "Connected",
        entity: "connection",
        title: zh ? "节点连接" : "Node connection",
        detail: `${patch.edge.source} → ${patch.edge.target}`,
      };
    case "patch_node_data":
      return {
        action: zh ? "已更新" : "Updated",
        entity: "node",
        title: zh ? "节点内容" : "Node content",
        detail: zh ? `${Object.keys(patch.patch).length} 个字段` : `${Object.keys(patch.patch).length} fields`,
        nodeId: patch.node_id,
      };
    case "run_node":
      return {
        action: zh ? "已启动" : "Started",
        entity: "task",
        title: zh ? "生成任务" : "Generation task",
        detail: patch.model || (zh ? "跟随节点模型" : "Node default model"),
        nodeId: patch.node_id,
      };
  }
}

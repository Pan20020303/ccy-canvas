import type { Node } from "@xyflow/react";

import type { AppProviderConfig } from "./api/providerConfigs";

export type TextNodeMode = "chooser" | "editor" | "reverse_prompt";

export function getTextNodeMode(value: unknown): TextNodeMode {
  // 新形态:文本节点默认就是「正文 + 常驻对话框」的 editor 态(参考产品样式),
  // 不再走 chooser 选择器;图片反推入口(仅在 chooser 里)也随之下线 —— 想反推
  // 就在对话框里 @图片 + 自己写提示词。仅保留 editor,历史遗留值一律归一到 editor。
  if (value === "reverse_prompt") {
    return "reverse_prompt";
  }
  return "editor";
}

export function canUseReversePrompt(upstreamNodes: Node[]): boolean {
  return upstreamNodes.some(
    (node) => node.type === "referenceImageNode" && Boolean((node.data as Record<string, unknown> | undefined)?.url),
  );
}

export function getFirstUpstreamReferenceImage(upstreamNodes: Node[]): Node | null {
  return (
    upstreamNodes.find(
      (node) => node.type === "referenceImageNode" && Boolean((node.data as Record<string, unknown> | undefined)?.url),
    ) ?? null
  );
}

function looksVisionCapable(model: AppProviderConfig) {
  const haystack = [model.vendor, model.name, ...model.model_list]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return ["vision", "vl", "glm-4.1v", "glm-4v", "gvlm", "gemini", "claude-3", "gpt-4o", "gpt-4.1"]
    .some((token) => haystack.includes(token));
}

export function filterReversePromptModels(models: AppProviderConfig[]) {
  return models.filter((model) => model.service_type === "image" && looksVisionCapable(model));
}

export function splitFilenameExtension(value: string) {
  const trimmed = value.trim();
  const lastDot = trimmed.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === trimmed.length - 1) {
    return { basename: trimmed, extension: "" };
  }

  return {
    basename: trimmed.slice(0, lastDot),
    extension: trimmed.slice(lastDot),
  };
}

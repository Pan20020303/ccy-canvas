import type { Node } from "@xyflow/react";

import type { AppProviderConfig } from "./api/providerConfigs";

export type TextNodeMode = "chooser" | "editor" | "reverse_prompt";

export function getTextNodeMode(value: unknown): TextNodeMode {
  if (value === "editor" || value === "reverse_prompt") {
    return value;
  }
  return "chooser";
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

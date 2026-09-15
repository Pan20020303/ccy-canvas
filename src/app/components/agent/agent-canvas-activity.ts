import type { Node } from "@xyflow/react";
import { create } from "zustand";

import type { CanvasPatch } from "../../api/agent-run";
import {
  presentCanvasOperation,
  type CanvasOperationEntity,
} from "./canvas-operation-presenter";

export type AgentCanvasActivityPhase = "hidden" | "thinking" | "acting";

export type AgentCanvasActivityState = {
  runId: string | null;
  phase: AgentCanvasActivityPhase;
  entity: CanvasOperationEntity;
  title: string;
  detail: string;
  nodeId?: string;
  startedAt: number;
  finished: boolean;
};

const INITIAL_ACTIVITY: AgentCanvasActivityState = {
  runId: null,
  phase: "hidden",
  entity: "task",
  title: "",
  detail: "",
  startedAt: 0,
  finished: false,
};

export const useAgentCanvasActivityStore = create<AgentCanvasActivityState>(() => INITIAL_ACTIVITY);

let hideTimer: ReturnType<typeof setTimeout> | null = null;

function clearHideTimer() {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = null;
}

function entityForNodeType(type?: string | null): CanvasOperationEntity {
  switch (type) {
    case "textNode":
      return "text";
    case "imageNode":
    case "referenceImageNode":
    case "panoramaNode":
      return "image";
    case "videoNode":
    case "referenceVideoNode":
      return "video";
    case "audioNode":
      return "audio";
    default:
      return "node";
  }
}

function actionTitle(entity: CanvasOperationEntity, zh: boolean): string {
  if (zh) {
    if (entity === "image") return "正在生成图片";
    if (entity === "video") return "正在生成视频";
    if (entity === "text") return "正在生成文本";
    if (entity === "audio") return "正在生成音频";
    if (entity === "connection") return "正在连接节点";
    return "正在操作画布";
  }
  if (entity === "image") return "Generating image";
  if (entity === "video") return "Generating video";
  if (entity === "text") return "Generating text";
  if (entity === "audio") return "Generating audio";
  if (entity === "connection") return "Connecting nodes";
  return "Updating canvas";
}

export function describeAgentCanvasPatch(
  patch: CanvasPatch,
  nodes: Node[],
  zh: boolean,
): Pick<AgentCanvasActivityState, "entity" | "title" | "detail" | "nodeId"> {
  const presentation = presentCanvasOperation(patch, zh);
  const patchNode = patch.op === "add_node" ? patch.node : undefined;
  const targetNodeId = "node_id" in patch ? patch.node_id : presentation.nodeId;
  const targetNode = patchNode ?? nodes.find((node) => node.id === targetNodeId);
  const nodeEntity = entityForNodeType(targetNode?.type);
  const entity = nodeEntity === "node" ? presentation.entity : nodeEntity;

  return {
    entity,
    title: actionTitle(entity, zh),
    detail: presentation.detail,
    nodeId: targetNode?.id ?? targetNodeId,
  };
}

export function beginAgentCanvasThinking(runId: string) {
  clearHideTimer();
  useAgentCanvasActivityStore.setState({
    runId,
    phase: "thinking",
    entity: "task",
    title: "",
    detail: "",
    nodeId: undefined,
    startedAt: Date.now(),
    finished: false,
  });
}

export function markAgentCanvasThinking(runId: string) {
  const current = useAgentCanvasActivityStore.getState();
  if (current.runId !== runId || current.phase === "acting") return;
  useAgentCanvasActivityStore.setState({ phase: "thinking" });
}

export function markAgentCanvasAction(runId: string, patch: CanvasPatch, nodes: Node[], zh: boolean) {
  const current = useAgentCanvasActivityStore.getState();
  if (current.runId !== runId) return;
  clearHideTimer();
  useAgentCanvasActivityStore.setState({
    ...describeAgentCanvasPatch(patch, nodes, zh),
    phase: "acting",
    finished: false,
  });
}

/** Mark the agent stream complete. The overlay waits for a running target node. */
export function finishAgentCanvasActivity(runId: string) {
  const current = useAgentCanvasActivityStore.getState();
  if (current.runId !== runId) return;
  useAgentCanvasActivityStore.setState({ finished: true });
  if (current.phase !== "acting" || !current.nodeId) {
    scheduleAgentCanvasActivityHide(runId, 850);
  } else {
    // Safety valve for a lost node/task status update.
    scheduleAgentCanvasActivityHide(runId, 10 * 60 * 1000);
  }
}

export function scheduleAgentCanvasActivityHide(runId: string, delay = 850) {
  const current = useAgentCanvasActivityStore.getState();
  if (current.runId !== runId) return () => {};
  clearHideTimer();
  hideTimer = setTimeout(() => {
    const latest = useAgentCanvasActivityStore.getState();
    if (latest.runId === runId) useAgentCanvasActivityStore.setState(INITIAL_ACTIVITY);
    hideTimer = null;
  }, delay);
  return () => {
    if (useAgentCanvasActivityStore.getState().runId === runId) clearHideTimer();
  };
}

export function cancelAgentCanvasActivity(runId: string) {
  if (useAgentCanvasActivityStore.getState().runId !== runId) return;
  clearHideTimer();
  useAgentCanvasActivityStore.setState(INITIAL_ACTIVITY);
}

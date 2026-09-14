/**
 * ccy canvas 内核 —— 画布状态的唯一真相与唯一提交路径。
 *
 * CLI（canvas.mjs）与 MCP server（mcp-server.mjs）都只经由这里改动画布，
 * 保证：同一个 revision 序列、同一份 patch 格式、同一套校验。
 *
 * patch 形态与 ccy-canvas 前端的 `advanceCanvasPatchRevision` 完全兼容：
 *   { ...op字段, base_revision, revision }
 *
 * 不依赖任何第三方库。
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const NODE_W = 360;
export const NODE_H = 420;
export const GRID_GAP = 60;
export const COLUMNS = 4;

export const NODE_TYPES = ["text", "image", "video", "audio"];

export function resolveWorkspace(explicit) {
  return resolve(explicit ?? process.env.CCY_WORKSPACE ?? process.cwd());
}

export function canvasPaths(workspace) {
  return {
    workspace,
    canvas: join(workspace, "canvas.json"),
    patches: join(workspace, "patches.jsonl"),
  };
}

export class CanvasError extends Error {}

export function loadCanvas(workspace) {
  const { canvas: canvasFile } = canvasPaths(workspace);
  if (!existsSync(canvasFile)) {
    return { revision: 0, nodes: [], edges: [], groups: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(canvasFile, "utf8"));
  } catch (err) {
    throw new CanvasError(`canvas.json 解析失败: ${err.message}`);
  }
  return {
    revision: Number.isSafeInteger(parsed.revision) ? parsed.revision : 0,
    nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
    edges: Array.isArray(parsed.edges) ? parsed.edges : [],
    groups: Array.isArray(parsed.groups) ? parsed.groups : [],
  };
}

export function nextNodeId(nodes) {
  let max = 0;
  for (const node of nodes) {
    const m = /^n(\d+)$/.exec(String(node.id ?? ""));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `n${max + 1}`;
}

export function nextEdgeId(edges) {
  let max = 0;
  for (const edge of edges) {
    const m = /^e(\d+)$/.exec(String(edge.id ?? ""));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `e${max + 1}`;
}

/** 找一个不与现有节点重叠的落点（网格扫描）。 */
export function placeNode(nodes) {
  const occupied = new Set(
    nodes.map((n) => `${Math.round((n.position?.x ?? 0) / (NODE_W + GRID_GAP))}:${Math.round((n.position?.y ?? 0) / (NODE_H + GRID_GAP))}`),
  );
  for (let index = 0; index < 4000; index++) {
    const col = index % COLUMNS;
    const row = Math.floor(index / COLUMNS);
    if (!occupied.has(`${col}:${row}`)) {
      return { x: col * (NODE_W + GRID_GAP), y: row * (NODE_H + GRID_GAP) };
    }
  }
  const last = nodes[nodes.length - 1];
  return { x: (last?.position?.x ?? 0) + NODE_W + GRID_GAP, y: last?.position?.y ?? 0 };
}

/**
 * 提交一次变更：原子写 canvas.json + 追加一条 patch。
 * 返回被记录的 patch（含 base_revision / revision）。
 */
export function commit(workspace, canvas, patch) {
  const base = canvas.revision;
  const revision = base + 1;
  const recorded = { ...patch, base_revision: base, revision };
  canvas.revision = revision;
  const paths = canvasPaths(workspace);
  mkdirSync(dirname(paths.canvas), { recursive: true });
  const tmp = `${paths.canvas}.tmp`;
  writeFileSync(tmp, JSON.stringify(canvas, null, 2) + "\n", "utf8");
  renameSync(tmp, paths.canvas);
  appendFileSync(paths.patches, JSON.stringify(recorded) + "\n", "utf8");
  return recorded;
}

export function readPatches(workspace, since = 0) {
  const { patches } = canvasPaths(workspace);
  if (!existsSync(patches)) return [];
  return readFileSync(patches, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((p) => p && p.revision > since);
}

export function findNode(canvas, nodeId) {
  return canvas.nodes.find((n) => n.id === nodeId);
}

export function promptOf(node) {
  return String(node?.data?.promptDraft ?? node?.data?.prompt ?? node?.data?.content ?? "");
}

/** 人类/模型都可读的画布全貌（与 CLI overview 输出一致）。 */
export function renderOverview(canvas) {
  const byType = {};
  for (const node of canvas.nodes) byType[node.type] = (byType[node.type] ?? 0) + 1;
  const lines = [
    `revision=${canvas.revision}`,
    `nodes=${canvas.nodes.length} edges=${canvas.edges.length} groups=${canvas.groups.length}`,
  ];
  if (canvas.nodes.length) lines.push(`by_type=${JSON.stringify(byType)}`);
  lines.push("", "nodes:");
  for (const node of canvas.nodes) {
    const prompt = promptOf(node).replace(/\s+/g, " ").slice(0, 60);
    lines.push(`  ${node.id} [${node.type}] ${node.data?.title ?? ""} | ${prompt}`);
  }
  if (canvas.edges.length) {
    lines.push("", "edges:");
    for (const edge of canvas.edges) lines.push(`  ${edge.source} -> ${edge.target}`);
  }
  return lines.join("\n");
}

export function nodeSummary(node, promptLimit = 120) {
  return {
    id: node.id,
    type: node.type,
    title: node.data?.title,
    model: node.data?.model,
    prompt: promptOf(node).replace(/\s+/g, " ").slice(0, promptLimit),
    position: node.position,
  };
}

export function unique(values) {
  return [...new Set(values)];
}

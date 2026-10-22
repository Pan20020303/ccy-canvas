/**
 * ccy canvas 工具集 —— CLI 与 MCP server 共用的一份实现。
 *
 * 每个工具：{ name, description, inputSchema(JSON Schema), run(args, ctx) }
 * run 抛 CanvasError 表示可预期的失败（会原样回给模型）；返回对象会被序列化为 JSON 文本。
 */

import {
  CanvasError,
  NODE_TYPES,
  canvasPaths,
  commit,
  findNode,
  loadCanvas,
  nextEdgeId,
  nextNodeId,
  nodeSummary,
  placeNode,
  promptOf,
  readPatches,
  renderOverview,
} from "./canvas-core.mjs";

const TYPE_LABEL = { text: "文本", image: "图片", video: "视频", audio: "音频" };
const GENERATION_TYPES = ["image", "video", "audio"];

function objectSchema(properties, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

function requireString(args, key, label) {
  const value = args?.[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new CanvasError(`${label ?? key} 不能为空`);
  }
  return value.trim();
}

function optionalString(args, key) {
  const value = args?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireNode(canvas, nodeId) {
  const id = String(nodeId ?? "").trim();
  if (!id) throw new CanvasError("node_id 不能为空");
  const node = findNode(canvas, id);
  if (!node) {
    const known = canvas.nodes.map((n) => n.id).join(", ") || "(画布为空)";
    throw new CanvasError(`节点不存在: ${id}。当前节点: ${known}`);
  }
  return node;
}

function createNode(workspace, canvas, type, args) {
  const id = nextNodeId(canvas.nodes);
  const data = { title: optionalString(args, "title") ?? `${TYPE_LABEL[type]} ${id}` };
  const model = optionalString(args, "model");
  if (type === "text") {
    data.content = requireString(args, "content", "content");
  } else {
    data.promptDraft = requireString(args, "prompt", "prompt");
    if (model) data.model = model;
  }
  const node = { id, type, position: placeNode(canvas.nodes), data };
  canvas.nodes.push(node);
  const patch = commit(workspace, canvas, { op: "add_node", node });
  return { ok: true, node_id: id, revision: patch.revision };
}

export const canvasTools = [
  {
    name: "canvas_overview",
    description:
      "读取整张画布的全貌：revision、节点清单（id/类型/标题/提示词摘要）、连线。任何操作前先调用它。",
    inputSchema: objectSchema({}),
    run(_args, ctx) {
      return { ok: true, overview: renderOverview(ctx.canvas), revision: ctx.canvas.revision };
    },
  },
  {
    name: "list_nodes",
    description: "按类型或关键词筛选节点，返回结构化摘要（不含完整 data，省 token）。",
    inputSchema: objectSchema({
      type: { type: "string", enum: NODE_TYPES, description: "按节点类型筛选" },
      name_contains: { type: "string", description: "标题或提示词包含该关键词" },
    }),
    run(args, ctx) {
      const type = optionalString(args, "type");
      const keyword = optionalString(args, "name_contains");
      const filtered = ctx.canvas.nodes.filter((node) => {
        if (type && node.type !== type) return false;
        if (keyword) {
          const haystack = `${node.data?.title ?? ""}\n${promptOf(node)}`;
          if (!haystack.includes(keyword)) return false;
        }
        return true;
      });
      return { ok: true, count: filtered.length, nodes: filtered.map((n) => nodeSummary(n)) };
    },
  },
  {
    name: "read_node",
    description: "读取单个节点的完整数据（含 data 内全部字段）。",
    inputSchema: objectSchema({ node_id: { type: "string" } }, ["node_id"]),
    run(args, ctx) {
      return { ok: true, node: requireNode(ctx.canvas, args?.node_id) };
    },
  },
  {
    name: "create_text_node",
    description:
      "创建一个文本节点。用于写分镜、文案、提示词草稿等。返回新节点 id，后续可用它连线或引用。",
    inputSchema: objectSchema(
      { content: { type: "string", description: "文本正文（必填）" }, title: { type: "string" } },
      ["content"],
    ),
    run(args, ctx) {
      return createNode(ctx.workspace, ctx.canvas, "text", args);
    },
  },
  {
    name: "create_image_node",
    description:
      "创建一个图片生成节点。只建节点并写好提示词，不会真的出图 —— 出图需要另外调用 run_node。",
    inputSchema: objectSchema(
      {
        prompt: { type: "string", description: "生图提示词（必填）" },
        model: { type: "string", description: "生图模型名，省略则用画布默认" },
        title: { type: "string" },
      },
      ["prompt"],
    ),
    run(args, ctx) {
      return createNode(ctx.workspace, ctx.canvas, "image", args);
    },
  },
  {
    name: "create_video_node",
    description: "创建一个视频生成节点（只建节点，不出视频）。首尾帧/参考图通过连线提供。",
    inputSchema: objectSchema(
      {
        prompt: { type: "string", description: "视频提示词（必填）" },
        model: { type: "string" },
        title: { type: "string" },
      },
      ["prompt"],
    ),
    run(args, ctx) {
      return createNode(ctx.workspace, ctx.canvas, "video", args);
    },
  },
  {
    name: "create_audio_node",
    description: "创建一个音频/配音节点（只建节点，不出音频）。",
    inputSchema: objectSchema(
      { prompt: { type: "string", description: "音频/配音提示词（必填）" }, model: { type: "string" }, title: { type: "string" } },
      ["prompt"],
    ),
    run(args, ctx) {
      return createNode(ctx.workspace, ctx.canvas, "audio", args);
    },
  },
  {
    name: "set_prompt",
    description: "改写已有节点的提示词（生成类节点写 promptDraft，文本节点写 content）。",
    inputSchema: objectSchema(
      {
        node_id: { type: "string" },
        prompt: { type: "string", description: "新的提示词/文本（必填）" },
        model: { type: "string", description: "可选，一并更换模型" },
      },
      ["node_id", "prompt"],
    ),
    run(args, ctx) {
      const node = requireNode(ctx.canvas, args?.node_id);
      const prompt = requireString(args, "prompt", "prompt");
      const patchData = node.type === "text" ? { content: prompt } : { promptDraft: prompt };
      const model = optionalString(args, "model");
      if (model) patchData.model = model;
      node.data = { ...node.data, ...patchData };
      const patch = commit(ctx.workspace, ctx.canvas, {
        op: "patch_node_data",
        node_id: node.id,
        patch: patchData,
      });
      return { ok: true, node_id: node.id, revision: patch.revision };
    },
  },
  {
    name: "connect_nodes",
    description:
      "连线：下游节点生成时会带上游节点的产物作为参考。方向必须是 源(参考方) → 目标(生成方)。重复连线会报错。",
    inputSchema: objectSchema({ source: { type: "string" }, target: { type: "string" } }, ["source", "target"]),
    run(args, ctx) {
      const source = requireNode(ctx.canvas, args?.source).id;
      const target = requireNode(ctx.canvas, args?.target).id;
      if (source === target) throw new CanvasError("不能把节点连到自己");
      if (ctx.canvas.edges.some((e) => e.source === source && e.target === target)) {
        throw new CanvasError(`连线已存在: ${source} -> ${target}`);
      }
      const edge = { id: nextEdgeId(ctx.canvas.edges), source, target };
      ctx.canvas.edges.push(edge);
      const patch = commit(ctx.workspace, ctx.canvas, { op: "add_edge", edge });
      return { ok: true, edge_id: edge.id, source, target, revision: patch.revision };
    },
  },
  {
    name: "run_node",
    description:
      "触发某个生成节点出图/出视频/出音频（会消耗积分）。只是入队，异步完成；不要声称已经生成完成。",
    inputSchema: objectSchema(
      {
        node_id: { type: "string" },
        prompt: { type: "string", description: "可选，同时更新提示词" },
        model: { type: "string", description: "可选，同时指定模型" },
      },
      ["node_id"],
    ),
    run(args, ctx) {
      const node = requireNode(ctx.canvas, args?.node_id);
      if (!GENERATION_TYPES.includes(node.type)) {
        throw new CanvasError(`节点 ${node.id} 是 ${node.type} 类型，不能触发生成（仅 image/video/audio）`);
      }
      const payload = { node_id: node.id };
      const prompt = optionalString(args, "prompt");
      const model = optionalString(args, "model");
      if (prompt) {
        payload.prompt = prompt;
        node.data = { ...node.data, promptDraft: prompt };
      }
      if (model) {
        payload.model = model;
        node.data = { ...node.data, model };
      }
      const patch = commit(ctx.workspace, ctx.canvas, { op: "run_node", ...payload });
      return { ok: true, node_id: node.id, status: "queued", note: "已入队生成，结果由画布异步写回", revision: patch.revision };
    },
  },
  {
    name: "move_node",
    description: "移动节点到指定坐标。除非用户明确要求布局，不要手工排版。",
    inputSchema: objectSchema(
      {
        node_id: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
      },
      ["node_id", "x", "y"],
    ),
    run(args, ctx) {
      const node = requireNode(ctx.canvas, args?.node_id);
      const x = Number(args?.x);
      const y = Number(args?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new CanvasError("x / y 必须是数字");
      const position = { x, y };
      node.position = position;
      const patch = commit(ctx.workspace, ctx.canvas, { op: "move_node", node_id: node.id, position });
      return { ok: true, node_id: node.id, revision: patch.revision };
    },
  },
  {
    name: "delete_node",
    description: "删除节点（连带它的所有连线）。删除前请确认用户确实要求删除。",
    inputSchema: objectSchema({ node_id: { type: "string" } }, ["node_id"]),
    run(args, ctx) {
      const node = requireNode(ctx.canvas, args?.node_id);
      ctx.canvas.nodes = ctx.canvas.nodes.filter((n) => n.id !== node.id);
      ctx.canvas.edges = ctx.canvas.edges.filter((e) => e.source !== node.id && e.target !== node.id);
      const patch = commit(ctx.workspace, ctx.canvas, { op: "delete_node", node_id: node.id });
      return { ok: true, node_id: node.id, revision: patch.revision };
    },
  },
  {
    name: "create_group",
    description: "把若干节点编成一组（视觉分组，方便管理一批分镜/镜头）。",
    inputSchema: objectSchema(
      {
        node_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 50 },
        name: { type: "string" },
      },
      ["node_ids"],
    ),
    run(args, ctx) {
      const ids = Array.isArray(args?.node_ids) ? args.node_ids.map((id) => String(id).trim()).filter(Boolean) : [];
      if (!ids.length) throw new CanvasError("node_ids 不能为空");
      for (const id of ids) requireNode(ctx.canvas, id);
      const name = optionalString(args, "name") ?? "分组";
      const group = { id: `g${ctx.canvas.groups.length + 1}`, name, node_ids: ids };
      ctx.canvas.groups.push(group);
      const patch = commit(ctx.workspace, ctx.canvas, { op: "create_group", node_ids: ids, name });
      return { ok: true, group_id: group.id, revision: patch.revision };
    },
  },
  {
    name: "get_canvas_delta",
    description: "读取自某个 revision 之后发生的全部变更（patch 列表），用于确认自己刚才改了什么。",
    inputSchema: objectSchema({ since_revision: { type: "integer", minimum: 0, default: 0 } }),
    run(args, ctx) {
      const since = Number.isSafeInteger(args?.since_revision) ? args.since_revision : 0;
      const patches = readPatches(ctx.workspace, since);
      return { ok: true, current_revision: ctx.canvas.revision, count: patches.length, patches };
    },
  },
];

export function toolByName(name) {
  return canvasTools.find((tool) => tool.name === name);
}

/** 供 DSH 工作区指令引用：CLI 子命令 ↔ MCP 工具名对照。 */
export function toolInventory() {
  return canvasTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    schema: tool.inputSchema,
  }));
}

export function workspaceMeta(workspace) {
  return canvasPaths(workspace);
}

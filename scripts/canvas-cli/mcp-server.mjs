#!/usr/bin/env node
/**
 * ccy canvas MCP server —— 把画布工具以 MCP（Model Context Protocol）暴露给 DeepSeek Harness。
 *
 * 协议：stdio 上换行分隔的 JSON-RPC 2.0（MCP 规范，协议版本 2025-11-25）。
 * stdout 只承载协议帧；所有日志走 stderr（否则会污染信道）。
 *
 * 与 CLI 的关系：同一份 canvas-core / canvas-tools —— 同一个 revision 序列、同一份 patch 流。
 *
 * 在 DSH profile 里挂载（~/.dsh/profiles/<profile>/cordis.patch.yml）：
 *
 *   - id: mcp
 *     name: '@deepseek-ai/dsh-mcp-client'
 *     config:
 *       servers:
 *         - serverName: ccy
 *           transport: stdio
 *           command: node
 *           args: ['<绝对路径>/mcp-server.mjs']
 *           cwd: '<画布工作区>'
 *           failOnStartupError: true
 *
 * 模型看到的工具名是 `mcp__ccy__<name>`，例如 `mcp__ccy__create_image_node`。
 */

import { createServer } from "node:http";
import { CanvasError, loadCanvas, readPatches, resolveWorkspace } from "./canvas-core.mjs";
import { canvasTools, toolByName } from "./canvas-tools.mjs";

const PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
const SERVER_INFO = { name: "ccy-canvas", version: "0.1.0" };

const WORKSPACE = resolveWorkspace(process.env.CCY_WORKSPACE);
const STATE_PORT = Number(process.env.CCY_MCP_STATE_PORT ?? 0);
const STATE_TOKEN = process.env.CCY_MCP_STATE_TOKEN ?? "";

function log(...parts) {
  process.stderr.write("[canvas-mcp] " + parts.join(" ") + "\n");
}

// ── stdio JSON-RPC ────────────────────────────────────────────────────────────

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
  send({ jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } });
}

function toolResult(payload, isError = false) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

function handleToolCall(params) {
  const name = params?.name;
  const tool = toolByName(String(name ?? ""));
  if (!tool) {
    return sendErrorForTool(`未知工具: ${name}。可用工具: ${canvasTools.map((t) => t.name).join(", ")}`);
  }
  const args = params?.arguments && typeof params.arguments === "object" ? params.arguments : {};
  try {
    // 每次调用都重新读盘：画布可能被 CLI、浏览器或上一次工具调用改动过，
    // 不做进程内缓存是保证 revision 单调且无分支的最简单办法。
    const canvas = loadCanvas(WORKSPACE);
    const result = tool.run(args, { workspace: WORKSPACE, canvas });
    return toolResult({ ok: true, ...result });
  } catch (err) {
    if (err instanceof CanvasError) return sendErrorForTool(err.message);
    log("tool threw", name, err?.stack ?? String(err));
    return sendErrorForTool(`工具执行失败: ${err?.message ?? String(err)}`);
  }
}

function sendErrorForTool(message) {
  return toolResult({ ok: false, error: message });
}

function handleMessage(message) {
  // 通知（无 id）：不需要回复。
  if (message?.method && message?.id === undefined) {
    return;
  }
  const { id, method, params } = message ?? {};
  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      const version = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION;
      sendResult(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "这是 ccy-canvas 画布工具服务。所有画布修改都必须通过这些工具完成；" +
          "动手前先调 canvas_overview 读取当前画布，改完用 get_canvas_delta 复核。" +
          "画布只认工具返回的 ok:true —— 没成功就不要声称已经改了画布。",
      });
      log(`initialized (client protocol ${requested ?? "?"} → ${version}), workspace=${WORKSPACE}`);
      return;
    }
    case "ping":
      sendResult(id, {});
      return;
    case "tools/list":
      sendResult(id, {
        tools: canvasTools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      });
      return;
    case "tools/call":
      sendResult(id, handleToolCall(params));
      return;
    case "resources/list":
      sendResult(id, { resources: [] });
      return;
    case "prompts/list":
      sendResult(id, { prompts: [] });
      return;
    default:
      sendError(id, -32601, `未实现的方法: ${method}`);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      log("忽略无法解析的帧:", line.slice(0, 200));
      continue;
    }
    try {
      handleMessage(message);
    } catch (err) {
      log("帧处理异常:", err?.stack ?? String(err));
      if (message?.id !== undefined) sendError(message.id, -32603, "internal error");
    }
  }
});

process.stdin.on("end", () => {
  log("stdin 关闭，退出");
  process.exit(0);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    log(`收到 ${signal}，退出`);
    process.exit(0);
  });
}

// ── 可选的状态桥（给 Vite dev 插件用，让浏览器真的看到画布变化）─────────────
//
// 只在 CCY_MCP_STATE_PORT 被设置时启动。提供三个端点：
//   GET  /state   → { revision, pending: [patch...] }  （自浏览器上报的 revision 之后的变更）
//   POST /ack     → { revision }  浏览器确认已应用到某 revision
//   GET  /health  → 存活探测

if (STATE_PORT > 0) {
  let browserRevision = 0;
  let lastPatches = [];

  function refreshPatches() {
    try {
      lastPatches = readPatches(WORKSPACE, browserRevision);
    } catch (err) {
      log("读取 patch 失败:", err?.message ?? String(err));
    }
  }

  const stateServer = createServer((req, res) => {
    const authorized = !STATE_TOKEN || req.headers["x-ccy-token"] === STATE_TOKEN;
    if (!authorized) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "forbidden" }));
      return;
    }
    const url = req.url ?? "/";
    if (req.method === "GET" && url.startsWith("/state")) {
      refreshPatches();
      let revision = 0;
      try {
        revision = loadCanvas(WORKSPACE).revision;
      } catch { /* 画布尚未建立 */ }
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify({ revision, browser_revision: browserRevision, pending: lastPatches }));
      return;
    }
    if (req.method === "POST" && url.startsWith("/ack")) {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 4096) req.destroy();
      });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body || "{}");
          if (Number.isSafeInteger(parsed.revision) && parsed.revision >= browserRevision) {
            browserRevision = parsed.revision;
          }
        } catch { /* 忽略格式错误 */ }
        res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
        res.end(JSON.stringify({ ok: true, browser_revision: browserRevision }));
      });
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type,x-ccy-token",
      });
      res.end();
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  stateServer.listen(STATE_PORT, "127.0.0.1", () => {
    log(`状态桥监听 http://127.0.0.1:${STATE_PORT} （workspace=${WORKSPACE}）`);
    // 画布文件存在性先探一次，方便排查 cwd 传错的情况。
    try {
      const probe = loadCanvas(WORKSPACE);
      log(`画布读取正常: revision=${probe.revision} nodes=${probe.nodes.length}`);
    } catch (err) {
      log("画布读取失败:", err?.message ?? String(err));
    }
  });
}

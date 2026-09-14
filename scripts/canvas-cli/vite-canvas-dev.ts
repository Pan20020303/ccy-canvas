/**
 * 画布 dev 桥接（仅 dev 用）—— 把磁盘上的画布变更回灌进浏览器画布。
 *
 * 链路：
 *   dsh(MCP) / canvas.mjs  →  canvas.json + patches.jsonl
 *        ↑                              │
 *        │ ack(revision)                │ pending patches
 *        └──── Vite dev middleware ◄────┘
 *                    ▲
 *                    │ GET /state 轮询
 *              浏览器画布（store）
 *
 * 约束：patch 是"无版本"形态时 base_revision 必须与浏览器当前 revision 相等，
 * 因此浏览器在每次拉到数据后立即 ack 自己的 revision；一旦不一致就停摆并要求
 * 重新 seed（避免静默地把画布改错）。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ViteDevServer } from "vite";

/** 固定端口：浏览器端不需要感知端口，由 Vite middleware 反代。 */
export const CANVAS_DEV_STATE_PORT = 39217;

export const CANVAS_DEV_ROUTES = {
  state: "/__canvas-cli/state",
  ack: "/__canvas-cli/ack",
  seed: "/__canvas-cli/seed",
  health: "/__canvas-cli/health",
};

function readJsonBody(req: any, limitBytes = 4 * 1024 * 1024): Promise<any> {
  return new Promise((resolvePromise, rejectPromise) => {
    let body = "";
    req.on("data", (chunk: Buffer | string) => {
      body += chunk;
      if (body.length > limitBytes) {
        rejectPromise(new Error("请求体过大"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolvePromise(body ? JSON.parse(body) : {});
      } catch (err) {
        rejectPromise(new Error(`请求体不是合法 JSON: ${(err as Error).message}`));
      }
    });
    req.on("error", rejectPromise);
  });
}

function sendJson(res: any, status: number, payload: unknown) {
  const text = JSON.stringify(payload);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(text);
}

export type CanvasDevBridgeOptions = {
  viteserver: ViteDevServer;
  /** 智能体操作画布的工作区目录（绝对路径）。 */
  workspace: string;
  /** canvas MCP server 脚本（绝对路径）。 */
  serverScript: string;
  log?: (...parts: unknown[]) => void;
};

/**
 * 启动画布 dev 桥接。
 */
export function createCanvasDevBridge({ viteserver, workspace, serverScript, log = () => {} }: CanvasDevBridgeOptions) {
  const stateBase = `http://127.0.0.1:${CANVAS_DEV_STATE_PORT}`;
  const canvasFile = join(workspace, "canvas.json");
  let child: ChildProcess | null = null;

  function startServer() {
    if (child) return;
    mkdirSync(workspace, { recursive: true });
    // 画布文件不在就建一个空的：MCP server 的工作区必须是它自己的目录。
    try {
      writeFileSync(canvasFile, JSON.stringify({ revision: 0, nodes: [], edges: [], groups: [] }, null, 2) + "\n", {
        encoding: "utf8",
        flag: "wx",
      });
    } catch {
      // 已存在即可
    }
    child = spawn(process.execPath, [serverScript], {
      cwd: workspace,
      env: {
        ...process.env,
        CCY_WORKSPACE: workspace,
        CCY_MCP_STATE_PORT: String(CANVAS_DEV_STATE_PORT),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    // stdio 已显式声明为 pipe，三个流必然存在；这里只是让类型收窄。
    const spawned = child;
    spawned.stdout?.setEncoding("utf8");
    spawned.stdout?.on("data", (chunk: string) => log("[canvas-mcp:stdout]", chunk.trim()));
    spawned.stderr?.setEncoding("utf8");
    spawned.stderr?.on("data", (chunk: string) => log("[canvas-mcp]", chunk.trim()));
    spawned.on("exit", (code) => {
      log(`[canvas-mcp] 退出 code=${code}`);
      child = null;
    });
  }

  function stopServer() {
    const running = child;
    if (!running) return;
    try {
      running.stdin?.end();
      running.kill();
    } catch {
      // 忽略
    }
    child = null;
  }

  /** 以 middleware 形式挂载：不依赖 Vite 代理，浏览器同源访问。 */
  function middleware() {
    return async (req: any, res: any, next: () => void) => {
      const url = req.url ?? "";
      if (!Object.values(CANVAS_DEV_ROUTES).some((route) => url.startsWith(route))) {
        next();
        return;
      }
      try {
        if (url.startsWith(CANVAS_DEV_ROUTES.health)) {
          sendJson(res, 200, { ok: true, workspace, running: Boolean(child) });
          return;
        }
        if (url.startsWith(CANVAS_DEV_ROUTES.seed)) {
          const body = await readJsonBody(req);
          const canvas = {
            revision: Number.isSafeInteger(body.revision) ? body.revision : 0,
            nodes: Array.isArray(body.nodes) ? body.nodes : [],
            edges: Array.isArray(body.edges) ? body.edges : [],
            groups: Array.isArray(body.groups) ? body.groups : [],
          };
          writeFileSync(canvasFile, JSON.stringify(canvas, null, 2) + "\n", "utf8");
          // seed 之后磁盘 revision 与浏览器一致，清掉 patches 以免重复回放。
          writeFileSync(join(workspace, "patches.jsonl"), "", "utf8");
          log(`[canvas-bridge] 已用浏览器画布 seed（revision=${canvas.revision}, nodes=${canvas.nodes.length}）`);
          sendJson(res, 200, { ok: true, revision: canvas.revision, nodes: canvas.nodes.length });
          return;
        }
        // state / ack 转发给 MCP server 内置的状态桥
        const target = url.startsWith(CANVAS_DEV_ROUTES.ack) ? `${stateBase}/ack` : `${stateBase}/state`;
        const init: RequestInit = { method: req.method };
        if (req.method === "POST") {
          const body = await readJsonBody(req);
          init.headers = { "content-type": "application/json" };
          init.body = JSON.stringify(body);
        }
        const upstream = await fetch(target, init);
        const text = await upstream.text();
        res.statusCode = upstream.status;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.setHeader("cache-control", "no-store");
        res.end(text);
      } catch (err) {
        sendJson(res, 503, { ok: false, error: String((err as Error)?.message ?? err) });
      }
    };
  }

  return {
    startServer,
    stopServer,
    middleware,
    routes: CANVAS_DEV_ROUTES,
    workspace,
  };
}

/**
 * Vite 插件：在 dev 下自动拉起 canvas MCP server（带状态桥）并挂载 middleware。
 *
 * 启用方式（vite.config.ts）：
 *   import { canvasDevBridge } from "./scripts/canvas-cli/vite-canvas-dev";
 *   plugins: [react(), canvasDevBridge({ workspace: ".canvas-agent-workspace" })]
 */
export function canvasDevBridge(
  options: { workspace?: string; serverScript?: string } = {},
): { name: string; apply: "serve"; configureServer: (server: ViteDevServer) => void } {
  const workspace = resolve(options.workspace ?? ".canvas-agent-workspace");
  const serverScript = resolve(options.serverScript ?? "scripts/canvas-cli/mcp-server.mjs");

  return {
    name: "ccy-canvas-dev-bridge",
    apply: "serve",
    configureServer(viteserver: ViteDevServer) {
      const bridge = createCanvasDevBridge({
        viteserver,
        workspace,
        serverScript,
        log: (...parts: unknown[]) => viteserver.config.logger.info(parts.join(" ")),
      });
      bridge.startServer();
      // 注意顺序：必须 use 在 Vite 自身代理之前，否则 /__canvas-cli/* 会被 /api 规则吞掉。
      viteserver.middlewares.use(bridge.middleware() as never);
      viteserver.httpServer?.on("close", () => bridge.stopServer());
      viteserver.config.logger.info(`[canvas-bridge] 画布工作区: ${workspace}`);
    },
  };
}

#!/usr/bin/env node
/**
 * ccy agent bridge —— 用 DeepSeek Harness 替换自研 Go runner 的 Node 侧服务。
 *
 * 定位（与 Go 侧的分工）：
 *   Go (ccy-canvas-api) 仍然负责鉴权、积分、会话持久化、画布权威状态；
 *   bridge 只负责"跑 DSH + 把 DSH 事件翻译成前端契约"，通过 HTTP/SSE 暴露。
 *
 * 端点（刻意与 Go 侧现行契约同形，前端可以整体切过去而不改一行）：
 *   GET  /health                                 存活 + runtime 池状态
 *   POST /api/app/agents/:agentId/jobs           建任务 → { job_id, conversation_id }
 *   GET  /api/app/agent-jobs/:jobId              任务状态
 *   GET  /api/app/agent-jobs/:jobId/events?after=N   SSE 事件流（可续传）
 *   POST /api/app/agent-jobs/:jobId/cancel       软取消
 *
 * SSE 帧格式与 Go 侧 agent_job_handler.go 完全一致：
 *   id: N\nevent: NAME\ndata: JSON\n\n
 *
 * 用法：
 *   node server.mjs --port 39300 --workspace <画布工作区> [--profile ccy]
 */

import { createServer } from "node:http";
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

import { AgentRuntimePool } from "./lib/runtime-pool.mjs";
import { JobRegistry } from "./lib/job-registry.mjs";
import { JobStore } from "./lib/job-store.mjs";
import { createSessionEventTranslator, TRANSLATOR_SOURCE } from "./lib/event-translator.mjs";
import { writeSkills } from "./lib/skills-export.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// ── 配置 ─────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        options[key] = true;
      } else {
        options[key] = next;
        index += 1;
      }
    } else {
      options._.push(token);
    }
  }
  return options;
}

const args = parseArgs(process.argv.slice(2));

/** 工作区根：每个会话在它下面拿一个独立子目录。 */
const WORKSPACE_ROOT = resolve(
  String(args.workspace ?? process.env.CCY_WORKSPACE ?? join(process.cwd(), ".canvas-agent-workspace")),
);

const CONFIG = {
  port: Number(args.port ?? process.env.CCY_BRIDGE_PORT ?? 39300),
  host: String(args.host ?? process.env.CCY_BRIDGE_HOST ?? "127.0.0.1"),
  profile: String(args.profile ?? process.env.CCY_DSH_PROFILE ?? "ccy"),
  dshBin: resolve(
    String(
      args.dsh ??
        process.env.CCY_DSH_BIN ??
        "C:\\Users\\Administrator\\AppData\\Local\\npm-cache\\_npx\\1e7f6d9597241db0\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js",
    ),
  ),
  workspace: WORKSPACE_ROOT,
  /** 画布工具脚本目录（每个会话工作区都从这里铺一份）。 */
  canvasCliDir: resolve(String(args["canvas-cli"] ?? process.env.CCY_CANVAS_CLI ?? join(HERE, "..", "canvas-cli"))),
  dshHome: args["dsh-home"] ?? process.env.DSH_HOME,
  /** 画布 MCP 工具的挂载补丁（默认用仓库里的 ccy-mcp.patch.yml）。 */
  patchFile: resolve(
    String(args.patch ?? process.env.CCY_DSH_PATCH ?? join(HERE, "..", "canvas-cli", "ccy-mcp.patch.yml")),
  ),
  provider: String(args.provider ?? process.env.CCY_DSH_PROVIDER ?? "deepseek-official"),
  model: String(args.model ?? process.env.CCY_DSH_MODEL ?? "deepseek-flash"),
  reasoningEffort: args.effort ?? process.env.CCY_DSH_EFFORT,
  /** paced=off 时增量一次性给出（便于压测/排障）。 */
  paced: String(args.paced ?? process.env.CCY_BRIDGE_PACED ?? "on").toLowerCase() !== "off",
  /** 画布 patch 回传：从工作区的 patches.jsonl 读增量，翻成 canvas_patch 事件。 */
  canvasSync: String(args["canvas-sync"] ?? process.env.CCY_BRIDGE_CANVAS_SYNC ?? "on").toLowerCase() !== "off",
  idleMs: Number(args["idle-ms"] ?? process.env.CCY_BRIDGE_IDLE_MS ?? 15 * 60 * 1000),
  maxRuntimes: Number(args["max-runtimes"] ?? process.env.CCY_BRIDGE_MAX_RUNTIMES ?? 8),
  /**
   * job 事件日志落库路径。默认放在工作区根下的 state/jobs.db（用 node:sqlite，
   * 无第三方依赖）。传 `--persist off` 或 CCY_BRIDGE_PERSIST=off 可关闭
   * （关闭后行为回到纯内存，进程重启丢历史）。
   */
  persist:
    String(args.persist ?? process.env.CCY_BRIDGE_PERSIST ?? "on").toLowerCase() === "off"
      ? null
      : resolve(
          String(
            args["persist-dir"] ??
              process.env.CCY_BRIDGE_PERSIST_DIR ??
              join(WORKSPACE_ROOT, "state", "jobs.db"),
          ),
        ),
  /** 历史保留：默认 7 天、最多 2000 个 job。 */
  retentionMs: Number(args["retention-ms"] ?? process.env.CCY_BRIDGE_RETENTION_MS ?? 7 * 24 * 60 * 60 * 1000),
  maxStoredJobs: Number(args["max-stored-jobs"] ?? process.env.CCY_BRIDGE_MAX_STORED_JOBS ?? 2000),
};

function log(...parts) {
  process.stdout.write(`[agent-bridge] ${parts.join(" ")}\n`);
}

mkdirSync(CONFIG.workspace, { recursive: true });

const pool = new AgentRuntimePool({
  dshBin: CONFIG.dshBin,
  profile: CONFIG.profile,
  workspaceRoot: CONFIG.workspace,
  canvasCliDir: CONFIG.canvasCliDir,
  provider: CONFIG.provider,
  model: CONFIG.model,
  reasoningEffort: CONFIG.reasoningEffort,
  dshHome: CONFIG.dshHome,
  patchFile: CONFIG.patchFile,
  idleMs: CONFIG.idleMs,
  maxRuntimes: CONFIG.maxRuntimes,
  log,
});
// job 事件日志落库（node:sqlite）。恢复必须在开始接受新任务之前完成：
// 残留的 running 会被标成 interrupted，避免前端看到一个永远不动的"运行中"。
const jobStore = CONFIG.persist
  ? new JobStore({
      path: CONFIG.persist,
      retentionMs: CONFIG.retentionMs,
      maxJobs: CONFIG.maxStoredJobs,
      log,
    })
  : null;
const jobs = new JobRegistry({ log, store: jobStore });

// 从 DSH 已落盘的会话推导"哪些 sessionId 用过"。
// 必须在接受任务之前：否则桥重启后第一轮会拿裸 conversation_id 去撞磁盘上
// 那个旧会话，DSH 直接抛 `session "…" already exists`，整个任务失败。
try {
  const dshHome = CONFIG.dshHome ?? process.env.DSH_HOME ?? join(homedir(), ".dsh");
  pool.seedFromPersistedSessions(dshHome);
} catch (err) {
  log(`[pool] 会话名推导失败（继续，但重启后的首轮可能撞名）：${err?.message ?? err}`);
}
if (jobStore) {
  const restored = jobs.restore();
  log(`[store] 落库位置 ${CONFIG.persist}（已恢复 ${restored} 个 job）`);
} else {
  log("[store] 落库已关闭（--persist off）：进程重启将丢失 job 历史");
}

// ── 画布 patch 回传 ──────────────────────────────────────────────────────────

// 画布 patch 回传：每个会话有自己的工作区（pool.workspaceOf），
// 所以路径必须按会话解析，不能用一个模块级常量。

function canvasPathsFor(workspace) {
  return { canvas: join(workspace, "canvas.json"), patches: join(workspace, "patches.jsonl") };
}

function readCanvasRevision(workspace) {
  const { canvas } = canvasPathsFor(workspace);
  try {
    if (!existsSync(canvas)) return 0;
    const parsed = JSON.parse(readFileSync(canvas, "utf8"));
    return Number.isSafeInteger(parsed?.revision) ? parsed.revision : 0;
  } catch {
    return 0;
  }
}

/** 读取 revision > since 的 patch，用于把画布写入翻成 canvas_patch 事件。 */
function readCanvasPatches(workspace, since) {
  const { patches } = canvasPathsFor(workspace);
  if (!CONFIG.canvasSync || !existsSync(patches)) return [];
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
    .filter((patch) => patch && Number.isSafeInteger(patch.revision) && patch.revision > since)
    .sort((a, b) => a.revision - b.revision);
}

// ── 检视页资源 ──────────────────────────────────────────────────────────────

/** 读检视页静态文件（public/ 下）。 */
function readInspectorFile(name) {
  const file = join(HERE, "public", name);
  try {
    return readFileSync(file, "utf8");
  } catch {
    log(`[inspector] 读取 ${file} 失败`);
    return null;
  }
}

let timelineBundleCache = null;

/**
 * 把 src/app/agent-timeline.ts 打成浏览器可用的 IIFE。
 *
 * 为什么现打而不是预编译：时间线呈现逻辑与 React 面板共用同一份 TS 源码，
 * 预编译产物会多一个漂移点。esbuild 随 vite 一起装着，所以不需要新依赖。
 * 用系统临时目录，避免往仓库里写构建产物。
 */
function timelineBundle() {
  if (timelineBundleCache) return timelineBundleCache;
  const entry = join(HERE, "inspector-entry.js");
  if (!existsSync(entry)) {
    return { ok: false, error: `缺少 ${entry}` };
  }
  const esbuild = join(HERE, "..", "..", "node_modules", "esbuild", "bin", "esbuild");
  if (!existsSync(esbuild)) {
    return { ok: false, error: "找不到 esbuild（随 vite 安装）" };
  }
  try {
    const code = execFileSync(
      process.execPath,
      [esbuild, entry, "--bundle", "--format=iife", "--platform=browser", "--target=es2022", "--log-level=error"],
      { encoding: "utf8", cwd: join(HERE, "..", ".."), maxBuffer: 32 * 1024 * 1024 },
    );
    timelineBundleCache = { ok: true, code };
    return timelineBundleCache;
  } catch (err) {
    const detail = `${err?.stderr ?? ""}${err?.message ?? ""}`.trim().slice(0, 800);
    log(`[inspector] 时间线 bundle 构建失败: ${detail}`);
    return { ok: false, error: detail };
  }
}

// ── SSE ─────────────────────────────────────────────────────────────────────

function sseWrite(res, event) {
  // 与 Go 侧 Emitter / agent_job_handler 的帧格式保持一致。
  res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

// ── 跑一个 job ──────────────────────────────────────────────────────────────

const runningJobs = new Map();

async function runJob(job) {
  // 技能导出：必须在 acquire（首次会拉起 runtime）之前写入会话工作区的
  // <workspace>/.dsh/skills，才能让 DSH 的首次扫描就看到它们。
  // 每次 run 都重写：skills 表会被运营/用户改，绑定也随智能体变。
  try {
    const workspace = pool.workspaceOf(job.conversationId);
    const skills = Array.isArray(job.request?.skills) ? job.request.skills : [];
    const result = writeSkills(workspace, skills);
    if (result.written || result.removed) {
      log(`[job ${job.id}] 技能导出：写入 ${result.written} 个、清理 ${result.removed} 个（${result.names.join(", ") || "无"}）`);
    }
  } catch (err) {
    // 技能导出失败不应让整轮任务失败：画布工具仍然可用。
    log(`[job ${job.id}] 技能导出失败（继续执行）：${err?.message ?? err}`);
  }

  const runtime = await pool.acquire(job.conversationId, job.sessionId);
  jobs.markRunning(job);

  // DSH 侧的会话名。定义在 acquire 之前就必须存在（翻译器与 SSE 过滤都按它比对），
  // 所以这里带回退：万一 job.sessionId 没被预占（例如从落库恢复的 job），
  // 补一次 reserveGeneration —— 缺失会导致整个 runJob 抛 "sessionId is not defined"，
  // 而外层兜底会把它变成一句泛化文案，极难排查（实测踩过）。
  const sessionId = job.sessionId ?? pool.reserveGeneration(job.conversationId);
  job.sessionId = sessionId;

  const translator = createSessionEventTranslator(sessionId, { paced: CONFIG.paced });
  const workspace = pool.workspaceOf(job.conversationId);

  // 画布 patch 游标：一轮开始时的 revision 作为基线，之后收尾时扫增量。
  let canvasRevision = readCanvasRevision(workspace);
  const baselineRevision = canvasRevision;

  let finalReply = "";
  let steps = 0;
  let settled = false;
  /** done 事件先暂存，等画布 patch 补发完再落库 —— done 必须是最后一条。 */
  let pendingDone = null;
  let resolveSettled;
  const settledPromise = new Promise((resolvePromise) => {
    resolveSettled = resolvePromise;
  });

  /** 事件处理串行队列：保证 message/done 的处理顺序严格跟随事件到达顺序。 */
  let processing = Promise.resolve();
  const enqueue = (task) => {
    processing = processing.then(task).catch((err) => {
      log(`[job ${job.id}] 事件处理异常: ${err?.stack ?? err}`);
    });
    return processing;
  };

  const onSessionEvent = (params) => {
    if (job.cancelled) return;
    const translated = translator.translate(params);
    if (!translated.length) return;
    // 关键：不能用 void 并发处理。原先的并发写法会让 session.status=idle 的兜底
    // 抢在最后一条 assistant/message 之前完成收尾，导致 finalReply 停留在中间步骤
    // （实测把"Now connect text(n2) → image(n1)."当成了最终回复）。
    enqueue(async () => {
      for (const item of translated) {
        if (job.cancelled) return;
        // paced 模式按原始节奏重放；单条封顶 250ms，避免长思考把流拖住。
        if (item.delayMs) await sleep(Math.min(item.delayMs, 250));
        if (item.kind === "message") {
          finalReply = String(item.data?.content ?? finalReply);
        }
        if (item.kind === "done") {
          steps = Number(item.data?.steps ?? steps);
          // 不能立刻落库：本轮还有 canvas_patch 要在收尾时补发，
          // 而客户端一收到 done 就会停止处理后续事件（实测会静默丢掉画布变更）。
          pendingDone = item.data;
        } else {
          jobs.append(job, item.kind, item.data);
        }
        // done 的"结束"语义也在队列内生效：确保此刻所有更早的事件都已落库，
        // finalReply 才是真正的最终回复。
        if (item.kind === "done" && !settled) {
          settled = true;
          resolveSettled();
        }
      }
    });
  };

  const onSessionStatus = (params) => {
    if (String(params?.sessionId) !== sessionId) return;
    if (params.status === "idle") {
      // 兜底：turn/end 没到也要让前端离开"思考中"。同样排进队列，
      // 保证排在它之前的事件都已处理完。
      enqueue(async () => {
        if (settled) return;
        settled = true;
        resolveSettled();
      });
    }
  };

  const onNotification = (frame) => {
    if (frame.method === "session.event") onSessionEvent(frame.params);
    else if (frame.method === "session.status") onSessionStatus(frame.params);
  };

  runtime.on("notification", onNotification);

  const onExit = ({ code, stderr }) => {
    if (settled) return;
    settled = true;
    if (job.status === "running") {
      jobs.append(job, "error", { message: `agent runtime 意外退出（code=${code}）：${String(stderr ?? "").slice(-400)}` });
      jobs.finish(job, { status: "error", errorMessage: "agent runtime 意外退出" });
    }
    resolveSettled();
  };
  runtime.once("exit", onExit);

  try {
    await runtime.prompt(sessionId, job.userMessage);
    // 等这一轮结束：turn/end → done（队列内生效），或 session.status=idle，或进程退出。
    await Promise.race([settledPromise, sleep(30 * 60 * 1000)]);
    // 再等事件队列排空，确保 finalReply / 画布 patch 都落定后才收尾。
    await processing.catch(() => {});
    if (!settled && job.status === "running") {
      jobs.append(job, "error", { message: "任务超时（30 分钟）未结束" });
      jobs.finish(job, { status: "error", errorMessage: "任务超时" });
      settled = true;
    }
  } catch (err) {
    if (!job.cancelled) {
      jobs.append(job, "error", { message: String(err?.message ?? err) });
      jobs.finish(job, { status: "error", errorMessage: String(err?.message ?? err) });
    }
  } finally {
    runtime.off("notification", onNotification);
    runtime.off("exit", onExit);
    runningJobs.delete(job.id);

    // 收尾：把本轮的画布 patch 增量补发（必须在 done 之前），
    // 让前端画布与工作区最终一致。
    if (CONFIG.canvasSync && !job.cancelled) {
      for (const patch of readCanvasPatches(workspace, baselineRevision)) {
        if (jobs.append(job, "canvas_patch", patch)) canvasRevision = patch.revision;
      }
    }

    if (job.status === "running" && !job.cancelled) {
      const doneSteps = steps || 1;
      jobs.append(job, "done", pendingDone ?? { steps: doneSteps });
      jobs.finish(job, { status: "success", finalReply, steps: doneSteps });
    }
    log(`[job ${job.id}] 结束 status=${job.status} events=${job.events.length} canvas_rev=${canvasRevision}`);
  }
}

/**
 * 用请求里带的画布快照 seed 会话工作区。
 *
 * 为什么必须做：MCP 的画布工具读的是工作区里的 canvas.json，而浏览器是每次 run
 * 把整张画布快照随请求一起发上来的。不 seed 的话，工具看到的是**空画布** ——
 * 现象就是 agent 说"当前画布是空的"，而用户画布上明明有内容（实测踩过）。
 *
 * revision 用快照自带的：这样工具产出的 patch 的 base_revision 与浏览器当前
 * revision 对齐，前端 `advanceCanvasPatchRevision` 才能顺利接上。
 *
 * 只在请求确实带了画布时才写。空数组不能当成"用户把画布清空了"——
 * 那会把工作区里的画布抹掉（丢历史、也让多轮任务失去上下文）。
 */
function seedCanvasFromRequest(workspace, body) {
  const nodes = Array.isArray(body?.nodes) ? body.nodes : null;
  const edges = Array.isArray(body?.edges) ? body.edges : null;
  const groups = Array.isArray(body?.groups) ? body.groups : [];
  if (!nodes && !edges) return { seeded: false };

  const revision = Number.isSafeInteger(body?.canvas_revision) && body.canvas_revision >= 0
    ? body.canvas_revision
    : 0;
  const canvas = { revision, nodes: nodes ?? [], edges: edges ?? [], groups };
  const { canvas: canvasFile, patches } = canvasPathsFor(workspace);
  mkdirSync(dirname(canvasFile), { recursive: true });
  const tmp = `${canvasFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(canvas, null, 2) + "\n", "utf8");
  renameSync(tmp, canvasFile);
  // 清空 patch 文件：seed 之后 base_revision 与浏览器一致，旧 patch 不能再回放，
  // 否则前端会把上一轮/别的会话的变更重复应用一遍。
  writeFileSync(patches, "", "utf8");
  return { seeded: true, revision, nodes: canvas.nodes.length, edges: canvas.edges.length };
}

// ── HTTP ────────────────────────────────────────────────────────────────────

function readJsonBody(req, limitBytes = 8 * 1024 * 1024) {
  return new Promise((resolvePromise, rejectPromise) => {
    let body = "";
    req.on("data", (chunk) => {
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
        rejectPromise(new Error(`请求体不是合法 JSON: ${err.message}`));
      }
    });
    req.on("error", rejectPromise);
  });
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(payload));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  try {
    // ── 只读检视页（历史回放）────────────────────────────────────────────────
    // 不参与业务链路：即使它挂了也不影响 agent 运行。
    if (path === "/" || path === "/inspector") {
      const html = readInspectorFile("inspector.html");
      if (html === null) {
        sendJson(res, 500, { error: "inspector.html 缺失" });
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
      return;
    }
    if (path === "/inspector/app.js" || path === "/inspector/timeline.js") {
      const script = timelineBundle();
      if (!script.ok) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        res.end(`时间线 bundle 构建失败: ${script.error}`);
        return;
      }
      res.writeHead(200, {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(script.code);
      return;
    }
    if (path === "/inspector/jobs") {
      // 只读列表：按创建时间倒序，带关键统计供列表页展示
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
      const list = [...jobs.jobs.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit)
        .map((job) => ({
          ...jobs.state(job),
          user_message: job.userMessage.slice(0, 200),
          created_at: job.createdAt,
          finished_at: job.finishedAt,
          tool_calls: job.events.filter((event) => event.type === "tool_call").length,
          canvas_ops: job.events.filter((event) => event.type === "canvas_patch").length,
        }));
      sendJson(res, 200, { jobs: list, total: jobs.jobs.size, store: jobStore ? jobStore.stats() : null });
      return;
    }

    if (path === "/health") {      sendJson(res, 200, {
        ok: true,
        profile: CONFIG.profile,
        workspace: CONFIG.workspace,
        model: CONFIG.model,
        provider: CONFIG.provider,
        paced: CONFIG.paced,
        canvas_sync: CONFIG.canvasSync,
        translator_source: TRANSLATOR_SOURCE,
        // 根工作区多数情况下还没有画布文件（画布在会话子目录里），
        // 所以这里给出真实存在的那份：取第一个活跃会话的 revision。
        canvas_revision: (() => {
          const active = pool.stats().conversations[0];
          return active ? readCanvasRevision(pool.workspaceOf(active)) : readCanvasRevision(CONFIG.workspace);
        })(),
        store: jobStore ? jobStore.stats() : null,
        running_jobs: [...runningJobs.keys()],
        pool: pool.stats(),
      });
      return;
    }

    const createMatch = /^\/api\/app\/agents\/([^/]+)\/jobs$/.exec(path);
    if (createMatch && req.method === "POST") {
      const body = await readJsonBody(req);
      const message = String(body.message ?? "").trim();
      if (!message) {
        sendJson(res, 400, { error: "请输入要执行的内容" });
        return;
      }
      // conversation_id 就是 DSH 的 sessionId：一个会话一个常驻 runtime。
      const conversationId = String(body.conversation_id ?? "").trim() || `ccy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

      // 先把浏览器的画布快照落进会话工作区，MCP 工具才看得到真实画布。
      try {
        const seeded = seedCanvasFromRequest(pool.workspaceOf(conversationId), body);
        if (seeded.seeded) {
          log(`[${conversationId}] 画布已 seed：revision=${seeded.revision} nodes=${seeded.nodes} edges=${seeded.edges}`);
        }
      } catch (err) {
        log(`画布 seed 失败（继续，agent 可能看到空画布）：${err?.message ?? err}`);
      }

      const job = jobs.create({
        conversationId,
        agentId: createMatch[1],
        userMessage: message,
        request: body,
      });
      // 预占世代号：DSH 会话按 cwd 落盘，同一个 conversation_id 在桥重启后会撞名
      // （见 runtime-pool 里 sessionIdFor 的说明）。这里定下来，runJob 复用同一个值。
      job.sessionId = pool.reserveGeneration(conversationId);
      runningJobs.set(job.id, job);
      // 异步跑，先回 job_id（与 Go 侧 202 Accepted 语义一致）。
      void runJob(job).catch((err) => {
        jobs.append(job, "error", { message: String(err?.message ?? err) });
        jobs.finish(job, { status: "error", errorMessage: String(err?.message ?? err) });
      });
      sendJson(res, 202, { job_id: job.id, conversation_id: conversationId, status: "queued" });
      return;
    }

    const stateMatch = /^\/api\/app\/agent-jobs\/([^/]+)$/.exec(path);
    if (stateMatch && req.method === "GET") {
      const job = jobs.get(stateMatch[1]);
      if (!job) {
        sendJson(res, 404, { error: "任务不存在" });
        return;
      }
      sendJson(res, 200, jobs.state(job));
      return;
    }

    const cancelMatch = /^\/api\/app\/agent-jobs\/([^/]+)\/cancel$/.exec(path);
    if (cancelMatch && req.method === "POST") {
      const job = jobs.get(cancelMatch[1]);
      if (!job) {
        sendJson(res, 404, { error: "任务不存在" });
        return;
      }
      const cancelled = jobs.cancel(job);
      // 硬取消：连带释放 runtime（DSH 协议无法只停一轮，要真停只能关进程）。
      if (cancelled && url.searchParams.get("hard") === "1") {
        pool.release(job.conversationId);
      }
      sendJson(res, 200, { ok: cancelled, ...jobs.state(job) });
      return;
    }

    const eventsMatch = /^\/api\/app\/agent-jobs\/([^/]+)\/events$/.exec(path);
    if (eventsMatch && req.method === "GET") {
      const job = jobs.get(eventsMatch[1]);
      if (!job) {
        sendJson(res, 404, { error: "任务不存在" });
        return;
      }
      let cursor = Number(url.searchParams.get("after") ?? 0) || 0;
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write(": connected\n\n");

      let closed = false;
      req.on("close", () => {
        closed = true;
      });

      const flush = () => {
        for (const event of jobs.eventsAfter(job, cursor)) {
          if (closed) return;
          sseWrite(res, event);
          cursor = event.id;
        }
      };

      // 先补齐已有事件，然后增量跟随；终态后把剩余的发完即可收尾。
      // interrupted 也算终态：否则重启前残留的 job 会让这个循环永远不退出，
      // 客户端的 SSE 连接就会一直挂着（实测 180s 都收不到 EOF）。
      const terminal = new Set(["success", "error", "cancelled", "interrupted"]);
      while (!closed) {
        flush();
        if (terminal.has(job.status)) {
          // 终态可能还有末尾事件（done），再 flush 一次后结束。
          flush();
          break;
        }
        await sleep(150);
      }
      if (!closed) res.end();
      return;
    }

    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    log(`请求处理失败 ${path}: ${err?.stack ?? err}`);
    if (!res.headersSent) sendJson(res, 500, { error: String(err?.message ?? err) });
    else res.end();
  }
});

server.listen(CONFIG.port, CONFIG.host, () => {
  log(`监听 http://${CONFIG.host}:${CONFIG.port}`);
  log(`profile=${CONFIG.profile} model=${CONFIG.provider}/${CONFIG.model}`);
  log(`workspace(root)=${CONFIG.workspace}（每个会话一个子目录；画布同步 ${CONFIG.canvasSync ? "开" : "关"}）`);
  log(`canvas-cli=${CONFIG.canvasCliDir}`);
  log(`翻译器来源=${TRANSLATOR_SOURCE}`);
});

const reaper = setInterval(() => jobs.reap(), 10 * 60 * 1000);
if (typeof reaper.unref === "function") reaper.unref();

async function shutdown(signal) {
  log(`收到 ${signal}，正在关停...`);
  server.close();
  // 先把仍在跑的 job 明确收尾（interrupted），再关库 —— 否则它们要等下次启动
  // 才会被发现是残留的 running。
  jobs.finishRunningOnShutdown(`bridge 关闭（${signal}），任务被中断`);
  await pool.releaseAll();
  jobStore?.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// 兜底：单个 runtime 的异常不应该把整个常驻服务带走（内网服务，宁可降级也别整体挂掉）。
process.on("unhandledRejection", (reason) => {
  log(`未处理的 Promise 拒绝: ${reason instanceof Error ? reason.stack : String(reason)}`);
});
process.on("uncaughtException", (err) => {
  log(`未捕获异常: ${err?.stack ?? String(err)}`);
});

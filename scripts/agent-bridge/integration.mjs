#!/usr/bin/env node
/**
 * 真实双端联调：浏览器契约 → Go API → agent bridge → DSH → 画布 → 数据库。
 *
 * 它与 smoke.mjs 的区别：
 *   smoke.mjs  只测桥（Node 侧）。
 *   本脚本     测整条链路：用真实会话 cookie 打 Go 的
 *              POST /api/app/agents/{id}/jobs 与 GET /api/app/agent-jobs/{id}/events，
 *              并核对 Go 事件表、会话消息与桥侧画布文件。
 *
 * 前置：
 *   1. agent bridge 已启动（默认 127.0.0.1:39300）
 *   2. 一个**独立的** Go API 实例（不要用生产实例：见下面 Redis 的坑）
 *   3. Postgres 可达（默认取 .env 的 DATABASE_URL）
 *
 * ⚠️ Redis 的坑：Asynq 队列是共享的。如果测试实例带 REDIS_ADDR，
 *    生产实例（可能跑着旧二进制）会抢走你刚建的任务并用旧逻辑执行。
 *    所以联调实例必须把 REDIS_ADDR 显式设为空，走 in-process 路径：
 *      $env:REDIS_ADDR=''; $env:HTTP_ADDR='0.0.0.0:9097'; .\backend\ccy-canvas-api-harness-test.exe
 *
 * 用法：
 *   node integration.mjs [--api http://127.0.0.1:9097] [--bridge http://127.0.0.1:39300]
 *                        [--secret <SESSION_SECRET>] [--timeout 420]
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHmac } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const API = String(flag("--api", "http://127.0.0.1:9097")).replace(/\/$/, "");
const BRIDGE = String(flag("--bridge", "http://127.0.0.1:39300")).replace(/\/$/, "");
const TIMEOUT_SEC = Number(flag("--timeout", 420));
const AGENT_NAME = String(flag("--agent-name", "harness 联调智能体"));

/** 从 .env 读取需要的配置（DATABASE_URL / SESSION_SECRET）。 */
function readEnvFile() {
  const path = join(REPO, ".env");
  const env = {};
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

const fileEnv = readEnvFile();
const SECRET = flag("--secret", process.env.SESSION_SECRET ?? fileEnv.SESSION_SECRET ?? "");
const DATABASE_URL = process.env.DATABASE_URL ?? fileEnv.DATABASE_URL ?? "";

if (!SECRET) {
  process.stderr.write("缺少 SESSION_SECRET（用 --secret 或 .env）\n");
  process.exit(2);
}
if (!DATABASE_URL) {
  process.stderr.write("缺少 DATABASE_URL（用 .env）\n");
  process.exit(2);
}

/** 与 Go 侧 session.Manager 完全同形：base64url(json) + "." + base64url(hmacSha256)。 */
function signSession(userID, role = "member", days = 7) {
  const claims = {
    user_id: userID,
    role,
    expires_at: Math.floor(Date.now() / 1000) + days * 24 * 3600,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = createHmac("sha256", SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

// ── 直连 Postgres（走 docker exec psql，避免给脚本引入 pg 依赖）──────────────

import { execFileSync } from "node:child_process";

function sql(query) {
  return execFileSync(
    "docker",
    ["exec", "-i", "ccy-canvas-postgres", "psql", "-U", "postgres", "-d", "ccy_canvas", "-tAc", query],
    { encoding: "utf8" },
  ).trim();
}

function sqlScalar(query) {
  return sql(query).split("\n")[0].trim();
}

function log(message) {
  process.stdout.write(`[integration] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`\n❌ ${message}\n`);
  process.exit(1);
}

// ── 准备测试数据 ─────────────────────────────────────────────────────────────

log(`API=${API}  BRIDGE=${BRIDGE}`);

// 桥健康检查：先失败在这里，比后面报"桥接服务不可用"更容易定位。
try {
  const health = await fetch(`${BRIDGE}/health`).then((r) => r.json());
  log(`桥已就绪: profile=${health.profile} workspace=${health.workspace} 翻译器=${health.translator_source}`);
} catch (err) {
  fail(`桥不可达（${BRIDGE}）：${err.message}。请先启动 scripts/agent-bridge/server.mjs`);
}

// 用户：--user 指定时直接复用该 UUID（联调已有数据时最省事），
// 否则按固定邮箱找/建。注意智能体有 owner 校验，跨用户的 agent 会被 403。
const ownerOverride = String(flag("--user", "")).trim();
let userID = ownerOverride;
if (userID) {
  log(`复用指定用户 ${userID}`);
} else {
  userID = sqlScalar(`select id from users where email = 'harness-integration@example.invalid' limit 1`);
  if (!userID) {
    userID = sqlScalar(
      `insert into users (email, password_hash, name, role, status)
       values ('harness-integration@example.invalid', 'x', 'harness 联调', 'member', 'active')
       returning id`,
    );
    log(`已创建联调用户 ${userID}`);
  } else {
    log(`复用联调用户 ${userID}`);
  }
}

// 智能体：--agent-name 指定的必须已存在，且由 --user 拥有（有 owner 校验）。
//
// ⚠️ 刻意不自动改写已存在智能体的 metadata：早期版本会强行写入
// agentRuntime=harness，结果把"关闭开关"的负向验证悄悄变成了正向验证
// （跑出来还以为回退生效了）。这里只**读**并报告，是否 harness 由调用方自己决定。
const agentRow = sql(
  `select id || '|' || coalesce(metadata->>'agentRuntime','') from agents where name = '${AGENT_NAME}' limit 1`,
);
if (!agentRow) {
  fail(`智能体「${AGENT_NAME}」不存在。请先创建（联调脚本不再自动创建智能体，避免开关被隐式改写）。`);
}
const [agentID, agentRuntime] = agentRow.split("|");
log(`复用联调智能体 ${agentID}（agentRuntime=${agentRuntime || "(未设置)"}）`);
if (String(flag("--expect-runtime", agentRuntime)).trim() !== agentRuntime) {
  fail(
    `开关不符合预期：期望 agentRuntime=${flag("--expect-runtime", "")}，实际 ${agentRuntime || "(未设置)"}。` +
      `请先用 SQL 显式设置，避免测错路径。`,
  );
}

// 会话：每轮新建一个，避免历史累积影响判断
const conversationID = sqlScalar(
  `insert into agent_conversations (user_id, agent_id, title) values ('${userID}', '${agentID}', '')
   returning id`,
);
log(`新建会话 ${conversationID}`);

const cookie = signSession(userID);
log(`已用 SESSION_SECRET 签出会话 cookie（${cookie.length} 字节）`);

// ── 打 Go API ────────────────────────────────────────────────────────────────

const TASK =
  "用画布工具新建一个 image 节点：提示词写 cinematic lighthouse in fog at dawn, 35mm，标题写「双端联调」；" +
  "再新建一个 text 节点写这个镜头的分镜说明，并连线到那个 image 节点。完成后一句话汇报。";

// Go 的 JSON 响应有个统一信封：{"data": ...}（前端 agent-run.ts 也是
// `responseBody.data ?? responseBody` 这样解的）。这里同样两种都接受。
function unwrap(payload) {
  if (payload && typeof payload === "object" && "data" in payload && payload.data && typeof payload.data === "object") {
    return payload.data;
  }
  return payload;
}

log("POST /api/app/agents/{id}/jobs …");
const created = await fetch(`${API}/api/app/agents/${agentID}/jobs`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: `ccy_session=${cookie}` },
  body: JSON.stringify({
    message: TASK,
    conversation_id: conversationID,
    nodes: [],
    edges: [],
    history: [],
    canvas_revision: 0,
  }),
});
if (!created.ok) {
  fail(`建任务失败 HTTP ${created.status}: ${(await created.text()).slice(0, 400)}`);
}
const job = unwrap(await created.json());
if (!job?.job_id) fail(`Go 未返回 job_id，实际响应: ${JSON.stringify(job).slice(0, 300)}`);
log(`Go 返回 job_id=${job.job_id} conversation_id=${job.conversation_id}`);

// 消费 Go 的 SSE（与前端完全同一条路径）
log(`GET /api/app/agent-jobs/${job.job_id}/events …`);
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), TIMEOUT_SEC * 1000);

const counts = new Map();
let lastEventId = 0;
let finalReply = "";
let sawDone = false;
let errorMessage = "";

try {
  const response = await fetch(`${API}/api/app/agent-jobs/${job.job_id}/events?after=0`, {
    headers: { cookie: `ccy_session=${cookie}` },
    signal: controller.signal,
  });
  if (!response.ok) fail(`事件流 HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      let eventName = "";
      let dataLine = "";
      let frameId = 0;
      for (const line of frame.split("\n")) {
        if (line.startsWith("id:")) frameId = Number(line.slice(3).trim()) || 0;
        else if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
      }
      if (!eventName) continue;
      if (frameId) lastEventId = Math.max(lastEventId, frameId);
      counts.set(eventName, (counts.get(eventName) ?? 0) + 1);

      let data = {};
      try {
        data = dataLine ? JSON.parse(dataLine) : {};
      } catch {
        // 忽略
      }
      if (eventName === "done") sawDone = true;
      if (eventName === "message") finalReply = String(data.content ?? "");
      if (eventName === "error") errorMessage = String(data.message ?? "");
      if (eventName === "tool_call") log(`  🔧 ${data.name}`);
      if (eventName === "canvas_patch") log(`  🎨 ${data.op} rev=${data.revision}`);
      if (sawDone || errorMessage) {
        controller.abort();
        break;
      }
    }
    if (sawDone || errorMessage) break;
  }
} catch (err) {
  if (err?.name !== "AbortError") log(`流读取中断: ${err.message}`);
} finally {
  clearTimeout(timer);
}

log(`事件分布: ${JSON.stringify(Object.fromEntries(counts))}`);

// 与真实前端一致：收到 done 后等 job 落终态，并补读游标之后的事件
for (let attempt = 0; attempt < 60; attempt++) {
  const state = unwrap(
    await fetch(`${API}/api/app/agent-jobs/${job.job_id}`, {
      headers: { cookie: `ccy_session=${cookie}` },
    }).then((r) => r.json()),
  );
  if (["success", "error", "cancelled"].includes(state.status)) break;
  await new Promise((r) => setTimeout(r, 200));
}
const replay = await fetch(`${API}/api/app/agent-jobs/${job.job_id}/events?after=${lastEventId}`, {
  headers: { cookie: `ccy_session=${cookie}` },
}).then((r) => r.text());
let recovered = 0;
for (const frame of replay.split("\n\n").filter(Boolean)) {
  let eventName = "";
  let dataLine = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
  }
  if (!eventName) continue;
  counts.set(eventName, (counts.get(eventName) ?? 0) + 1);
  if (eventName === "canvas_patch") recovered += 1;
  let data = {};
  try {
    data = dataLine ? JSON.parse(dataLine) : {};
  } catch {
    // 忽略
  }
  if (eventName === "message") finalReply = String(data.content ?? "");
  if (eventName === "error") errorMessage = String(data.message ?? "");
}
log(`补读 ${recovered} 条收尾事件；最终事件分布: ${JSON.stringify(Object.fromEntries(counts))}`);

// ── 校验数据库 ───────────────────────────────────────────────────────────────

log("核对数据库 …");
const runRow = sql(
  `select status || '|' || final_reply || '|' || tool_calls from agent_runs where id = '${job.job_id}'`,
);
const [runStatus, runReply, runToolCalls] = runRow.split("|");

const storedEvents = sql(
  `select string_agg(event_type, ',' order by id) from agent_run_events where run_id = '${job.job_id}'`,
);
const messages = sql(
  `select coalesce(string_agg(role, ',' order by created_at, id), '') from agent_conversation_messages where conversation_id = '${conversationID}'`,
);
const title = sqlScalar(`select title from agent_conversations where id = '${conversationID}'`);
// 记忆：只统计**本次 run 期间**新增的行，否则历史残留会让断言误判通过。
const memoryCount = sqlScalar(
  `select count(*) from agent_memories
   where user_id = '${userID}' and agent_id = '${agentID}' and created_at >= now() - interval '10 minutes'`,
);

// 桥侧画布文件：会话工作区目录名是 conversation_id 的 sanitize 结果
// （见 lib/runtime-pool.mjs 的 sanitizeSegment），所以按同一规则推导。
const health = await fetch(`${BRIDGE}/health`).then((r) => r.json());
const bridgeWorkspace = health.workspace;
const sessionDirName = String(conversationID).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "session";
const sessionDir = join(bridgeWorkspace, sessionDirName);
const canvasPath = join(sessionDir, "canvas.json");
let canvasSummary = `(未找到 ${canvasPath})`;
let bridgePatches = 0;
try {
  const canvas = JSON.parse(readFileSync(canvasPath, "utf8"));
  canvasSummary = `revision=${canvas.revision} nodes=${canvas.nodes.length} edges=${canvas.edges.length}`;
  const patchPath = join(sessionDir, "patches.jsonl");
  if (existsSync(patchPath)) {
    bridgePatches = readFileSync(patchPath, "utf8").split("\n").filter(Boolean).length;
  }
} catch {
  // 画布文件还没生成（例如 DSH 没调画布工具）
}

// ── 结论 ─────────────────────────────────────────────────────────────────────

const usingHarness = agentRuntime === "harness";
// 事件顺序：done 必须是最后一条，且画布补丁要在它之前
// （前端一收到 done 就停止处理后续事件）。用"最后一条是不是 done"判断，
// 而不是比较下标 —— 前者对多条 canvas_patch 和零 patch 都正确。
const storedList = (storedEvents ?? "").split(",").filter(Boolean);
const lastStored = storedList[storedList.length - 1] ?? "";
const patchBeforeDone =
  lastStored === "done" && (usingHarness ? storedList.includes("canvas_patch") : true);

const checks = [
  ["Go 侧 job 成功", runStatus === "success", `status=${runStatus}`],
  ["最终回复非空", Boolean(runReply?.trim()), (runReply ?? "").slice(0, 80)],
  ["工具调用计数 > 0", Number(runToolCalls) > 0, `tool_calls=${runToolCalls}`],
  ["SSE 收到 done", sawDone, sawDone ? "yes" : "no"],
  ["无 error 事件", !errorMessage, errorMessage || "无"],
  ["有 canvas_patch 事件", (counts.get("canvas_patch") ?? 0) > 0, `${counts.get("canvas_patch") ?? 0} 条`],
  ["done 是最后一条事件且画布补丁在其之前", patchBeforeDone, storedList.slice(-4).join(",")],
  ["会话消息含 user/assistant/tool_log", /user/.test(messages) && /assistant/.test(messages) && /tool_log/.test(messages), messages],
  ["首轮生成了标题", Boolean(title?.trim()), title ?? ""],
  ["写入了本轮记忆", Number(memoryCount) > 0, `${memoryCount} 条`],
  ...(usingHarness
    ? [["桥侧画布已变更（harness 路径）", /nodes=[1-9]/.test(canvasSummary), `${canvasSummary}, patches=${bridgePatches}`]]
    : [["桥未被使用（local 路径不应产生桥画布）", !existsSync(canvasPath), canvasSummary]]),
];

process.stdout.write("\n================ 联调结果 ================\n");
let allPass = true;
for (const [name, ok, detail] of checks) {
  if (!ok) allPass = false;
  process.stdout.write(`${ok ? "✅" : "❌"} ${name}：${detail}\n`);
}
process.stdout.write("==========================================\n");
if (finalReply) process.stdout.write(`\n最终回复：${finalReply.slice(0, 300)}\n`);

process.exit(allPass ? 0 : 1);

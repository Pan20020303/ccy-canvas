#!/usr/bin/env node
/**
 * 用真实 job 的事件流验证时间线呈现结果。
 *
 * 页面本身跑在浏览器里，但"呈现逻辑"是共享的纯函数（src/app/agent-timeline.ts），
 * 所以可以在这里离线跑一遍，确认真实数据压出来的时间线是**可读且完整**的
 * （而不是只在浏览器里"看起来能打开"）。
 *
 * 用法：
 *   node verify-timeline.mjs [--bridge http://127.0.0.1:39320] [--job <jobId>]
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const BRIDGE = String(flag("--bridge", "http://127.0.0.1:39300")).replace(/\/$/, "");

/** 用 esbuild 把共享时间线模块打成 ESM，供本脚本 import。 */
function buildTimelineForNode() {
  const outfile = join(mkdtempSync(join(tmpdir(), "ccy-timeline-")), "timeline.mjs");
  const esbuild = join(REPO, "node_modules", "esbuild", "bin", "esbuild");
  if (!existsSync(esbuild)) throw new Error("找不到 esbuild");
  execFileSync(
    process.execPath,
    [
      esbuild,
      join(HERE, "inspector-entry.js"),
      "--bundle",
      "--format=esm",
      "--platform=node",
      "--target=es2022",
      "--log-level=error",
      `--outfile=${outfile}`,
    ],
    { cwd: REPO, stdio: ["ignore", "ignore", "pipe"] },
  );
  return outfile;
}

function parseSse(text) {
  const events = [];
  for (const frame of text.split("\n\n")) {
    if (!frame.trim() || frame.startsWith(":")) continue;
    let id = 0;
    let type = "";
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("id:")) id = Number(line.slice(3).trim()) || 0;
      else if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!type) continue;
    let parsed = {};
    try {
      parsed = data ? JSON.parse(data) : {};
    } catch {
      parsed = {};
    }
    events.push({ id, type, data: parsed, at: id });
  }
  return events;
}

const bundlePath = buildTimelineForNode();
await import(pathToFileURL(bundlePath).href);
// 入口把实现挂在 globalThis 上（同一份 bundle 浏览器与 Node 复用）。
const { buildTimeline, finalReplyOf, previewText } = globalThis.CcyTimeline;
if (typeof buildTimeline !== "function") {
  process.stderr.write("时间线 bundle 没有导出 buildTimeline，检查 inspector-entry.js\n");
  process.exit(2);
}

const listResponse = await fetch(`${BRIDGE}/inspector/jobs?limit=20`).then((r) => r.json());
const jobs = listResponse.jobs ?? [];
if (!jobs.length) {
  process.stderr.write("桥里还没有 job，先跑一个任务（smoke.mjs）再来验证\n");
  process.exit(2);
}

const requested = flag("--job", null);
const targets = requested ? jobs.filter((job) => job.job_id === requested) : jobs.slice(0, 3);
if (!targets.length) {
  process.stderr.write(`找不到 job ${requested}\n`);
  process.exit(2);
}

let failures = 0;
for (const job of targets) {
  const text = await fetch(`${BRIDGE}/api/app/agent-jobs/${job.job_id}/events?after=0`).then((r) => r.text());
  const events = parseSse(text);
  const { steps, summary } = buildTimeline(events);

  process.stdout.write(`\n══════ ${job.job_id}（${job.status}）══════\n`);
  process.stdout.write(
    `事件 ${events.length} 条 → 时间线 ${steps.length} 步` +
      `（思考 ${steps.filter((s) => s.kind === "reasoning").length} 块 / ` +
      `工具 ${steps.filter((s) => s.kind === "tool").length} / ` +
      `画布 ${steps.filter((s) => s.kind === "canvas").length} / ` +
      `正文 ${steps.filter((s) => s.kind === "message").length}）\n`,
  );
  process.stdout.write(
    `统计: 工具 ${summary.toolCalls} · 画布 ${summary.canvasOps} · ` +
      `思考片 ${summary.reasoningChunks} · 正文片 ${summary.messageChunks} · token ${summary.totalTokens}\n`,
  );

  // 期望：真实数据里这四类都应当出现（否则说明呈现层把东西丢了）
  const checks = [
    ["事件被压缩（155 → 明显更少的步骤）", steps.length < events.length, `${events.length} → ${steps.length}`],
    ["有思考块", steps.some((s) => s.kind === "reasoning"), ""],
    ["有工具卡片", steps.some((s) => s.kind === "tool"), ""],
    ["有画布变更卡片", steps.some((s) => s.kind === "canvas"), ""],
    ["工具名已去 MCP 前缀", steps.filter((s) => s.kind === "tool").every((s) => !s.name.startsWith("mcp__")), ""],
    ["工具都已配对结果", steps.filter((s) => s.kind === "tool").every((s) => s.ok !== null), ""],
    [
      "画布卡片的 revision 连续",
      (() => {
        const revs = steps.filter((s) => s.kind === "canvas").map((s) => s.revision);
        return revs.every((value, index) => index === 0 || value === revs[index - 1] + 1);
      })(),
      steps.filter((s) => s.kind === "canvas").map((s) => `rev${s.revision}`).join(" → "),
    ],
    ["最终回复非空", Boolean(job.final_reply || finalReplyOf(events)), ""],
  ];
  for (const [name, ok, detail] of checks) {
    if (!ok) failures += 1;
    process.stdout.write(`  ${ok ? "✅" : "❌"} ${name}${detail ? `：${detail}` : ""}\n`);
  }

  process.stdout.write("  ── 时间线预览 ──\n");
  for (const step of steps.slice(0, 12)) {
    if (step.kind === "reasoning") {
      process.stdout.write(`  [思考/${step.chunkCount}片] ${previewText(step.text, 70)}\n`);
    } else if (step.kind === "message") {
      process.stdout.write(`  [正文] ${previewText(step.text, 70)}\n`);
    } else if (step.kind === "tool") {
      process.stdout.write(`  [工具] ${step.name} ${step.ok ? "ok" : "失败"} ← ${previewText(step.result ?? step.error, 50)}\n`);
    } else if (step.kind === "canvas") {
      process.stdout.write(`  [画布] ${step.op} rev${step.revision}: ${step.summary}\n`);
    } else if (step.kind === "notice") {
      process.stdout.write(`  [${step.level === "error" ? "错误" : "说明"}] ${previewText(step.text, 70)}\n`);
    } else if (step.kind === "usage") {
      process.stdout.write(`  [计量] total ${step.totalTokens}\n`);
    }
  }
  if (steps.length > 12) process.stdout.write(`  …（共 ${steps.length} 步）\n`);
}

process.stdout.write(`\n${failures === 0 ? "✅ 时间线呈现验证通过" : `❌ 有 ${failures} 项不通过`}\n`);
process.exit(failures === 0 ? 0 : 1);

#!/usr/bin/env node
/**
 * 检查某个 job 的推理/正文隔离情况（验证"思考不跑进正文"）。
 *
 * 用法：node check-reasoning.mjs <jobId>
 *
 * 为什么单独写：PowerShell 里内联带引号的 SQL 极易被转义搞坏（实测多次）。
 */

import { DatabaseSync } from "node:sqlite";

const jobId = process.argv[2];
if (!jobId) {
  process.stderr.write("用法: node check-reasoning.mjs <jobId>\n");
  process.exit(2);
}

const db = new DatabaseSync(".agent-bridge/state/jobs.db");

const kinds = db.prepare("select type, count(*) as n from job_events where job_id = ? group by type order by n desc").all(jobId);
process.stdout.write(`事件类型: ${JSON.stringify(kinds)}\n`);

const message = db.prepare("select data from job_events where job_id = ? and type = 'message' order by id desc limit 1").get(jobId);
const content = message ? JSON.parse(message.data).content ?? "" : "";
process.stdout.write(`\n--- message 事件内容（应为纯正文，不含推理）---\n${content || "(无)"}\n`);

const thoughts = db
  .prepare("select count(*) as n from job_events where job_id = ? and type = 'thought_delta'")
  .get(jobId);
process.stdout.write(`\n--- thought_delta 条数: ${thoughts.n}（推理应在这里，而不是 message 里）---\n`);

if (thoughts.n > 0) {
  const sample = db
    .prepare("select data from job_events where job_id = ? and type = 'thought_delta' order by id limit 3")
    .all(jobId)
    .map((row) => JSON.parse(row.data).delta ?? "")
    .join("");
  process.stdout.write(`推理开头: ${sample.slice(0, 120)}\n`);
}

// 判定：message 内容不应包含推理的典型自述语气
const reasoningMarkers = ["Let me", "I should", "I need to", "我应该", "我先", "让我先", "Now answer", "Report in"];
const leaked = reasoningMarkers.filter((marker) => content.includes(marker));
process.stdout.write(
  `\n${leaked.length === 0 ? "✅ message 里没有推理语气标记" : `❌ message 里疑似混入推理: ${leaked.join(", ")}`}\n`,
);

db.close();

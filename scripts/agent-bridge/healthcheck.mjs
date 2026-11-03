#!/usr/bin/env node
/**
 * 探活桥服务（启动脚本用）。
 *
 * 为什么用 Node 而不是 batch 里的 curl + errorlevel：批处理的 exit code 传递
 * 在这类场景下不可靠，而"桥没起来但脚本说就绪"会让人排查错方向。
 *
 * 用法：
 *   node scripts/agent-bridge/healthcheck.mjs [--port 39300] [--wait 20]
 *
 * 退出码：0 = /health 返回 ok；1 = 超时或响应异常（并打印日志尾部帮助定位）。
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}
const PORT = Number(flag("--port", 39300));
const WAIT_SECONDS = Number(flag("--wait", 20));
const LOG = join(REPO, ".agent-bridge", "bridge.log");

const deadline = Date.now() + WAIT_SECONDS * 1000;
let lastError = "未开始探测";

while (Date.now() < deadline) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const response = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (response.ok) {
      const body = await response.json();
      process.stdout.write(
        `[healthcheck] ok | workspace=${body.workspace} | 落库=${body.store ? `${body.store.jobs} job / ${body.store.events} 事件` : "关闭"}\n`,
      );
      process.exit(0);
    }
    lastError = `HTTP ${response.status}`;
  } catch (err) {
    lastError = err?.message ?? String(err);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

process.stderr.write(`[healthcheck] ${WAIT_SECONDS}s 内未就绪（最后错误：${lastError}）\n`);
if (existsSync(LOG)) {
  process.stderr.write(`[healthcheck] ${LOG} 尾部：\n`);
  for (const line of readFileSync(LOG, "utf8").split(/\r?\n/).slice(-12)) {
    if (line.trim()) process.stderr.write(`  ${line}\n`);
  }
}
process.exit(1);

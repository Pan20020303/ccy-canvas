#!/usr/bin/env node
/**
 * 手工探测 `dsh --profile sdk` 的 stdio JSON-RPC 握手。
 *
 * 用途：bridge 出问题（例如 "cannot create effect on inactive context"）时，
 * 用最小客户端把 initialize / session/prompt 逐步打通，看原始帧与 stderr。
 *
 * 用法：
 *   node probe-sdk.mjs --workspace <dir> [--profile ccy] [--patch <yml>] [--prompt "任务"]
 */

import { spawn } from "node:child_process";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1]?.startsWith("--") ? true : argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const dshBin =
  args.dsh ??
  "C:\\Users\\Administrator\\AppData\\Local\\npm-cache\\_npx\\1e7f6d9597241db0\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js";
const profile = args.profile ?? "ccy";
const workspace = args.workspace ?? process.cwd();
const patch = args.patch;

const child = spawn(
  process.execPath,
  [dshBin, "--profile", profile, ...(patch ? ["--patch", patch] : [])],
  { cwd: workspace, env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] },
);

let buffer = "";
const pending = new Map();
let nextId = 1;

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      process.stdout.write(`[非 JSON 帧] ${line.slice(0, 200)}\n`);
      continue;
    }
    process.stdout.write(`[← ] ${JSON.stringify(frame).slice(0, 300)}\n`);
    if (frame.id !== undefined && frame.method === undefined) {
      const entry = pending.get(frame.id);
      if (entry) {
        pending.delete(frame.id);
        entry(frame);
      }
    }
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => process.stderr.write(`[stderr] ${chunk}`));
child.on("exit", (code, signal) => process.stdout.write(`[exit] code=${code} signal=${signal}\n`));

function request(method, params, timeoutMs = 60000) {
  const id = nextId++;
  const frame = { jsonrpc: "2.0", id, method, params };
  process.stdout.write(`[→ ] ${JSON.stringify(frame).slice(0, 300)}\n`);
  child.stdin.write(JSON.stringify(frame) + "\n");
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise({ __timeout: true }), timeoutMs);
    pending.set(id, (response) => {
      clearTimeout(timer);
      resolvePromise(response);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.stdout.write(`--- 探测 dsh --profile ${profile}（cwd=${workspace}）---\n`);
await sleep(500);

const init = await request("initialize", {
  cwd: workspace,
  provider: "deepseek-official",
  model: "deepseek-flash",
});
process.stdout.write(`\n### initialize 结果: ${JSON.stringify(init)}\n\n`);

if (init?.result && args.prompt) {
  const sessionId = "probe-1";
  const prompt = await request("session/prompt", {
    sessionId,
    contentBlocks: [{ type: "text", text: String(args.prompt) }],
  });
  process.stdout.write(`\n### session/prompt 结果: ${JSON.stringify(prompt)}\n\n`);
  // 等事件流跑一会儿
  await sleep(Number(args.wait ?? 90000));
}

try {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "shutdown", params: {} }) + "\n");
} catch {
  // ignore
}
await sleep(1500);
child.kill();
process.exit(0);

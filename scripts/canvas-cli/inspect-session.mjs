#!/usr/bin/env node
/**
 * 会话取证工具 —— 逐帧解压 DSH 会话日志（zstd 多帧），检查某次 run 向模型暴露了哪些工具。
 *
 * 背景：DSH 的 session.v3.jsonl.zstd 是**多个 zstd 帧拼接**（每次 flush 一帧），
 * zstdDecompressSync 只解第一帧，因此必须按 magic(28 b5 2f fd) 切帧后逐帧解压。
 *
 * 用法：
 *   node inspect-session.mjs [--limit 5] [--grep mcp__ccy] [--dump]
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { zstdDecompressSync } from "node:zlib";

const argv = process.argv.slice(2);
function flagValue(name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}
const limit = Number(flagValue("--limit", 5)) || 5;
const grep = flagValue("--grep", null);
const dump = argv.includes("--dump");

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const sessionsRoot = join(homedir(), ".dsh", "sessions");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".jsonl.zstd")) out.push(full);
  }
  return out;
}

/** 按 magic 切帧并逐帧解压，返回完整文本。 */
export function decompressFrames(raw) {
  const offsets = [];
  let cursor = 0;
  while (true) {
    const found = raw.indexOf(MAGIC, cursor);
    if (found < 0) break;
    offsets.push(found);
    cursor = found + 1;
  }
  offsets.push(raw.length);
  const parts = [];
  for (let i = 0; i < offsets.length - 1; i++) {
    const frame = raw.subarray(offsets[i], offsets[i + 1]);
    try {
      parts.push(zstdDecompressSync(frame).toString("utf8"));
    } catch {
      // 单帧损坏不应让整份取证失败
    }
  }
  return parts.join("");
}

const files = walk(sessionsRoot)
  .map((path) => ({ path, mtime: statSync(path).mtimeMs, size: statSync(path).size }))
  .sort((a, b) => b.mtime - a.mtime)
  .slice(0, limit);

let index = 0;
for (const file of files) {
  index += 1;
  const rel = file.path.slice(sessionsRoot.length + 1);
  process.stdout.write(`\n===== [${index}] ${rel}\n      ${(file.size / 1024).toFixed(1)} KB, ${new Date(file.mtime).toLocaleString()} =====\n`);
  const text = decompressFrames(readFileSync(file.path));
  process.stdout.write(`  解压后 ${text.length} bytes / ${text.split("\n").length} 行\n`);

  const names = [...new Set([...text.matchAll(/"name":"([A-Za-z0-9_:.-]+)"/g)].map((m) => m[1]))];
  const mcp = names.filter((name) => name.startsWith("mcp__"));
  process.stdout.write(`  名称种类=${names.length}，其中 mcp=${mcp.length}\n`);
  if (mcp.length) process.stdout.write(`  mcp 工具: ${mcp.join(", ")}\n`);
  if (names.length) process.stdout.write(`  样本: ${names.slice(0, 30).join(", ")}\n`);

  if (grep) {
    const lines = text.split("\n").filter((line) => line.includes(grep));
    process.stdout.write(`  含 "${grep}" 的行数=${lines.length}\n`);
    for (const line of lines.slice(0, 2)) {
      const at = line.indexOf(grep);
      process.stdout.write(`    …${line.slice(Math.max(0, at - 150), at + 250)}…\n`);
    }
  }
  if (dump) {
    process.stdout.write(`  --- 全文 ---\n${text}\n`);
  }
}

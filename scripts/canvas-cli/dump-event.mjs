#!/usr/bin/env node
/**
 * 事件取证 —— 从真实 DSH 会话里提取某类事件的完整 payload。
 *
 * 用途：写 bridge 的事件映射器之前，先看清真实载荷（而不是照文档猜）。
 *
 * 用法：
 *   node dump-event.mjs --find create_text_node            # 找出含该字符串的会话
 *   node dump-event.mjs --find create_text_node --kind assistant/message
 *   node dump-event.mjs --find create_text_node --kind tool/result --depth 6
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { zstdDecompressSync } from "node:zlib";

const argv = process.argv.slice(2);
function flag(name, fallback) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
}

const sessionsRoot = join(homedir(), ".dsh", "sessions");
const find = flag("--find", null);
const kind = flag("--kind", null);
const depth = Number(flag("--depth", 4));

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
function decompress(raw) {
  const offsets = [];
  let cursor = 0;
  while (true) {
    const found = raw.indexOf(MAGIC, cursor);
    if (found < 0) break;
    offsets.push(found);
    cursor = found + 1;
  }
  offsets.push(raw.length);
  let out = "";
  for (let i = 0; i < offsets.length - 1; i++) {
    try {
      out += zstdDecompressSync(raw.subarray(offsets[i], offsets[i + 1])).toString("utf8");
    } catch {
      // 忽略坏帧
    }
  }
  return out;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".jsonl.zstd")) out.push(full);
  }
  return out;
}

let target = null;
for (const file of walk(sessionsRoot)) {
  const text = decompress(readFileSync(file));
  if (!find || text.includes(find)) {
    if (!target || text.length > target.text.length) target = { file, text };
  }
}
if (!target) {
  process.stderr.write("没找到匹配的会话\n");
  process.exit(1);
}
process.stdout.write(`会话: ${target.file}\n`);

const lines = target.text.split("\n").filter(Boolean).map((line) => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}).filter(Boolean);

if (!kind) {
  const kinds = new Map();
  for (const record of lines) {
    const key = record.type === "event" ? (record.event?.kind ?? record.event?.type) : record.type;
    kinds.set(key, (kinds.get(key) ?? 0) + 1);
  }
  process.stdout.write(`事件种类: ${JSON.stringify([...kinds.entries()])}\n`);
  process.exit(0);
}

const matched = lines.filter((record) => {
  const recordKind = record.type === "event" ? (record.event?.kind ?? record.event?.type) : record.type;
  return recordKind === kind;
});
process.stdout.write(`匹配 ${kind} 共 ${matched.length} 条\n`);

for (const [index, record] of matched.slice(0, 2).entries()) {
  const payload = record.event?.data ?? record.event ?? record;
  process.stdout.write(`\n----- #${index + 1} -----\n`);
  const json = JSON.stringify(payload, null, 2);
  process.stdout.write(json.length > 4000 ? json.slice(0, 4000) + "\n…(截断)" : json);
  process.stdout.write("\n");
  // 结构化摘要：把嵌套层级压平，方便看清关键字段名
  const keys = [];
  const visit = (value, path, depth) => {
    if (depth > Number(depthArgFallback())) return;
    if (Array.isArray(value)) {
      keys.push(`${path}[] (len=${value.length})`);
      if (value.length) visit(value[0], `${path}[0]`, depth + 1);
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) visit(child, path ? `${path}.${key}` : key, depth + 1);
      return;
    }
    keys.push(`${path} = ${typeof value === "string" ? JSON.stringify(value.slice(0, 60)) : value}`);
  };
  function depthArgFallback() {
    return String(depth);
  }
  visit(payload, "", 0);
  process.stdout.write(`字段路径:\n  ${keys.join("\n  ")}\n`);
}

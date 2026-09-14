#!/usr/bin/env node
/**
 * 探查 DSH 会话里 assistant/message 的 stream 结构：
 * text-chunks 到底是"纯正文"，还是"推理也走这里"？
 *
 * 用法：node probe-stream.mjs [--limit 3]
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { zstdDecompressSync } from "node:zlib";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function decompress(raw) {
  const offsets = [];
  let cursor = 0;
  for (;;) {
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
    else if (entry.name.endsWith(".jsonl.zstd")) out.push({ path: full, mtime: statSync(full).mtimeMs });
  }
  return out;
}

// 只看桥的会话目录，避免混入别的项目
const root = join(homedir(), ".dsh", "sessions");
const files = walk(root)
  .filter((f) => f.path.includes("agent-bridge"))
  .sort((a, b) => b.mtime - a.mtime)
  .slice(0, 2);

if (!files.length) {
  process.stderr.write("没找到桥的会话文件\n");
  process.exit(1);
}

for (const file of files) {
  process.stdout.write(`\n═══ ${file.path.slice(root.length + 1)} ═══\n`);
  const lines = decompress(readFileSync(file.path)).split("\n").filter(Boolean);
  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record.type !== "event" || record.event?.kind !== "assistant/message") continue;
    const stream = record.event.data?.stream ?? [];
    const kinds = {};
    for (const item of stream) {
      if (!item?.type) continue;
      kinds[item.type] = (kinds[item.type] ?? 0) + 1;
    }
    process.stdout.write(`stream 记录: ${JSON.stringify(kinds)}\n`);
    for (const kind of ["text-chunks", "reasoning-chunks"]) {
      const first = stream.find((item) => item.type === kind);
      const joined = stream
        .filter((item) => item.type === kind)
        .flatMap((item) => item.texts ?? [])
        .join("");
      if (joined) {
        process.stdout.write(`  ${kind}: ${joined.length} 字 | 开头: ${JSON.stringify(joined.slice(0, 100))}\n`);
      }
    }
    const content = (record.event.data?.message?.content ?? [])
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("")
      .trim();
    process.stdout.write(`  message.content: ${content.length} 字 | 开头: ${JSON.stringify(content.slice(0, 100))}\n`);
    break; // 每条会话只看第一条 assistant/message 即可
  }
}

#!/usr/bin/env node
/**
 * 调试用：确认 DSH 会话日志的真实压缩形态与内容规模。
 * 用法：node debug-session.mjs <session.v3.jsonl.zstd>
 */

import { readFileSync } from "node:fs";
import { createZstdDecompress, zstdDecompressSync } from "node:zlib";

const file = process.argv[2];
if (!file) {
  process.stderr.write("用法: node debug-session.mjs <session.v3.jsonl.zstd>\n");
  process.exit(2);
}

const raw = readFileSync(file);
process.stdout.write(`raw bytes = ${raw.length}\n`);
process.stdout.write(`magic = ${raw.subarray(0, 4).toString("hex")} (zstd 应为 28b52ffd)\n`);

try {
  const oneShot = zstdDecompressSync(raw);
  process.stdout.write(`zstdDecompressSync → ${oneShot.length} bytes\n`);
} catch (err) {
  process.stdout.write(`zstdDecompressSync 失败: ${err.message}\n`);
}

// 流式解压：能吞掉多帧 / 分块写出的日志
const chunks = [];
await new Promise((resolve, reject) => {
  const decompress = createZstdDecompress();
  decompress.on("data", (chunk) => chunks.push(chunk));
  decompress.on("end", resolve);
  decompress.on("error", reject);
  decompress.end(raw);
}).catch((err) => process.stdout.write(`流式解压失败: ${err.message}\n`));

const text = Buffer.concat(chunks).toString("utf8");
process.stdout.write(`流式解压 → ${text.length} bytes, ${text.split("\n").length} 行\n`);

const toolNames = [...new Set([...text.matchAll(/"name":"([A-Za-z0-9_:.-]+)"/g)].map((m) => m[1]))];
process.stdout.write(`工具/名称样本 (${toolNames.length}): ${toolNames.slice(0, 40).join(", ")}\n`);

const mcp = [...new Set([...text.matchAll(/mcp__[A-Za-z0-9_-]+/g)].map((m) => m[0]))];
process.stdout.write(`mcp 名称 (${mcp.length}): ${mcp.slice(0, 30).join(", ")}\n`);

process.stdout.write(`\n--- 前 600 字符 ---\n${text.slice(0, 600)}\n`);

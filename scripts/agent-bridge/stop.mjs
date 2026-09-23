#!/usr/bin/env node
/**
 * 停掉占用桥端口的进程（重启桥之前用）。
 *
 * 为什么用 Node 而不是 batch 里的 `netstat | findstr | taskkill`：
 * 那套在 batch 里要处理嵌套引号与 `::` IPv6 地址，极容易写错；
 * 而写错的后果是"旧进程没停掉 → 新进程起不来 → 所有 agent 报桥不可用"，
 * 属于必须一次做对的运维路径。
 *
 * 用法：
 *   node scripts/agent-bridge/stop.mjs [--port 39300]
 *
 * 退出码：0 = 端口已空闲（无论原本有没有进程）；1 = 仍有进程占用（杀不掉）。
 */

import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const portIndex = args.indexOf("--port");
const PORT = Number(portIndex >= 0 ? args[portIndex + 1] : 39300);

function listeningPids(port) {
  try {
    // -ano: 显示 PID；过滤 LISTENING 与目标端口。
    const out = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes("LISTENING")) continue;
      const columns = line.trim().split(/\s+/);
      // 形如: TCP  0.0.0.0:39300  0.0.0.0:0  LISTENING  1234
      const local = columns[1] ?? "";
      if (!local.endsWith(`:${port}`)) continue;
      const pid = Number(columns[columns.length - 1]);
      if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
    }
    return [...pids];
  } catch {
    return [];
  }
}

let pids = listeningPids(PORT);
if (!pids.length) {
  process.stdout.write(`[stop-agent-bridge] :${PORT} 空闲\n`);
  process.exit(0);
}

for (const pid of pids) {
  process.stdout.write(`[stop-agent-bridge] 停止 PID ${pid}（占用 :${PORT}）\n`);
  try {
    execFileSync("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore" });
  } catch {
    // 可能已经退出
  }
}

// 等端口真正释放（taskkill 是异步生效的）
for (let attempt = 0; attempt < 20; attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 250));
  pids = listeningPids(PORT);
  if (!pids.length) {
    process.stdout.write(`[stop-agent-bridge] :${PORT} 已释放\n`);
    process.exit(0);
  }
}

process.stderr.write(`[stop-agent-bridge] :${PORT} 仍被占用（PID ${pids.join(", ")}）\n`);
process.exit(1);

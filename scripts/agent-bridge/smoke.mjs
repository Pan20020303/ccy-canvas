#!/usr/bin/env node
/**
 * bridge 冒烟测试 —— 打一个真实任务，统计 SSE 事件分布，并核对画布到底改没改。
 *
 * 用法：
 *   node smoke.mjs "任务描述" [--conversation conv-1] [--port 39300] [--timeout 300] [--raw]
 *
 * 退出码：0 = 拿到 done 且（可选）画布有变更；1 = 出错或超时。
 */

const args = process.argv.slice(2);
function flag(name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}
const task = args.find((token) => !token.startsWith("--") && token !== flag("--conversation", null) && token !== flag("--port", null) && token !== flag("--timeout", null));
const conversation = flag("--conversation", `smoke-${Date.now().toString(36)}`);
const port = Number(flag("--port", 39300));
const timeoutSec = Number(flag("--timeout", 300));
const showRaw = args.includes("--raw");
const base = `http://127.0.0.1:${port}`;

if (!task) {
  process.stderr.write('用法: node smoke.mjs "任务描述" [--conversation id] [--port 39300] [--timeout 300] [--raw]\n');
  process.exit(2);
}

function stamp() {
  return new Date().toISOString().slice(11, 23);
}

const created = await fetch(`${base}/api/app/agents/demo-agent/jobs`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ message: task, conversation_id: conversation }),
});
if (!created.ok) {
  process.stderr.write(`建任务失败 HTTP ${created.status}: ${await created.text()}\n`);
  process.exit(1);
}
const job = await created.json();
process.stdout.write(`[${stamp()}] job=${job.job_id} conversation=${job.conversation_id}\n`);

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);

const counts = new Map();
let finalReply = "";
let sawDone = false;
let errorMessage = "";
let firstEventAt = null;
let lastEventAt = null;
let deltaChars = 0;
let recoveredCanvasPatches = 0;
/** SSE 的 lastEventId 游标：补读时要从这里往后取，不能靠事件计数（收尾事件会重复计数）。 */
let lastEventId = 0;

try {
  const response = await fetch(`${base}/api/app/agent-jobs/${job.job_id}/events?after=0`, {
    signal: controller.signal,
  });
  if (!response.ok) throw new Error(`events HTTP ${response.status}`);

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
      const at = stamp();
      firstEventAt = firstEventAt ?? at;
      lastEventAt = at;
      counts.set(eventName, (counts.get(eventName) ?? 0) + 1);

      let data = {};
      try {
        data = dataLine ? JSON.parse(dataLine) : {};
      } catch {
        // 忽略
      }
      if (eventName === "done") sawDone = true;
      if (eventName === "message") finalReply = String(data.content ?? "");
      if (eventName === "message_delta" || eventName === "thought_delta") deltaChars += String(data.delta ?? "").length;
      if (eventName === "error") errorMessage = String(data.message ?? "");

      if (showRaw) {
        process.stdout.write(`[${at}] ${eventName} ${JSON.stringify(data).slice(0, 220)}\n`);
      } else if (eventName === "tool_call") {
        process.stdout.write(`[${at}] 🔧 ${data.name}\n`);
      } else if (eventName === "canvas_patch") {
        process.stdout.write(`[${at}] 🎨 ${data.op} rev=${data.revision}\n`);
      }
      if (sawDone || errorMessage) {
        controller.abort();
        break;
      }
    }
    if (sawDone || errorMessage) break;
  }
} catch (err) {
  if (err?.name !== "AbortError") {
    process.stderr.write(`流读取失败: ${err?.message ?? err}\n`);
  }
} finally {
  clearTimeout(timer);
}

process.stdout.write(`\n事件分布: ${JSON.stringify(Object.fromEntries(counts))}\n`);
process.stdout.write(`流式字符数: ${deltaChars}（message_delta + thought_delta）\n`);

// 与真实前端一致：收到 done 后仍要等 job 落终态，并把游标之后的事件补读回来。
// （前端 AgentRunPanel 靠 2s 状态看门狗做同样的事；这里不补读就会漏掉收尾的 canvas_patch。）
if (sawDone || errorMessage) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const state = await fetch(`${base}/api/app/agent-jobs/${job.job_id}`).then((r) => r.json());
    if (["success", "error", "cancelled"].includes(state.status)) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const replay = await fetch(`${base}/api/app/agent-jobs/${job.job_id}/events?after=${lastEventId}`).then((r) => r.text());
  for (const frame of replay.split("\n\n").filter(Boolean)) {
    let eventName = "";
    let dataLine = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
    }
    if (!eventName) continue;
    counts.set(eventName, (counts.get(eventName) ?? 0) + 1);
    let data = {};
    try {
      data = dataLine ? JSON.parse(dataLine) : {};
    } catch {
      // 忽略
    }
    if (eventName === "message") finalReply = String(data.content ?? "");
    if (eventName === "error") errorMessage = String(data.message ?? "");
    if (eventName === "canvas_patch") {
      recoveredCanvasPatches += 1;
      if (showRaw) process.stdout.write(`[补读] 🎨 ${data.op} rev=${data.revision}\n`);
    }
  }
  process.stdout.write(`补读事件分布: ${JSON.stringify(Object.fromEntries(counts))}\n`);
  process.stdout.write(`补读到的 canvas_patch: ${recoveredCanvasPatches}\n`);
}

if (errorMessage) process.stdout.write(`错误: ${errorMessage}\n`);
if (finalReply) process.stdout.write(`最终回复: ${finalReply.slice(0, 400)}\n`);

const state = await fetch(`${base}/api/app/agent-jobs/${job.job_id}`).then((r) => r.json());
process.stdout.write(`job 状态: ${state.status}\n`);

const ok = sawDone && !errorMessage;
process.stdout.write(`\n${ok ? "✅ 通过" : "❌ 失败"}（耗时 ${firstEventAt} → ${lastEventAt}）\n`);
process.exit(ok ? 0 : 1);

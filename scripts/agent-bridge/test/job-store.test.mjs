/**
 * JobStore / JobRegistry 落库与恢复的回归测试。
 *
 * 用 node:test（Node 内置），不需要额外测试框架：
 *   node --test scripts/agent-bridge/test/
 *
 * 覆盖的都是"看起来能用、实际上会静默错"的那类性质：
 *   - 重启后残留的 running 必须变 interrupted（不能假装成功）
 *   - 恢复后事件序号必须续上（否则前端 lastEventId �游标会漏事件或撞主键）
 *   - 关停时未完成的 job 要明确收尾
 *   - 保留策略不能把还在跑的 job 清掉
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JobStore } from "../lib/job-store.mjs";
import { JobRegistry } from "../lib/job-registry.mjs";

/** 建一个临时落库文件，测试结束自动清理。 */
function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), "ccy-bridge-store-"));
  const path = join(dir, "jobs.db");
  return {
    path,
    // Windows 上 SQLite 的文件句柄释放略有延迟，清理失败不该让测试判负
    // （临时目录会被系统回收），所以这里容忍 EPERM/EBUSY。
    cleanup: () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          rmSync(dir, { recursive: true, force: true });
          return;
        } catch {
          // 稍后重试
        }
      }
    },
  };
}

test("事件与终态能落库并在新实例里读回", () => {
  const { path, cleanup } = tempDbPath();
  try {
    const store = new JobStore({ path });
    const registry = new JobRegistry({ store });

    const job = registry.create({ conversationId: "conv-1", agentId: "agent-1", userMessage: "你好" });
    registry.markRunning(job);
    registry.append(job, "message_delta", { delta: "你" });
    registry.append(job, "message_delta", { delta: "好" });
    registry.append(job, "message", { content: "你好" });
    registry.finish(job, { status: "success", finalReply: "你好", steps: 2 });
    store.close();

    // 模拟重启：新 store + 新 registry
    const store2 = new JobStore({ path });
    const registry2 = new JobRegistry({ store: store2 });
    assert.equal(registry2.restore(), 1);

    const restored = registry2.get(job.id);
    assert.ok(restored, "应恢复该 job");
    assert.equal(restored.status, "success");
    assert.equal(restored.finalReply, "你好");
    assert.equal(restored.steps, 2);
    assert.deepEqual(
      restored.events.map((event) => event.type),
      ["message_delta", "message_delta", "message"],
    );
    store2.close();
  } finally {
    cleanup();
  }
});

test("重启后残留的 running 标为 interrupted，而不是假装成功", () => {
  const { path, cleanup } = tempDbPath();
  try {
    const store = new JobStore({ path });
    const registry = new JobRegistry({ store });
    const job = registry.create({ conversationId: "conv-x", agentId: "a", userMessage: "任务" });
    registry.markRunning(job);
    registry.append(job, "tool_call", { id: "c1", name: "create_node", arguments: "{}" });
    // 不调用 finish：模拟进程被强杀
    store.close();

    const store2 = new JobStore({ path });
    const registry2 = new JobRegistry({ store: store2 });
    registry2.restore();
    const restored = registry2.get(job.id);
    assert.ok(restored);
    assert.equal(restored.status, "interrupted", "残留 running 必须变成 interrupted");
    assert.match(restored.errorMessage, /重启|中断/);
    store2.close();
  } finally {
    cleanup();
  }
});

test("恢复后事件序号续上，不会撞主键也不会漏事件", () => {
  const { path, cleanup } = tempDbPath();
  try {
    const store = new JobStore({ path });
    const registry = new JobRegistry({ store });
    const job = registry.create({ conversationId: "conv-seq", agentId: "a", userMessage: "x" });
    registry.markRunning(job);
    for (let index = 0; index < 5; index++) {
      registry.append(job, "message_delta", { delta: String(index) });
    }
    registry.finish(job, { status: "success", finalReply: "ok", steps: 1 });
    const lastId = job.events.at(-1).id;
    store.close();

    const store2 = new JobStore({ path });
    const registry2 = new JobRegistry({ store: store2 });
    registry2.restore();
    const restored = registry2.get(job.id);
    assert.equal(restored.nextEventId, lastId + 1, "下一个事件序号必须接着走");

    // 再次可以追加（说明主键不会冲突），且续传游标语义正确
    store2.close();
  } finally {
    cleanup();
  }
});

test("关停时未完成的 job 被明确收尾（interrupted）", () => {
  const { path, cleanup } = tempDbPath();
  try {
    const store = new JobStore({ path });
    const registry = new JobRegistry({ store });
    const running = registry.create({ conversationId: "conv-s", agentId: "a", userMessage: "跑着" });
    registry.markRunning(running);
    const done = registry.create({ conversationId: "conv-d", agentId: "a", userMessage: "完了" });
    registry.markRunning(done);
    registry.finish(done, { status: "success", finalReply: "ok", steps: 1 });

    const n = registry.finishRunningOnShutdown("bridge 关闭");
    assert.equal(n, 1, "只应收尾仍在跑的那个");
    assert.equal(running.status, "interrupted");
    assert.equal(done.status, "success", "已完成的 job 不能被改写");

    // 重启后也不该再被当成 running
    store.close();
    const store2 = new JobStore({ path });
    const registry2 = new JobRegistry({ store: store2 });
    registry2.restore();
    assert.equal(registry2.get(running.id).status, "interrupted");
    assert.equal(registry2.get(done.id).status, "success");
    store2.close();
  } finally {
    cleanup();
  }
});

test("终态 job 之后的事件被丢弃（不再写库）", () => {
  const { path, cleanup } = tempDbPath();
  try {
    const store = new JobStore({ path });
    const registry = new JobRegistry({ store });
    const job = registry.create({ conversationId: "c", agentId: "a", userMessage: "x" });
    registry.markRunning(job);
    registry.finish(job, { status: "success", finalReply: "ok", steps: 1 });
    const after = registry.append(job, "message", { content: "不该出现" });
    assert.equal(after, null);
    assert.equal(store.loadEvents(job.id).length, 0);
    store.close();
  } finally {
    cleanup();
  }
});

test("保留策略不清理仍在跑的 job", () => {
  const { path, cleanup } = tempDbPath();
  try {
    // retentionMs = 0：所有"已结束"的 job 都算过期
    const store = new JobStore({ path, retentionMs: 0, maxJobs: 100 });
    const registry = new JobRegistry({ store });

    const finished = registry.create({ conversationId: "c1", agentId: "a", userMessage: "done" });
    registry.markRunning(finished);
    registry.finish(finished, { status: "success", finalReply: "ok", steps: 1 });

    const running = registry.create({ conversationId: "c2", agentId: "a", userMessage: "running" });
    registry.markRunning(running);
    registry.append(running, "tool_call", { id: "c", name: "t", arguments: "{}" });

    const removed = store.reap({ retentionMs: 0, now: Date.now() + 1000 });
    const ids = store.loadJobs().map((job) => job.id);
    assert.ok(removed >= 1, "过期终态 job 应被清理");
    assert.ok(!ids.includes(finished.id), "已结束且过期的应被清掉");
    assert.ok(ids.includes(running.id), "仍在跑的不能被清掉");
    store.close();
  } finally {
    cleanup();
  }
});

test("落库文件真的被创建（不是静默退化成内存）", () => {
  const { path, cleanup } = tempDbPath();
  try {
    const store = new JobStore({ path });
    store.createJob({
      id: "job_x_1",
      conversationId: "c",
      agentId: "a",
      userMessage: "x",
      status: "queued",
      createdAt: Date.now(),
    });
    assert.ok(existsSync(path), "落库文件应存在");
    assert.equal(store.stats().persistent, true);
    assert.equal(store.stats().jobs, 1);
    store.close();
  } finally {
    cleanup();
  }
});

test("内存模式（:memory:）不落盘，供测试与关闭落库时使用", () => {
  const store = new JobStore({ path: ":memory:" });
  const registry = new JobRegistry({ store });
  const job = registry.create({ conversationId: "c", agentId: "a", userMessage: "x" });
  registry.markRunning(job);
  registry.append(job, "message", { content: "hi" });
  registry.finish(job, { status: "success", finalReply: "hi", steps: 1 });
  assert.equal(store.stats().persistent, false);
  assert.equal(store.loadEvents(job.id).length, 1);
  store.close();
});

test("中断的 job 恢复后仍保留崩溃前的事件（排障证据）", () => {
  const { path, cleanup } = tempDbPath();
  try {
    const store = new JobStore({ path });
    const registry = new JobRegistry({ store });
    const job = registry.create({ conversationId: "conv-i", agentId: "a", userMessage: "跑到一半" });
    registry.markRunning(job);
    registry.append(job, "tool_call", { id: "c1", name: "canvas_overview", arguments: "{}" });
    registry.append(job, "tool_result", { id: "c1", name: "canvas_overview", ok: true, result: "{}" });
    registry.append(job, "thought_delta", { delta: "接下来" });
    // 不 finish：模拟崩溃
    store.close();

    const store2 = new JobStore({ path });
    const registry2 = new JobRegistry({ store: store2 });
    registry2.restore();
    const restored = registry2.get(job.id);
    assert.equal(restored.status, "interrupted");
    assert.equal(restored.events.length, 3, "中断前落库的事件必须还在");
    assert.deepEqual(
      restored.events.map((event) => event.type),
      ["tool_call", "tool_result", "thought_delta"],
    );
    // 续传游标要能继续用：取 id > 2 应只剩最后一条
    assert.equal(registry2.eventsAfter(restored, 2).length, 1);
    store2.close();
  } finally {
    cleanup();
  }
});

test("interrupted 属于终态：不再接受新事件", () => {
  const { path, cleanup } = tempDbPath();
  try {
    const store = new JobStore({ path });
    const registry = new JobRegistry({ store });
    const job = registry.create({ conversationId: "conv-t", agentId: "a", userMessage: "x" });
    registry.markRunning(job);
    store.close();

    const store2 = new JobStore({ path });
    const registry2 = new JobRegistry({ store: store2 });
    registry2.restore();
    const restored = registry2.get(job.id);
    assert.equal(restored.status, "interrupted");
    // 终态 job 不能继续追加事件（否则前端会看到"已中断"却又有新事件，无法收尾）
    assert.equal(registry2.append(restored, "message", { content: "不该有" }), null);
    store2.close();
  } finally {
    cleanup();
  }
});

test("不带 store 时纯内存工作（落库关闭的路径）", () => {
  const registry = new JobRegistry({});
  const job = registry.create({ conversationId: "c", agentId: "a", userMessage: "x" });
  registry.markRunning(job);
  assert.ok(registry.append(job, "message", { content: "hi" }));
  registry.finish(job, { status: "success", finalReply: "hi", steps: 1 });
  assert.equal(registry.get(job.id).status, "success");
  assert.equal(registry.restore(), 0, "无 store 时 restore 应为空操作");
});

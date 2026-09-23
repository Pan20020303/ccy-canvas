/**
 * 会话世代号（sessionId 唯一化）的回归测试。
 *
 * 背景：DSH 把会话按 cwd 落盘，`agents.create({sessionId})` 在 id 已存在时直接抛
 * `session "…" already exists`，而 SDK 没有"复用已有会话"的接口。桥重启/回收后
 * 新建 runtime 内存是空的、磁盘还在，于是同一个 conversation_id 必然撞名 →
 * 任务整体失败（用户看到"服务暂时不可用"）。
 *
 * 修法是给每次新建 runtime 的会话加世代号。这里钉住三条容易错的性质：
 *   1. 首个 runtime 用裸 conversation_id（不无谓改名）
 *   2. 回收后重建必须换新世代（否则又撞磁盘）
 *   3. reserveGeneration 与 acquire 必须得到**同一个** sessionId
 *      （不一致会导致事件永不匹配、前端一直转圈）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentRuntimePool } from "../lib/runtime-pool.mjs";

/** 构造一个不真正拉起 dsh 的池子：只测世代/工作区的记账逻辑。 */
function makePool() {
  const dir = mkdtempSync(join(tmpdir(), "ccy-pool-"));
  const pool = new AgentRuntimePool({
    dshBin: "unused",
    profile: "ccy",
    workspaceRoot: dir,
    log: () => {},
  });
  // 替掉真实 runtime：只要 start() 不炸即可。
  pool._testSpawn = true;
  return {
    pool,
    cleanup: () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          rmSync(dir, { recursive: true, force: true });
          return;
        } catch {
          // Windows 句柄延迟
        }
      }
    },
  };
}

test("首个 runtime 用裸 conversation_id", () => {
  const { pool, cleanup } = makePool();
  try {
    const id = pool.reserveGeneration("conv-a");
    assert.equal(id, "conv-a");
  } finally {
    cleanup();
  }
});

test("第二轮起用唯一后缀，且同进程内互不相同", () => {
  const { pool, cleanup } = makePool();
  try {
    assert.equal(pool.reserveGeneration("conv-b"), "conv-b");
    const second = pool.reserveGeneration("conv-b");
    const third = pool.reserveGeneration("conv-b");
    assert.notEqual(second, "conv-b", "第二轮必须换名，否则撞磁盘上的旧会话");
    assert.notEqual(second, third, "同进程内多次预占必须互不相同");
    assert.ok(second.startsWith("conv-b-"), `后缀应以会话 id 开头：${second}`);
  } finally {
    cleanup();
  }
});

test("跨进程唯一：新池子（模拟重启）的第一轮也不是裸 id 之外的老名", () => {
  // 重启后 generations 归零，所以第一轮会拿裸 id —— 这与磁盘上那个旧会话同名，
  // 仍然会撞。这里记录已知限制：唯一性只在"同一会话的第二次预占起"生效，
  // 所以对话进行中的重建（回收/换 runtime）是安全的；纯粹的进程重启需要
  // 靠 DSH 侧清理或接受一次失败。见 README 的说明。
  const { pool, cleanup } = makePool();
  try {
    const first = pool.reserveGeneration("conv-h");
    assert.equal(first, "conv-h");
    const rotated = pool.reserveGeneration("conv-h");
    assert.notEqual(rotated, first);
  } finally {
    cleanup();
  }
});

test("不同会话各自独立计数", () => {
  const { pool, cleanup } = makePool();
  try {
    assert.equal(pool.reserveGeneration("a"), "a");
    assert.equal(pool.reserveGeneration("b"), "b");
    assert.notEqual(pool.reserveGeneration("a"), "a");
    assert.notEqual(pool.reserveGeneration("b"), "b");
  } finally {
    cleanup();
  }
});

test("sessionIdFor 与 reserveGeneration 的结果一致（不一致会让事件永不匹配）", () => {
  const { pool, cleanup } = makePool();
  try {
    const reserved = pool.reserveGeneration("conv-c");
    assert.equal(pool.sessionIdFor("conv-c"), reserved);
    const second = pool.reserveGeneration("conv-c");
    assert.equal(pool.sessionIdFor("conv-c"), second);
  } finally {
    cleanup();
  }
});

test("释放后不退回裸 id（回退会重新撞上磁盘里的旧会话）", () => {
  const { pool, cleanup } = makePool();
  try {
    pool.reserveGeneration("conv-d");
    const second = pool.reserveGeneration("conv-d");
    assert.equal(pool.release("conv-d"), false);
    const third = pool.reserveGeneration("conv-d");
    assert.notEqual(third, "conv-d", "不能退回裸 id");
    assert.notEqual(third, second, "也不能复用上一轮的名字");
  } finally {
    cleanup();
  }
});

test("工作区路径始终按裸 conversation_id（世代不影响画布目录）", () => {
  const { pool, cleanup } = makePool();
  try {
    const before = pool.workspaceOf("conv-e");
    pool.reserveGeneration("conv-e");
    pool.reserveGeneration("conv-e");
    const after = pool.workspaceOf("conv-e");
    assert.equal(before, after, "工作区必须稳定，否则画布/技能文件会分散到不同目录");
    assert.ok(after.endsWith("conv-e"), `工作区目录应基于裸 id：${after}`);
  } finally {
    cleanup();
  }
});

test("回收 stale entry 后仍不复用旧会话名（模拟 runtime 重建）", () => {
  const { pool, cleanup } = makePool();
  try {
    pool.reserveGeneration("conv-f");
    pool.entries.set("conv-f", {
      runtime: { disposed: false },
      lastUsed: Date.now(),
      timer: null,
      workspace: pool.workspaceFor("conv-f"),
      generation: 1,
      sessionId: "conv-f",
    });
    pool.entries.clear();
    const next = pool.reserveGeneration("conv-f");
    assert.notEqual(next, "conv-f", "重建必须换名，否则撞磁盘上那个旧会话");
  } finally {
    cleanup();
  }
});

test("seedFromPersistedSessions：磁盘上已有的会话名会被预置成已用", () => {
  const { pool, cleanup } = makePool();
  const home = mkdtempSync(join(tmpdir(), "ccy-dsh-home-"));
  try {
    // 复刻 DSH 的落盘布局：
    //   <home>/sessions/--<encoded cwd>--/<sessionId>/
    const workspaceTag = "agent-bridge";
    const bucket = join(home, "sessions", `--C-users-me-code-${workspaceTag}--`);
    mkdirSync(join(bucket, "11111111-1111-1111-1111-111111111111"), { recursive: true });
    mkdirSync(join(bucket, "22222222-2222-2222-2222-222222222222-sabc2"), { recursive: true });

    const seeded = pool.seedFromPersistedSessions(home);
    assert.ok(seeded >= 2, `应至少推导出 2 个已用名，实际 ${seeded}`);

    // 关键：这两个会话的第一轮**不能**再拿裸 id（否则又撞名）
    const first = pool.reserveGeneration("11111111-1111-1111-1111-111111111111");
    assert.notEqual(first, "11111111-1111-1111-1111-111111111111");
    assert.ok(first.startsWith("11111111-1111-1111-1111-111111111111-"));
  } finally {
    rmSync(home, { recursive: true, force: true });
    cleanup();
  }
});

test("seedFromPersistedSessions 容忍 DSH_HOME 不存在 / 目录为空", () => {
  const { pool, cleanup } = makePool();
  try {
    // 不存在的目录 → 不抛错、返回 0
    assert.equal(pool.seedFromPersistedSessions(join(tmpdir(), "ccy-definitely-missing-xyz")), 0);
    // 存在但为空 → 也是 0
    const empty = mkdtempSync(join(tmpdir(), "ccy-empty-home-"));
    try {
      assert.equal(pool.seedFromPersistedSessions(empty), 0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    cleanup();
  }
});

/**
 * AgentRuntimePool —— conversation ↔ DSH runtime 进程的映射与回收。
 *
 * 一个 conversation 对应一个常驻 runtime：DSH 的会话状态（模型上下文、压缩、
 * 每用户记忆）都在进程内，复用进程才能保持连续对话。空闲超时后回收，避免
 * 内网常驻服务被无上限的子进程拖垮。
 *
 * 注意：SDK 协议没有"关掉单个 session"的方法，所以释放一个 conversation 只能
 * 连同它的 runtime 一起 kill —— 这也是池子必须存在的原因（否则每个会话都常驻一个进程）。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import { AgentRuntime } from "./agent-runtime.mjs";

/** 会话工作区里必备的画布工具文件（从 canvas-cli 目录复制过去）。 */
const WORKSPACE_SEED_FILES = [
  "canvas.mjs",
  "canvas-core.mjs",
  "canvas-tools.mjs",
  "mcp-server.mjs",
  "AGENTS.md",
];

/** conversation id 可能是任意 UUID/字符串，转成安全的目录名。 */
function sanitizeSegment(value) {
  const cleaned = String(value ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return cleaned || "session";
}

export class AgentRuntimePool {
  /**
   * @param {{ dshBin: string, profile: string, workspaceRoot: string,
   *           provider?: string, model?: string, reasoningEffort?: string, maxTokens?: number,
   *           dshHome?: string, patchFile?: string, env?: Record<string,string>,
   *           canvasCliDir?: string, idleMs?: number, maxRuntimes?: number, log?: (...p: unknown[]) => void }} options
   */
  constructor(options) {
    this.dshBin = options.dshBin;
    this.profile = options.profile;
    this.workspaceRoot = options.workspaceRoot;
    this.canvasCliDir = options.canvasCliDir;
    this.provider = options.provider;
    this.model = options.model;
    this.reasoningEffort = options.reasoningEffort;
    this.maxTokens = options.maxTokens;
    this.dshHome = options.dshHome;
    this.patchFile = options.patchFile;
    this.env = options.env ?? {};
    this.idleMs = options.idleMs ?? 15 * 60 * 1000;
    this.maxRuntimes = options.maxRuntimes ?? 8;
    this.log = options.log ?? (() => {});

    /** @type {Map<string, { runtime: AgentRuntime, lastUsed: number, timer: any, workspace: string, generation: number }>} */
    this.entries = new Map();
    /**
     * 每个会话已预占过多少轮（只用于同进程内互不相同）。
     * 跨重启的唯一性靠 sessionId 里的时间戳，见 reserveGeneration。
     */
    this.generations = new Map();
    /** 各会话最近预占的 sessionId（翻译器/SSE 过滤要按它比对）。 */
    this.sessionIds = new Map();
  }

  /**
   * 每个 conversation 一个独立工作区目录：画布状态、技能文件互不串味，
   * DSH 的 fs 沙箱边界也天然按会话隔离。
   */
  workspaceFor(conversationId) {
    return join(this.workspaceRoot, sanitizeSegment(conversationId));
  }

  /** 准备会话工作区：建目录 + 铺好画布工具文件（幂等）。 */
  #prepareWorkspace(conversationId) {
    const dir = this.workspaceFor(conversationId);
    mkdirSync(dir, { recursive: true });
    if (this.canvasCliDir && existsSync(this.canvasCliDir)) {
      const available = new Set(readdirSync(this.canvasCliDir));
      for (const name of WORKSPACE_SEED_FILES) {
        if (!available.has(name)) continue;
        const target = join(dir, name);
        if (existsSync(target)) continue;
        try {
          copyFileSync(join(this.canvasCliDir, name), target);
        } catch (err) {
          this.log(`[pool] 复制 ${name} 到会话工作区失败: ${err?.message ?? err}`);
        }
      }
    }
    return dir;
  }

  /**
   * 从 DSH 已落盘的会话推导"哪些 sessionId 已被占用"。
   *
   * 为什么需要：reserveGeneration 的计数器跨重启会归零，于是重启后第一轮又拿裸
   * conversation_id 去撞磁盘上那个旧会话（实测就是这样炸的）。DSH 会把会话按 cwd
   * 落盘：`<dshHome>/sessions/--<编码后的 cwd>--/<sessionId>/`，所以扫一遍
   * `<sessionId>` 目录就能知道哪些名字用过，把它们预置成"已用一轮"。
   *
   * 作用域：只扫 workspaceRoot 对应的那个目录（cwd 编码规则不是公开契约，
   * 所以用"包含工作区目录名"的宽松匹配；匹配不到就退化成扫全部，
   * 宁可多算一轮也不会漏 —— 漏了就是撞名崩溃）。
   */
  seedFromPersistedSessions(dshHome) {
    const sessionsRoot = join(dshHome, "sessions");
    if (!existsSync(sessionsRoot)) return 0;

    const workspaceTag = basename(this.workspaceRoot).toLowerCase();
    let buckets = [];
    try {
      buckets = readdirSync(sessionsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      return 0;
    }
    const scoped = buckets.filter((entry) => entry.name.toLowerCase().includes(workspaceTag));
    const targets = scoped.length ? scoped : buckets;

    let seeded = 0;
    for (const bucket of targets) {
      const bucketPath = join(sessionsRoot, bucket.name);
      let children = [];
      try {
        children = readdirSync(bucketPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) {
        if (!child.isDirectory()) continue;
        // 我们的唯一后缀形如 -s<base36><n>；去掉它得到基名（= conversation_id）。
        const base = String(child.name).replace(/-s[0-9a-z]+$/i, "");
        // 已记录过就跳过（同一会话可能有多个历史 sessionId）
        if ((this.generations.get(base) ?? 0) > 0) continue;
        this.generations.set(base, 1); // 标记"裸 id 已用过"
        this.sessionIds.set(base, child.name);
        seeded += 1;
      }
    }
    if (seeded) this.log(`[pool] 从磁盘会话推导出 ${seeded} 个已用过的会话名（重启后不会撞名）`);
    return seeded;
  }

  /** 取（或创建）某会话的 runtime。sessionId 由调用方用 reserveGeneration 预占。 */
  async acquire(conversationId, sessionId) {
    const key = String(conversationId);
    const existing = this.entries.get(key);
    if (existing && !existing.runtime.disposed) {
      this.#touch(key, existing);
      return existing.runtime;
    }
    await this.#evictIfNeeded();
    const workspace = this.#prepareWorkspace(key);
    const runtime = new AgentRuntime({
      dshBin: this.dshBin,
      profile: this.profile,
      workspace,
      provider: this.provider,
      model: this.model,
      reasoningEffort: this.reasoningEffort,
      maxTokens: this.maxTokens,
      dshHome: this.dshHome,
      patchFile: this.patchFile,
      env: this.env,
      label: key,
      log: this.log,
    });
    await runtime.start();
    // sessionId 由 reserveGeneration 预占，这里只读不改（两处必须一致，
    // 否则翻译器按另一个 id 过滤事件，前端会一直转圈）。
    const generation = this.generations.get(key) ?? 1;
    const entry = { runtime, lastUsed: Date.now(), timer: null, workspace, generation, sessionId: sessionId ?? key };
    this.entries.set(key, entry);
    this.#touch(key, entry);
    this.log(`[pool] 新建 runtime（会话 ${key} 第 ${generation} 代），当前 ${this.entries.size} 个`);
    return runtime;
  }

  /** 已建 runtime 的会话工作区（未建则按规则推导，不创建）。 */
  workspaceOf(conversationId) {
    const entry = this.entries.get(String(conversationId));
    return entry?.workspace ?? this.workspaceFor(conversationId);
  }

  /**
   * 预占一个 DSH sessionId（建 job 时用，acquire 复用同一个值）。
   *
   * 为什么不能直接用 conversation_id：DSH 把会话**按 cwd 落盘**，而
   * `ctx.agents.create({ sessionId, meta:{ cwd } })` 在 id 已存在时直接抛
   * `session "…" already exists`（SDK 没有"复用已有会话"的接口）。
   * 桥重启/回收后新建的 runtime 内存是空的、磁盘却还留着同一个 id → 必然撞名，
   * 表现为整个任务失败（用户看到"服务暂时不可用"）。
   *
   * 为什么用「时间戳+序号」而不是进程内计数器：计数器**跨重启会归零**，
   * 下次又拿裸 id 去撞磁盘上那个旧会话 —— 等于没修。
   * 时间戳天然跨重启唯一，且不需要任何持久化状态。
   *
   * 首个 runtime 仍用裸 conversation_id：目录名好认，且这是最常见路径。
   * 工作区始终按裸 id（见 workspaceFor），所以画布/技能文件不受影响。
   */
  reserveGeneration(conversationId) {
    const key = String(conversationId);
    const used = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, used);
    // used===1 且磁盘上没有过 → 裸 id 可用（目录名好认，也是首次会话的常见路径）。
    // 只要磁盘上已经有过（seedFromPersistedSessions 预置成 1），这里就会直接带后缀。
    const sessionId = used === 1 ? key : `${key}-s${Date.now().toString(36)}${used}`;
    this.sessionIds.set(key, sessionId);
    return sessionId;
  }

  /** 最近一次为该会话预占的 sessionId（供 sessionIdFor 读取）。 */
  sessionIdFor(conversationId) {
    const key = String(conversationId);
    return this.sessionIds.get(key) ?? key;
  }

  #touch(key, entry) {
    entry.lastUsed = Date.now();
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      const current = this.entries.get(key);
      if (!current || current.runtime !== entry.runtime) return;
      this.log(`[pool] 空闲回收 runtime（会话 ${key}）`);
      this.release(key);
    }, this.idleMs);
    if (typeof entry.timer.unref === "function") entry.timer.unref();
  }

  async #evictIfNeeded() {
    if (this.entries.size < this.maxRuntimes) return;
    // 回收最久未用的一个，为新会话腾位。
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [key, entry] of this.entries) {
      if (entry.lastUsed < oldestAt) {
        oldestAt = entry.lastUsed;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      this.log(`[pool] 达到上限 ${this.maxRuntimes}，回收最久未用会话 ${oldestKey}`);
      this.release(oldestKey);
    }
  }

  /** 释放并关停某会话的 runtime（优雅 shutdown，失败则硬杀）。 */
  release(conversationId) {
    const key = String(conversationId);
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    if (entry.timer) clearTimeout(entry.timer);
    void entry.runtime.shutdown().catch(() => entry.runtime.kill());
    return true;
  }

  /** 关停全部（进程退出时调用）。 */
  async releaseAll() {
    await Promise.all([...this.entries.keys()].map((key) => this.release(key)));
  }

  stats() {
    return {
      runtimes: this.entries.size,
      maxRuntimes: this.maxRuntimes,
      idleMs: this.idleMs,
      conversations: [...this.entries.keys()],
    };
  }
}

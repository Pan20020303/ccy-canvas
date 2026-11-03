/**
 * JobRegistry —— 智能体运行的事件日志（内存 + 可选落库）。
 *
 * 对应 Go 侧 durable job 的最小语义：POST 创建 → GET 状态 → GET SSE 增量重放。
 * 传入 JobStore 后，每个状态变更与事件都会落库，进程重启可恢复历史
 * （见 job-store.mjs 的重启语义：残留的 running 会标成 interrupted）。
 *
 * 取消语义（重要）：DSH 的 SDK 协议**没有 per-prompt 取消**，所以：
 *   - `cancel()` 只做"软取消"：停止转发后续事件、把状态置为 cancelled；
 *   - runtime 仍在后台跑完那一轮（静默消耗 token）；
 *   - 要真取消，调用方应 release 该 conversation 的 runtime（pool.release）。
 * 这个降级必须让前端知道：停止 ≠ 立即释放算力。
 */

import { TERMINAL_STATUSES } from "./job-store.mjs";

const TERMINAL = TERMINAL_STATUSES;

export class JobRegistry {
  /**
   * @param {{ maxEventsPerJob?: number, log?: (...p: unknown[]) => void, store?: import('./job-store.mjs').JobStore }} options
   */
  constructor({ maxEventsPerJob = 5000, log = () => {}, store = null } = {}) {
    this.jobs = new Map();
    this.nextId = 1;
    this.maxEventsPerJob = maxEventsPerJob;
    this.log = log;
    this.store = store;
  }

  /**
   * 从落库的历史恢复内存态。必须在接受新任务之前调用。
   * 恢复的 job 会保留自己的事件序号（nextEventId 接着最大的走），
   * 这样前端手上的 lastEventId 游标在重启后依然有效。
   */
  restore() {
    if (!this.store) return 0;
    const rows = this.store.loadJobs();
    let restored = 0;
    for (const row of rows) {
      // 中断的 job 也要恢复它的事件：崩溃前已落库的那些恰恰是最有价值的排障证据
      // （能看出任务停在哪一步），不能因为状态是 interrupted 就丢掉。
      const events = this.store.loadEvents(row.id);
      const maxEventId = events.reduce((max, event) => Math.max(max, event.id), 0);
      this.jobs.set(row.id, {
        id: row.id,
        conversationId: row.conversationId,
        agentId: row.agentId,
        userMessage: row.userMessage,
        request: {},
        status: row.status,
        events,
        nextEventId: maxEventId + 1,
        finalReply: row.finalReply,
        errorMessage: row.errorMessage,
        steps: row.steps,
        createdAt: row.createdAt,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        cancelled: row.status === "cancelled",
        toolNames: new Map(),
      });
      restored += 1;
      // job id 形如 job_xxx_<seq>，据此把自增计数器推到已有最大值之后。
      const match = /_(\d+)$/.exec(row.id);
      if (match) this.nextId = Math.max(this.nextId, Number(match[1]) + 1);
    }
    if (restored) this.log(`[jobs] 已恢复 ${restored} 个历史 job`);
    return restored;
  }

  create({ conversationId, agentId, userMessage, request }) {
    const id = `job_${Date.now().toString(36)}_${this.nextId++}`;
    const job = {
      id,
      conversationId: String(conversationId ?? ""),
      agentId: String(agentId ?? ""),
      userMessage: String(userMessage ?? ""),
      request: request ?? {},
      status: "queued",
      events: [],
      nextEventId: 1,
      finalReply: "",
      errorMessage: "",
      steps: 0,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      cancelled: false,
      toolNames: new Map(),
    };
    this.jobs.set(id, job);
    this.store?.createJob(job);
    return job;
  }

  get(jobId) {
    return this.jobs.get(String(jobId));
  }

  /** 追加一条事件；已软取消或终态的 job 丢弃后续事件。 */
  append(job, eventType, data) {
    if (!job || job.cancelled) return null;
    if (TERMINAL.has(job.status)) return null;
    const record = { id: job.nextEventId++, type: eventType, data, at: Date.now() };
    job.events.push(record);
    if (job.events.length > this.maxEventsPerJob) {
      job.events.splice(0, job.events.length - this.maxEventsPerJob);
    }
    this.store?.appendEvent(job.id, record);
    return record;
  }

  markRunning(job) {
    if (!job) return;
    job.status = "running";
    job.startedAt = job.startedAt ?? Date.now();
    this.store?.markRunning(job.id);
  }

  finish(job, { status, finalReply = "", errorMessage = "", steps = 0 }) {
    if (!job) return;
    job.status = status;
    job.finalReply = finalReply;
    job.errorMessage = errorMessage;
    job.steps = steps;
    job.finishedAt = Date.now();
    this.store?.finishJob(job.id, { status, finalReply, errorMessage, steps });
  }

  /**
   * 软取消：停止转发事件并标记 cancelled。runtime 不会被关掉 ——
   * 需要真取消请由调用方 release 该会话的 runtime。
   */
  cancel(job) {
    if (!job || TERMINAL.has(job.status)) return false;
    job.cancelled = true;
    this.append(job, "error", { message: "任务已取消（DSH 协议无单轮取消，后台轮次可能仍会跑完）" });
    this.finish(job, { status: "cancelled", errorMessage: "任务已取消" });
    return true;
  }

  /** 进程退出时把仍在跑的 job 明确收尾，避免下次启动把它们误标成 interrupted。 */
  finishRunningOnShutdown(message = "bridge 关闭，任务被中断") {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.status !== "running" && job.status !== "queued") continue;
      this.append(job, "error", { message });
      this.finish(job, { status: "interrupted", errorMessage: message });
      count += 1;
    }
    if (count) this.log(`[jobs] 关停时收尾 ${count} 个未完成的 job`);
    return count;
  }

  /** 取 id > after 的事件（SSE 断线续传）。 */
  eventsAfter(job, after) {
    if (!job) return [];
    return job.events.filter((event) => event.id > after);
  }

  state(job) {
    if (!job) return null;
    return {
      job_id: job.id,
      conversation_id: job.conversationId,
      status: job.status,
      final_reply: job.finalReply,
      error_message: job.errorMessage,
      steps: job.steps,
      event_count: job.events.length,
    };
  }

  /** 清理过老的终态 job，避免内存无界增长。 */
  reap({ olderThanMs = 6 * 60 * 60 * 1000 } = {}) {
    const cutoff = Date.now() - olderThanMs;
    let removed = 0;
    for (const [id, job] of this.jobs) {
      if (TERMINAL.has(job.status) && (job.finishedAt ?? job.createdAt) < cutoff) {
        this.jobs.delete(id);
        removed += 1;
      }
    }
    // 落库侧按自己的保留策略清理（默认 7 天 / 2000 条）
    this.store?.reap();
    if (removed) this.log(`[jobs] 从内存回收 ${removed} 个历史 job`);
    return removed;
  }
}

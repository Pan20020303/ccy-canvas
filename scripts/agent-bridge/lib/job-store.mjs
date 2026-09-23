/**
 * JobStore —— 桥的 job 与事件日志落库。
 *
 * 为什么需要：原先 job 只活在内存里，bridge 重启就丢 —— 前端刷新/重连后
 * 只能看到一个悬空的 job id。Go 侧有自己的事件表，但桥这一层的因果
 * （哪次 run 产生了哪些工具调用）必须自己留痕，否则排障时无从对照。
 *
 * 存储选型：node:sqlite（Node ≥ 22 内置）。不用 JSONL 自己拼，因为：
 *   - 事件是追加写且可能很长，SQLite 给原子写 + WAL，不用处理半写坏的文件；
 *   - 需要按 (job_id, id) 顺序读、按 job 查、按时间清理 —— 这些用 SQL 一行解决。
 * 也不引入任何第三方依赖。
 *
 * 重启语义（重要）：进程重启时不可能有 job 还在跑（DSH runtime 随进程一起死），
 * 所以启动时把残留的 running/queued 一律标成 `interrupted`。**不能标成 success** ——
 * 那一轮确实没跑完，前端应当看到"被中断"，而不是收到一个假的完成。
 */

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const TERMINAL_STATUSES = new Set(["success", "error", "cancelled", "interrupted"]);

export class JobStore {
  /**
   * @param {{ path?: string, retentionMs?: number, maxJobs?: number, log?: (...p: unknown[]) => void }} options
   *        path 为 ":memory:" 或省略时使用内存库（默认关闭持久化、测试用）。
   */
  constructor({ path = ":memory:", retentionMs = 7 * 24 * 60 * 60 * 1000, maxJobs = 2000, log = () => {} } = {}) {
    this.path = path;
    this.persistent = path !== ":memory:";
    this.retentionMs = retentionMs;
    this.maxJobs = maxJobs;
    this.log = log;

    if (this.persistent) mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("pragma journal_mode = WAL");
    this.db.exec("pragma synchronous = NORMAL");
    this.#migrate();
  }

  #migrate() {
    this.db.exec(`
      create table if not exists jobs (
        id              text primary key,
        conversation_id text not null,
        agent_id        text not null default '',
        user_message    text not null default '',
        status          text not null,
        final_reply     text not null default '',
        error_message   text not null default '',
        steps           integer not null default 0,
        created_at      integer not null,
        started_at      integer,
        finished_at     integer,
        interrupted     integer not null default 0
      );
      create table if not exists job_events (
        job_id     text not null,
        id         integer not null,
        type       text not null,
        data       text not null,
        at         integer not null,
        primary key (job_id, id)
      );
      create index if not exists idx_job_events_job on job_events(job_id, id);
      create index if not exists idx_jobs_created on jobs(created_at);
    `);
  }

  createJob(job) {
    this.db
      .prepare(
        `insert into jobs (id, conversation_id, agent_id, user_message, status, created_at)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(job.id, String(job.conversationId ?? ""), String(job.agentId ?? ""), String(job.userMessage ?? ""), job.status ?? "queued", job.createdAt ?? Date.now());
  }

  appendEvent(jobId, event) {
    this.db
      .prepare(`insert or replace into job_events (job_id, id, type, data, at) values (?, ?, ?, ?, ?)`)
      .run(jobId, event.id, event.type, JSON.stringify(event.data ?? {}), event.at ?? Date.now());
  }

  markRunning(jobId) {
    this.db
      .prepare(`update jobs set status = 'running', started_at = coalesce(started_at, ?) where id = ?`)
      .run(Date.now(), jobId);
  }

  finishJob(jobId, { status, finalReply = "", errorMessage = "", steps = 0 }) {
    this.db
      .prepare(
        `update jobs set status = ?, final_reply = ?, error_message = ?, steps = ?, finished_at = ? where id = ?`,
      )
      .run(status, finalReply, errorMessage, steps, Date.now(), jobId);
  }

  /**
   * 载入历史 job（供进程重启后恢复内存态）。
   * 运行中的 job 一律标成 interrupted 后返回 —— 见文件头的重启语义说明。
   */
  loadJobs({ includeInterrupted = true, now = Date.now() } = {}) {
    const rows = this.db.prepare(`select * from jobs order by created_at asc`).all();
    const jobs = [];
    for (const row of rows) {
      let status = row.status;
      let interrupted = Boolean(row.interrupted);
      // 注意：不能直接用 row.error_message —— UPDATE 之后 row 还是旧快照，
      // 早先的写法把更新后的原因丢掉了，前端看到的中断原因是空的。
      let errorMessage = row.error_message;
      if (status === "running" || status === "queued") {
        if (!includeInterrupted) continue;
        const reason = errorMessage || "bridge 重启，任务被中断";
        status = "interrupted";
        interrupted = true;
        errorMessage = reason;
        this.db
          .prepare(`update jobs set status = 'interrupted', interrupted = 1, finished_at = ?, error_message = ? where id = ?`)
          .run(now, reason, row.id);
      }
      jobs.push({
        id: row.id,
        conversationId: row.conversation_id,
        agentId: row.agent_id,
        userMessage: row.user_message,
        status,
        finalReply: row.final_reply,
        errorMessage,
        steps: row.steps,
        createdAt: row.created_at,
        startedAt: row.started_at ?? null,
        finishedAt: row.finished_at ?? null,
        interrupted,
      });
    }
    if (rows.length) this.log(`[store] 已载入 ${rows.length} 个历史 job（其中中断的会标记为 interrupted）`);
    return jobs;
  }

  loadEvents(jobId) {
    return this.db
      .prepare(`select id, type, data, at from job_events where job_id = ? order by id asc`)
      .all(jobId)
      .map((row) => {
        let data;
        try {
          data = JSON.parse(row.data);
        } catch {
          data = {};
        }
        return { id: row.id, type: row.type, data, at: row.at };
      });
  }

  /** 清理过期 job 及其事件，并保证不超过 maxJobs。now 可注入以便测试。 */
  reap({ retentionMs = this.retentionMs, maxJobs = this.maxJobs, now = Date.now() } = {}) {
    const cutoff = now - retentionMs;
    const expired = this.db
      .prepare(
        `select id from jobs
         where finished_at is not null and finished_at <= ? and status not in ('running', 'queued')`,
      )
      .all(cutoff)
      .map((row) => row.id);

    const overflow = this.db
      .prepare(`select id from jobs where status not in ('running', 'queued') order by created_at desc limit -1 offset ?`)
      .all(maxJobs)
      .map((row) => row.id);

    const doomed = [...new Set([...expired, ...overflow])];
    if (!doomed.length) return 0;
    const delEvents = this.db.prepare(`delete from job_events where job_id = ?`);
    const delJob = this.db.prepare(`delete from jobs where id = ?`);
    for (const id of doomed) {
      delEvents.run(id);
      delJob.run(id);
    }
    this.log(`[store] 清理 ${doomed.length} 个过期 job`);
    return doomed.length;
  }

  stats() {
    const jobs = this.db.prepare(`select count(*) as n from jobs`).get().n;
    const events = this.db.prepare(`select count(*) as n from job_events`).get().n;
    return { persistent: this.persistent, path: this.path, jobs, events };
  }

  close() {
    try {
      this.db.close();
    } catch {
      // 忽略
    }
  }
}

export { TERMINAL_STATUSES };

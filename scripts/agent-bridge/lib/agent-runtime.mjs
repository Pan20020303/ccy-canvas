/**
 * AgentRuntime —— 一个常驻的 `dsh --profile sdk` 子进程，通过 stdio 讲 SDK JSON-RPC。
 *
 * 协议（@deepseek-ai/dsh-sdk-protocol）：
 *   请求： initialize / session/prompt / shutdown
 *   通知： session.event / session.status / subagent.started / subagent.finished
 * 帧格式：每行一个 JSON-RPC 2.0 消息，stdout 只承载协议。
 *
 * 已知限制（来自官方文档，直接决定上层语义）：
 *   1. 无线上的 per-prompt 取消 —— 客户端只能关掉 runtime 进程来放弃一轮；
 *      因此这里实现"软取消"：本进程停止转发该 session 的事件并丢弃后续事件，
 *      runtime 仍在跑（静默烧 token），需要硬取消就 dispose 整个 runtime。
 *   2. session.event 是**全 runtime 广播**，包含非 SDK 创建的会话，必须按 sessionId 过滤。
 *   3. session/prompt 是"入队收据"，不代表这一轮结束；结束要靠 turn/end 事件判定。
 */

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export class AgentRuntime extends EventEmitter {
  /**
   * @param {{ dshBin: string, profile: string, workspace: string, provider?: string, model?: string,
   *           reasoningEffort?: string, maxTokens?: number, env?: Record<string,string>, dshHome?: string,
   *           patchFile?: string, shutdownGraceMs?: number, log?: (...p: unknown[]) => void, label?: string }} options
   */
  constructor(options) {
    super();
    this.dshBin = options.dshBin;
    this.profile = options.profile;
    this.workspace = resolve(options.workspace);
    this.provider = options.provider ?? "deepseek-official";
    this.model = options.model ?? "deepseek-flash";
    this.reasoningEffort = options.reasoningEffort;
    this.maxTokens = options.maxTokens;
    this.extraEnv = options.env ?? {};
    this.dshHome = options.dshHome;
    // 画布 MCP 工具的挂载补丁：不写进用户 profile，保持"一次启动一层"的显式性。
    this.patchFile = options.patchFile ? resolve(options.patchFile) : null;
    this.shutdownGraceMs = options.shutdownGraceMs ?? 5000;
    this.log = options.log ?? (() => {});
    this.label = options.label ?? "agent-runtime";

    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.stderrTail = "";
    this.initialized = false;
    this.ready = null;
    this.disposed = false;
    this.stderrLines = [];
  }

  /** 启动并完成 initialize 握手；可重复调用（返回同一个 promise）。 */
  start() {
    if (this.ready) return this.ready;
    this.ready = this.#boot();
    return this.ready;
  }

  async #boot() {
    if (!existsSync(this.dshBin)) throw new Error(`找不到 dsh 入口: ${this.dshBin}`);
    const env = {
      ...process.env,
      ...(this.dshHome ? { DSH_HOME: this.dshHome } : {}),
      // 供 profile 里的 MCP 挂载补丁解析画布工作区（见 canvas-cli/ccy-mcp.patch.yml）。
      // 不设的话 cwd 会解析成 undefined，MCP 配置校验失败 → 整棵插件树加载失败。
      CCY_MCP_WORKSPACE: this.workspace,
      ...this.extraEnv,
    };
    this.child = spawn(
      process.execPath,
      [
        this.dshBin,
        "--profile",
        this.profile,
        ...(this.patchFile ? ["--patch", this.patchFile] : []),
      ],
      {
        cwd: this.workspace,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.#onStdout(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => this.#onStderr(chunk));
    this.child.on("exit", (code, signal) => {
      this.disposed = true;
      const reason = `agent runtime 退出（code=${code} signal=${signal}）`;
      for (const { reject } of this.pending.values()) reject(new Error(reason));
      this.pending.clear();
      this.emit("exit", { code, signal, stderr: this.stderrTail });
    });
    this.child.on("error", (err) => {
      this.log(`[${this.label}] spawn 失败: ${err.message}`);
    });

    const result = await this.#request("initialize", {
      cwd: this.workspace,
      provider: this.provider,
      model: this.model,
      ...(this.reasoningEffort ? { reasoningEffort: this.reasoningEffort } : {}),
      ...(this.maxTokens ? { maxTokens: this.maxTokens } : {}),
    });
    this.initialized = true;
    this.serverInfo = result?.serverInfo;
    this.log(`[${this.label}] initialized: ${JSON.stringify(this.serverInfo)} workspace=${this.workspace}`);
    return result;
  }

  #onStdout(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        this.log(`[${this.label}] 忽略非法协议帧: ${line.slice(0, 200)}`);
        continue;
      }
      if (frame.id !== undefined && frame.method === undefined) {
        const entry = this.pending.get(frame.id);
        if (entry) {
          this.pending.delete(frame.id);
          if (frame.error) {
            const err = new Error(`JSON-RPC ${frame.error.code}: ${frame.error.message}`);
            err.code = frame.error.code;
            err.data = frame.error.data;
            entry.reject(err);
          } else {
            entry.resolve(frame.result);
          }
        }
        continue;
      }
      if (frame.method) {
        // 通知
        this.emit("notification", frame);
        this.emit(frame.method, frame.params);
      }
    }
  }

  #onStderr(chunk) {
    this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    for (const line of chunk.split("\n")) {
      if (line.trim()) this.stderrLines.push({ at: Date.now(), line: line.trim() });
    }
    if (this.stderrLines.length > 200) this.stderrLines.splice(0, this.stderrLines.length - 200);
  }

  #request(method, params) {
    if (this.disposed) return Promise.reject(new Error("agent runtime 已退出"));
    const id = this.nextId++;
    const promise = new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
    });
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return promise;
  }

  /**
   * 入队一条用户消息。返回 { messageId }（入队收据，不代表这一轮结束）。
   * 结束判定由调用方监听 turn/end。
   */
  async prompt(sessionId, text) {
    await this.start();
    return this.#request("session/prompt", {
      sessionId,
      contentBlocks: [{ type: "text", text }],
    });
  }

  /** 优雅关停：协议 shutdown 会 dispose 整个 runtime 树并 exit 0。 */
  async shutdown() {
    if (this.disposed || !this.child) return;
    try {
      await Promise.race([
        this.#request("shutdown", {}),
        new Promise((resolvePromise) => setTimeout(resolvePromise, this.shutdownGraceMs)),
      ]);
    } catch {
      // shutdown 常常会先退出进程再回响应，属于正常
    }
    await this.#waitExit(this.shutdownGraceMs);
    if (!this.disposed) this.kill();
  }

  /** 硬杀（用于放弃一轮或回收空闲 runtime）。 */
  kill() {
    if (!this.child || this.disposed) return;
    try {
      this.child.kill();
    } catch {
      // 忽略
    }
  }

  #waitExit(timeoutMs) {
    if (this.disposed) return Promise.resolve();
    return new Promise((resolvePromise) => {
      const timer = setTimeout(() => {
        this.child?.kill();
        resolvePromise();
      }, timeoutMs);
      this.once("exit", () => {
        clearTimeout(timer);
        resolvePromise();
      });
    });
  }
}

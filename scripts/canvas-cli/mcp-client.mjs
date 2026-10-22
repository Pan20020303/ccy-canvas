/**
 * 极简 MCP stdio 客户端 —— 以子进程方式驱动 canvas MCP server。
 *
 * 用途：
 *   1) 命令行验证 MCP server（`node mcp-client.mjs --list` / `--call <tool> '<json>'`）
 *   2) 将来 Go/Node 侧 bridge 的参考实现（协议只有 initialize / tools/list / tools/call）
 *
 * 协议：stdio 上换行分隔的 JSON-RPC 2.0（MCP 2025-11-25）。
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

export class McpStdioClient {
  constructor({ serverScript = join(HERE, "mcp-server.mjs"), workspace, env = {}, name = "ccy-canvas" } = {}) {
    this.serverScript = serverScript;
    this.workspace = workspace;
    this.extraEnv = env;
    this.name = name;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.stderr = "";
    this.closed = false;
  }

  start() {
    this.child = spawn(process.execPath, [this.serverScript], {
      cwd: this.workspace,
      env: { ...process.env, CCY_WORKSPACE: this.workspace, ...this.extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.#onData(chunk));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    this.child.on("exit", (code) => {
      this.closed = true;
      for (const { reject } of this.pending.values()) {
        reject(new Error(`MCP server 退出（code=${code}）: ${this.stderr.trim().slice(-500)}`));
      }
      this.pending.clear();
    });
    return this;
  }

  #onData(chunk) {
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
        continue;
      }
      const entry = this.pending.get(frame.id);
      if (!entry) continue;
      this.pending.delete(frame.id);
      if (frame.error) entry.reject(new Error(`MCP 错误 ${frame.error.code}: ${frame.error.message}`));
      else entry.resolve(frame.result);
    }
  }

  request(method, params) {
    if (this.closed) return Promise.reject(new Error("MCP 连接已关闭"));
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return promise;
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: { roots: { listChanged: false } },
      clientInfo: { name: this.name, version: "0.1.0" },
    });
    this.notify("notifications/initialized", {});
    this.serverInfo = result?.serverInfo;
    return result;
  }

  async listTools() {
    const result = await this.request("tools/list", {});
    return result?.tools ?? [];
  }

  /** 调用工具；MCP 的 isError 不会被抛成异常，而是原样返回，方便观察模型看到的内容。 */
  async callTool(name, args = {}) {
    const result = await this.request("tools/call", { name, arguments: args });
    const text = (result?.content ?? [])
      .filter((block) => block?.type === "text")
      .map((block) => block.text)
      .join("\n");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    return { isError: Boolean(result?.isError), text, parsed };
  }

  async close() {
    if (this.child && !this.closed) {
      this.child.stdin.end();
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.child.kill();
          resolve();
        }, 2000);
        this.child.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

// ── CLI 模式 ─────────────────────────────────────────────────────────────────

function parseCli(argv) {
  const workspace = process.env.CCY_WORKSPACE ?? process.cwd();
  if (argv[0] === "--list") return { mode: "list", workspace };
  if (argv[0] === "--call") {
    const name = argv[1];
    const rawArgs = argv[2] ?? "{}";
    if (!name) {
      process.stderr.write("用法: node mcp-client.mjs --call <toolName> '<json args>'\n");
      process.exit(2);
    }
    let args;
    try {
      args = JSON.parse(rawArgs);
    } catch (err) {
      process.stderr.write(`参数不是合法 JSON: ${err.message}\n`);
      process.exit(2);
    }
    return { mode: "call", workspace, name, args };
  }
  process.stderr.write("用法:\n  node mcp-client.mjs --list\n  node mcp-client.mjs --call <toolName> '<json args>'\n");
  process.exit(2);
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith("mcp-client.mjs");
if (invokedDirectly) {
  const cli = parseCli(process.argv.slice(2));
  const client = new McpStdioClient({ workspace: cli.workspace }).start();
  try {
    const init = await client.initialize();
    process.stdout.write(`server=${JSON.stringify(init?.serverInfo)} protocol=${init?.protocolVersion}\n`);
    if (cli.mode === "list") {
      const tools = await client.listTools();
      process.stdout.write(`tools(${tools.length}):\n`);
      for (const tool of tools) {
        process.stdout.write(`  ${tool.name} — ${String(tool.description ?? "").slice(0, 90)}\n`);
      }
    } else {
      const result = await client.callTool(cli.name, cli.args);
      process.stdout.write(`isError=${result.isError}\n${result.text}\n`);
    }
  } catch (err) {
    process.stderr.write(`失败: ${err?.message ?? String(err)}\n`);
    if (client.stderr.trim()) process.stderr.write(`server stderr:\n${client.stderr.trim()}\n`);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

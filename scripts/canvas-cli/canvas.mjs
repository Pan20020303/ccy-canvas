#!/usr/bin/env node
/**
 * ccy canvas CLI —— 画布的命令行入口（C3 路线）。
 *
 * 与 MCP server 共用 canvas-core / canvas-tools：同一个 revision 序列、同一份 patch 流，
 * 两条入口可以同时存在而不会打架（每次调用都重新读盘）。
 *
 * 用法（在工作区目录里执行，或用 CCY_WORKSPACE 指定）：
 *   node canvas.mjs overview
 *   node canvas.mjs list [--type image] [--name 关键词]
 *   node canvas.mjs read <nodeId>
 *   node canvas.mjs add-text  --content "..." [--title "..."]
 *   node canvas.mjs add-image --prompt "..." [--model "..."] [--title "..."]
 *   node canvas.mjs add-video --prompt "..." [--model "..."]
 *   node canvas.mjs add-audio --prompt "..." [--model "..."]
 *   node canvas.mjs set-prompt <nodeId> --prompt "..." [--model "..."]
 *   node canvas.mjs connect <源> <目标>
 *   node canvas.mjs run <nodeId> [--prompt "..."] [--model "..."]
 *   node canvas.mjs move <nodeId> --x 100 --y 200
 *   node canvas.mjs delete <nodeId>
 *   node canvas.mjs group <id1,id2,...> [--name "..."]
 *   node canvas.mjs patches [--since N]
 *
 * 退出码：0 成功；1 参数/状态错误（stderr 输出 {"ok":false,"error":"..."}）。
 */

import { loadCanvas, readPatches, renderOverview, resolveWorkspace } from "./canvas-core.mjs";
import { toolByName } from "./canvas-tools.mjs";

function fail(message) {
  process.stderr.write(JSON.stringify({ ok: false, error: message }) + "\n");
  process.exit(1);
}

function argValue(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}

function callTool(name, args, ctx) {
  const tool = toolByName(name);
  if (!tool) fail(`未知工具: ${name}`);
  try {
    const result = tool.run(args, ctx);
    process.stdout.write(JSON.stringify({ ok: true, ...result }) + "\n");
  } catch (err) {
    fail(err?.message ?? String(err));
  }
}

function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command) fail("缺少子命令，先运行 `node canvas.mjs overview`");

  const workspace = resolveWorkspace();
  // overview / patches 是纯读，不经过工具层。
  if (command === "overview") {
    const canvas = loadCanvas(workspace);
    process.stdout.write(renderOverview(canvas) + "\n");
    return;
  }
  if (command === "patches") {
    const since = Number(argValue(argv, "--since") ?? 0);
    const kept = readPatches(workspace, Number.isFinite(since) ? since : 0);
    process.stdout.write(kept.map((p) => JSON.stringify(p)).join("\n") + (kept.length ? "\n" : ""));
    return;
  }

  const ctx = { workspace, canvas: loadCanvas(workspace) };

  switch (command) {
    case "list":
      return callTool(
        "list_nodes",
        { type: argValue(argv, "--type"), name_contains: argValue(argv, "--name") },
        ctx,
      );
    case "read":
      return callTool("read_node", { node_id: argv[1] }, ctx);
    case "add-text":
      return callTool("create_text_node", { content: argValue(argv, "--content"), title: argValue(argv, "--title") }, ctx);
    case "add-image":
      return callTool(
        "create_image_node",
        { prompt: argValue(argv, "--prompt"), model: argValue(argv, "--model"), title: argValue(argv, "--title") },
        ctx,
      );
    case "add-video":
      return callTool(
        "create_video_node",
        { prompt: argValue(argv, "--prompt"), model: argValue(argv, "--model"), title: argValue(argv, "--title") },
        ctx,
      );
    case "add-audio":
      return callTool(
        "create_audio_node",
        { prompt: argValue(argv, "--prompt"), model: argValue(argv, "--model"), title: argValue(argv, "--title") },
        ctx,
      );
    case "set-prompt":
      return callTool(
        "set_prompt",
        { node_id: argv[1], prompt: argValue(argv, "--prompt"), model: argValue(argv, "--model") },
        ctx,
      );
    case "connect":
      return callTool("connect_nodes", { source: argv[1], target: argv[2] }, ctx);
    case "run":
      return callTool(
        "run_node",
        { node_id: argv[1], prompt: argValue(argv, "--prompt"), model: argValue(argv, "--model") },
        ctx,
      );
    case "move":
      return callTool(
        "move_node",
        { node_id: argv[1], x: Number(argValue(argv, "--x")), y: Number(argValue(argv, "--y")) },
        ctx,
      );
    case "delete":
      return callTool("delete_node", { node_id: argv[1] }, ctx);
    case "group": {
      const ids = String(argv[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      return callTool("create_group", { node_ids: ids, name: argValue(argv, "--name") }, ctx);
    }
    default:
      fail(`未知子命令: ${command}`);
  }
}

main();

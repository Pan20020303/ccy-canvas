# 画布工作区（ccy-canvas × DeepSeek Harness）

你在一张节点式 AI 创作画布的工作区里。**画布权威状态是当前目录的 `canvas.json`**，
所有修改都必须经由 canvas 工具完成 —— 直接编辑 `canvas.json` 会绕过 revision 校验，禁止。

## 两种可用通道（二选一，优先 MCP）

1. **MCP 工具（首选）**：工具名形如 `mcp__ccy__<name>`，例如 `mcp__ccy__canvas_overview`、
   `mcp__ccy__create_image_node`。参数有 JSON Schema，直接按 schema 传即可。
2. **CLI（备选，仅当 MCP 工具不可用时）**：`node canvas.mjs <子命令>`。

| 动作 | MCP 工具 | CLI |
|---|---|---|
| 读全貌 | `canvas_overview` | `node canvas.mjs overview` |
| 筛选节点 | `list_nodes` | `list [--type image] [--name 关键词]` |
| 读单节点 | `read_node` | `read <nodeId>` |
| 建文本节点 | `create_text_node` | `add-text --content "..."` |
| 建图片节点 | `create_image_node` | `add-image --prompt "..." --model "..."` |
| 建视频节点 | `create_video_node` | `add-video --prompt "..." --model "..."` |
| 建音频节点 | `create_audio_node` | `add-audio --prompt "..." --model "..."` |
| 改提示词 | `set_prompt` | `set-prompt <id> --prompt "..."` |
| 连线 | `connect_nodes` | `connect <源> <目标>` |
| 触发生成 | `run_node` | `run <id> [--model "..."]` |
| 移动 | `move_node` | `move <id> --x 100 --y 200` |
| 删除 | `delete_node` | `delete <id>` |
| 编组 | `create_group` | `group <id1,id2> --name "..."` |
| 查变更 | `get_canvas_delta` | `patches [--since N]` |

## 铁律

1. **先读后写**：动手前先 `canvas_overview` / `overview`，再 `read_node` 看细节。
2. **只经工具改画布**：每次成功都会返回 `{ok:true, revision:N}` 并追加一条 patch；没看到 ok 就是没改成功。
3. **不要声称做过没做的事**：画布只认工具返回的 `ok:true`。
4. **不要手写 `canvas.json` / `patches.jsonl`**。
5. **一次只做用户要求的事**，不要顺手清理或重构画布上的其他节点。

## 画布语义

- 节点类型：`text` / `image` / `video` / `audio`。生成类节点靠 `data.promptDraft`（提示词）+ `data.model`。
- **连线即引用**：把 A 连到生成节点 B，B 生成时会带上 A 的产物作为参考图/上下文。方向是 `源(参考方) → 目标(生成方)`。
- `run_node` 只是**入队**生成任务，真正的出图由画布后端异步完成 —— 不要声称图片已生成。
- 批量建节点时逐个创建即可，落点由工具自动排布，不要手工调坐标（除非用户要求布局）。

## 汇报要求

完成后用 1-3 句中文汇报：改了哪些节点 id、做了什么、revision 从几到几。不要粘贴大段 JSON。

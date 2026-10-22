# Skills, Agents, and Canvas-CLI Design

> Status: draft · 2026-06-03 · supersedes ad-hoc "tools" discussion in chat

## Goal

Add two new first-class concepts and let them drive the canvas autonomously:

1. **Skills** — reusable callable tools (HTTP / Prompt / Code).
2. **Agents** — opinionated AI personas that own a system prompt, a model,
   a set of Skills, and the ability to operate the canvas via a CLI-style
   tool protocol.

The platform must enforce a clear **admin-global vs. user-personal** boundary
so members can use the company-provided Skills/Agents but cannot edit them.

## Permission model

```
                | view | use | edit | delete
admin global    |  ✓   |  ✓  |  ✓   |  ✓
admin personal  |  ✓   |  ✓  |  ✓   |  ✓
member global   |  ✓   |  ✓  |  ✗   |  ✗     ← key requirement
member personal |  ✓   |  ✓  |  ✓   |  ✓
```

Implementation: each row has `scope ∈ {global, personal, team}` plus a
nullable `owner_id` (NULL ⇔ scope='global'). The handler middleware
checks:

* `mutation && row.scope == 'global'` ⇒ require `claims.Role == 'admin'`
* `mutation && row.scope == 'personal'` ⇒ require `claims.UserID == row.owner_id`

## Data model

### `skills`

```sql
CREATE TABLE skills (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope         TEXT NOT NULL CHECK (scope IN ('global','personal','team')),
  owner_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  team_id       UUID,                          -- reserved
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL DEFAULT 'other',
  icon          TEXT NOT NULL DEFAULT '',
  kind          TEXT NOT NULL CHECK (kind IN ('http','prompt','code')),
  spec          JSONB NOT NULL,
  input_schema  JSONB NOT NULL DEFAULT '{}',
  output_schema JSONB NOT NULL DEFAULT '{}',
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Kinds:**

* `http` → `spec = { url, method, headers, body_template, response_path,
  timeout_ms }`  Templates use `{{input.field}}` syntax.
* `prompt` → `spec = { system_prompt, user_template, model_hint }`
  Runs through the existing `Generate` service.
* `code` → `spec = { runtime: 'js'|'python', source }` *(Phase 4)*.

### `agents`

```sql
CREATE TABLE agents (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope         TEXT NOT NULL CHECK (scope IN ('global','personal','team')),
  owner_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  avatar        TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL,
  model         TEXT NOT NULL,         -- e.g. 'gpt-4o' (matches provider_configs.model_list)
  skill_ids     UUID[] NOT NULL DEFAULT '{}',
  -- canvas_tools enables a built-in tool group letting the agent call:
  --   create_node, connect_nodes, set_prompt, run_node, read_node,
  --   create_group, move_node, delete_node, list_nodes
  canvas_tools  BOOLEAN NOT NULL DEFAULT TRUE,
  strategy      TEXT NOT NULL DEFAULT 'reactive',
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### `skill_runs` (execution log)

```sql
CREATE TABLE skill_runs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID,
  agent_id    UUID,                -- nullable: direct skill call
  skill_id    UUID NOT NULL,
  inputs      JSONB,
  outputs     JSONB,
  status      TEXT NOT NULL,       -- pending / success / error
  error_msg   TEXT NOT NULL DEFAULT '',
  duration_ms INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## REST API

### User

```
GET    /api/app/skills                    list visible (global + own personal)
POST   /api/app/skills                    create personal (scope auto = 'personal')
GET    /api/app/skills/:id                read
PUT    /api/app/skills/:id                update (ownership-guarded)
DELETE /api/app/skills/:id                delete (ownership-guarded)
POST   /api/app/skills/:id/invoke         run skill, return result

GET    /api/app/agents                    list visible
POST   /api/app/agents                    create personal
GET    /api/app/agents/:id                read
PUT    /api/app/agents/:id                update (ownership-guarded)
DELETE /api/app/agents/:id                delete (ownership-guarded)
POST   /api/app/agents/:id/run            SSE: stream agent execution
```

### Admin

```
GET    /api/admin/skills                  list everything
POST   /api/admin/skills                  create (scope=global default)
PUT    /api/admin/skills/:id              update any
DELETE /api/admin/skills/:id              delete any

GET    /api/admin/agents
POST   /api/admin/agents
PUT    /api/admin/agents/:id
DELETE /api/admin/agents/:id

GET    /api/admin/skill-runs              all run history
```

## Canvas-CLI tool protocol (Phase 3)

The agent runs server-side. The browser opens an SSE connection to
`POST /api/app/agents/:id/run`. The server:

1. Loads agent's `system_prompt`, `model`, and bound `skills`.
2. Sends the LLM a tool list = bound skills + (if `canvas_tools=true`)
   the built-in canvas ops.
3. Streams events: `event: thought / tool_call / tool_result / message`.
4. When the LLM emits a tool_call with a canvas op, the server applies
   it via the same store actions used by the UI (or writes through to
   the project's canvas snapshot) and broadcasts a `canvas_patch` event
   so the browser refreshes that part of the React Flow graph.

### Canvas ops vocabulary

```ts
type CanvasOp =
  | { op: 'create_node'; type: NodeType; position: XY; data?: Record<string,unknown> }
  | { op: 'connect_nodes'; source: string; target: string }
  | { op: 'set_prompt'; nodeId: string; prompt: string }
  | { op: 'run_node'; nodeId: string; model?: string }
  | { op: 'read_node'; nodeId: string }
  | { op: 'create_group'; nodeIds: string[]; name?: string }
  | { op: 'move_node'; nodeId: string; position: XY }
  | { op: 'delete_node'; nodeId: string }
  | { op: 'list_nodes' }
  | { op: 'find_nodes'; filter: { type?: NodeType; nameContains?: string } };
```

Each op returns a JSON result the agent sees as a tool_result.

### Example transcript

User goal: *"为这张产品图生成 3 个不同角度的 5 秒商品视频"*

```
agent.thought  → "需要拿到产品图节点 id"
tool_call      → list_nodes()
tool_result    → [{id:'a', type:'referenceImageNode', name:'产品图'}, ...]

agent.thought  → "创建 3 个 video 节点并连参考图"
tool_call      → create_node(type='videoNode', position={x:600,y:0})
tool_result    → {id:'b'}
tool_call      → connect_nodes(source='a', target='b')
tool_call      → set_prompt(b, '正面 360 度环绕拍摄产品...')
tool_call      → run_node(b)
… (×3 with 3 angle variations) …

message        → "已为你创建 3 个角度的视频，正在生成中…"
```

## Frontend touch points (Phase 2-3)

```
Settings modal:
  ├── 我的技能     (personal CRUD + browse global read-only)
  ├── 我的智能体   (personal CRUD + browse global read-only)
  └── 键盘快捷键  (existing)

Admin console new pages:
  ├── /admin/skills     (admin CRUD on global skills)
  └── /admin/agents     (admin CRUD on global agents)

Canvas:
  + new node type:  skillNode  (rendered from skill.input_schema)
  + new node type:  agentNode  (chat-in / output-out, SSE-streamed)
  + sidebar "+ skill" picker
```

## Phase plan

| Phase | Scope | LoC est | Done in |
|---|---|---|---|
| 1 | DB migration, sqlc queries, Go domain + repo + handlers for Skills & Agents CRUD with admin/user split & ownership middleware | ~900 | this commit |
| 2 | Skill executor (http + prompt kinds), settings UI tabs, admin CRUD pages | ~1200 | next |
| 3 | Agent runtime + canvas-CLI protocol + SSE bridge + canvas nodes | ~1500 | next |
| 4 | code-kind sandbox / team scope / market | — | optional |

## Non-goals

- Multi-step agent planning beyond single tool-calling loop (Phase 3 ships
  `strategy='reactive'` only; planner / scripted strategies later).
- Sandboxed code execution (Phase 4).
- Skill chaining DSL — agents can chain by calling tools sequentially.
- Cross-tenant skill sharing.

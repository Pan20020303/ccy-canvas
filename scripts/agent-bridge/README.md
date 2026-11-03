# ccy agent bridge

用 **DeepSeek Harness** 替换 ccy-canvas 自研 Go agent runner 的 Node 侧服务。

## 为什么是 Node 而不是直接写进 Go

分工原则是"谁擅长什么"：

| 关注点 | 归属 |
|---|---|
| 鉴权、积分计费、会话持久化、画布权威状态 | **Go**（`ccy-canvas-api`，不变） |
| DSH 进程管理、JSON-RPC、会话路由、事件翻译 | **Node**（本目录） |

DSH 本身就是 Node 应用，MCP 集成也已经在 Node 侧验证通过；把协议细节留在 Node，
Go 侧只需要加一个 `HarnessBackend` 分支转发到本服务，不必为了改一行事件映射重编译二进制。

## 目录

```
scripts/agent-bridge/
  server.mjs                  HTTP/SSE 服务（端点与 Go 侧现行契约同形）
  smoke.mjs                   端到端冒烟：打真实任务 + 统计事件分布 + 补读收尾事件
  probe-sdk.mjs               手工探测 dsh --profile sdk 的 stdio JSON-RPC 握手
  lib/agent-runtime.mjs       一个常驻 dsh 子进程（initialize / session/prompt / shutdown）
  lib/runtime-pool.mjs        conversation ↔ runtime 映射、每会话工作区、空闲回收
  lib/job-registry.mjs        内存事件日志（lastEventId 续传、软取消）
  lib/event-translator.mjs    薄转发 → src/app/dsh-event-translator.ts（实现唯一一份）
```

事件翻译器的**实现**在 `src/app/dsh-event-translator.ts`（TypeScript，可类型检查 + 20 个单测）。
Node 侧通过 Node ≥ 23 的原生 type stripping 直接加载，不需要构建产物。

## 跑起来

```powershell
# 1. 确认 dsh 的 ccy profile 存在（首次会自动从 sdk 模板初始化）
node <dsh>/lib/bin.js --profile ccy --dump-config

# 2. 起 bridge
node scripts/agent-bridge/server.mjs --port 39300 --workspace <工作区根目录>

# 3. 冒烟（真实调用 DSH + 画布 MCP）
node scripts/agent-bridge/smoke.mjs "用画布工具新建一个 image 节点，标题写「测试」" --port 39300
```

`--workspace` 是**根目录**：每个 conversation 会在它下面拿到独立子目录
（画布状态、技能文件互不串味，DSH 的 fs 沙箱边界也天然按会话隔离）。

## Go 侧接入（已完成）

`backend/internal/skills/interfaces/agent_harness_handler.go` 实现了桥接分支：

- 派发条件：`agents.metadata.agentRuntime == "harness"`（大小写/空白无关）。
  **不是** `agents.strategy`（有 CHECK 约束，只允许 reactive/scripted），
  **也不是** `agents.runtime`（语义是角色/预置，被种子 diff 逻辑使用）。
  用 metadata 是现成扩展点，等验证稳定再升级成正式列 + 管理端点。
- 桥地址：环境变量 `CCY_HARNESS_BRIDGE_URL`（默认 `http://127.0.0.1:39300`）。
  未设置时会走默认值；桥不可用时 job 明确失败并给出可诊断文案，
  **不会静默回退到本地 runner**（否则"为什么 agent 行为变了"无法排查）。
- 事件仍然经 `emit()` 落到 `agent_run_events`，所以前端的中断续传、回放、
  2s 状态看门狗**全部照旧**，前端零改动。
- 画布补丁在终态事件之前落库 —— `FinishAgentRunJob` 是原子 CTE（更新 agent_runs
  的同时插终态事件），这个设计正好保证了顺序。

给某个智能体开启：

```sql
update agents
set metadata = metadata || '{"agentRuntime":"harness"}'::jsonb
where deploy_key = 'universalAi';    -- 或按 id
```

关闭：把该键删掉或改成非 "harness" 的值即可（回退到本地 runner）。

### 测试

```powershell
# 桥侧（node:test，无需额外框架）：落库、重启恢复、崩溃语义等 11 个
node --test "scripts/agent-bridge/test/*.test.mjs"

cd backend
# 无数据库：17 个管道测试（错误处理、URL、SSE 解析、派发规则）
go test ./internal/skills/interfaces/ -run 'Harness|ReadHarnessSSE|AgentUsesHarness'

# 有数据库：再加 2 个端到端（事件落库顺序、会话消息、记忆、标题）
$env:CCY_TEST_DATABASE_URL = 'postgres://postgres:postgres@localhost:55432/ccy_canvas?sslmode=disable'
go test ./internal/skills/interfaces/ -run Harness -v

# 前端全量
npx vitest run
```

数据库测试**全程在一个事务里并最终 ROLLBACK**，不给开发库留残留；
同时事务也提高了测试强度：router 用的就是该事务，任何"绕过传入 querier 偷拿连接"
的写法都会读不到数据而失败。

### 整链路联调（真实双端）

`integration.mjs` 打通 浏览器契约 → Go API → 桥 → DSH → 画布 → 数据库，
用真实会话 cookie（HMAC 自签）打 Go 的 HTTP 接口，并核对 Go 事件表、会话消息、
记忆、标题与桥侧画布文件：

```powershell
# 1. 编译一份独立 API 二进制（不要覆盖正在跑的那个）
cd backend
go build -o ccy-canvas-api-harness-test.exe ./cmd/api

# 2. 起测试实例：独立端口 + **显式禁用 Redis**（原因见下）
cd C:\ccy迁移\code\ccy-canvas
$env:HTTP_ADDR='127.0.0.1:9097'; $env:REDIS_ADDR=''
$env:CCY_HARNESS_BRIDGE_URL='http://127.0.0.1:39300'
# 需要 DATABASE_URL / SESSION_SECRET / CCY_ENCRYPTION_KEY（Go 侧不读 .env）
.\backend\ccy-canvas-api-harness-test.exe

# 3. 起桥
node scripts/agent-bridge/server.mjs --port 39300 --workspace <工作区>

# 4. 跑（正向：开关打开）
node scripts/agent-bridge/integration.mjs --api http://127.0.0.1:9097 `
  --agent-name 'harness 联调智能体' --user <owner-uuid> --expect-runtime harness

#    反向：开关关闭，验证真的回退到本地 runner
node scripts/agent-bridge/integration.mjs --api http://127.0.0.1:9097 `
  --agent-name '负向验证智能体' --user <owner-uuid> --expect-runtime local
```

⚠️ **联调实例必须把 `REDIS_ADDR` 设为空**：Asynq 队列是共享的，否则生产实例
（可能跑着旧二进制）会抢走你刚建的任务并用旧逻辑执行。
禁用后退回 in-process 路径，任务由本实例自己执行。

集成脚本的预期差异（两条路**可区分**，这是验证派发的依据）：

| | harness 开 | harness 关（本地 runner） |
|---|---|---|
| 工具名 | `canvas_overview` / `create_image_node`（MCP 命名空间已剥离） | `create_node` / `connect_nodes` |
| 桥侧会话工作区 | 有 `canvas.json`，nodes≥1 | **没有**该文件（桥完全没参与） |
| 事件顺序 | `canvas_patch…,done` | `message,done` |

脚本刻意**不会自动改写智能体的开关**：早期版本会自动写入 `agentRuntime=harness`，
结果把"关闭开关"的负向验证悄悄变成了正向验证（跑出来还以为是回退生效了）。
现在它只读并校验 `--expect-runtime`，不匹配就直接失败。

## 落库与崩溃恢复

job 与事件日志落在 `node:sqlite`（Node ≥ 22 内置，**无第三方依赖**），
默认路径 `<workspace>/state/jobs.db`：

```powershell
node server.mjs --workspace <root>                      # 默认开启落库
node server.mjs --workspace <root> --persist off        # 关闭（回到纯内存）
node server.mjs --workspace <root> --retention-ms 86400000 --max-stored-jobs 500
```

选 SQLite 而不是自己拼 JSONL：事件是追加写且可能很长，SQLite 给原子写 + WAL，
不用自己处理"半写坏的文件"；按 `(job_id, id)` 顺序读、按 job 查、按时间清理都是 SQL 一行。

### 重启语义（重要）

进程重启时不可能还有 job 在跑（DSH runtime 随进程一起死），所以启动时把残留的
`running`/`queued` **一律标成 `interrupted`** —— 绝不标成 `success`：那一轮确实没跑完，
前端应当看到"被中断"，而不是收到一个假的完成。

```jsonc
// 崩溃后重启，GET /api/app/agent-jobs/<id>
{
  "status": "interrupted",
  "error_message": "bridge 重启，任务被中断",
  "event_count": 358        // 崩溃前已落库的事件全部保留（排障证据）
}
```

`interrupted` 是**终态**：`GET /events` 会正常收尾而不是挂住（早期版本漏了这一点，
实测 SSE 连接会一直不返回），且不再接受新事件。

### 关停

收到 SIGINT/SIGTERM 时先把仍在跑的 job 明确收尾为 `interrupted`（带原因），再关库 ——
否则它们要等下次启动才被发现是残留的 `running`。

## 检视页（只读历史回放）

桥自带一个只读页面，用来核对"事件流到底长什么样、呈现出来是什么样"：

```
http://127.0.0.1:39300/inspector
```

- 左侧：job 列表（状态/会话/工具数/画布变更数/事件数），读落库的历史，重启后仍在
- 右侧：时间线（思考块可折叠、工具卡片与结果配对、画布变更单列）+ 统计条
- 工具条：思考块/计量/原始事件 开关（排查时看原始事件最有用）

命令行的等价物（CI 友好）：

```powershell
node scripts/agent-bridge/verify-timeline.mjs --bridge http://127.0.0.1:39300
```

它会用**真实 job 的事件流**跑一遍共享时间线逻辑，断言：事件被压缩、四类步骤齐全、
工具名已去 MCP 前缀、工具全部配对到结果、画布 revision 连续。

### 呈现逻辑只有一份

页面与将来 ccy 的 React 面板都消费 `src/app/agent-timeline.ts`：

| 层 | 文件 | 职责 |
|---|---|---|
| 翻译 | `src/app/dsh-event-translator.ts` | DSH session 事件 → ccy 事件契约（事件级） |
| 呈现 | `src/app/agent-timeline.ts` | 事件序列 → 可读步骤（呈现级） |

页面里的 `timeline.js` 是桥启动后用 esbuild **现打**的（esbuild 随 vite 一起装着，
不新增依赖），所以不存在"预编译产物与源码漂移"的问题。

## 与 ccy 前端的集成状态

**DSH 会话 UI 不需要另写**：`AgentRunPanel` 已有的事件分支正好覆盖 DSH 的事件集，
所以在 Go 侧把 agent 切到 harness 后，前端**自动**渲染出思考块、工具卡片、
画布变更卡与上下文计量条 —— 零前端改动。

| 前端能力 | DSH 路径下 | 说明 |
|---|---|---|
| 思考块（可折叠、流式增长） | ✅ | `thought_delta` → 面板的 `thought` 步骤 |
| 工具卡片（含耗时/结果） | ✅ | `tool_call`/`tool_result` → 面板的 `tool` 步骤 |
| 画布变更卡 + 实际应用 patch | ✅ | `canvas_patch` → 面板的 `canvas` 步骤 + `applyPatch` |
| 上下文窗口计量 | ✅ | `usage` |
| 会话列表 / 历史 / 自动标题 | ✅ | Go 侧持久化不变（`persistSuccessfulTurn`） |
| 执行模式确认卡（手动/自动） | ✅ | 前端逻辑，与 runner 无关 |
| **斜杠技能 `/技能名`** | ✅（本次修复） | 见下 |
| **"从画布添加"参考节点** | ✅ 文本 / — 图片 | 节点引用以文本前导进入消息；缩略图只用于本地气泡，后端本来就没收到 |
| 工具卡片分组折叠、ask_user 选项卡 | ✅ | 面板既有逻辑 |

### 本次修的两个真问题

1. **DSH 路径下 `/技能名` 完全失效。** 斜杠解析原本只在本地 runner 路径里做，
   harness 分支在它**之前**就分流了 —— 桥收到的是字面 `/rewrite 正文`，技能模板没生效。
   现在两条路共用同一个 `ResolveSlashSkillMessage`。

2. **"参考画布节点" + `/技能` 同时用时，技能静默失效（既有 bug，两条路都受影响）。**
   前端把节点前导拼在消息**最前面**（`message: refPreamble + outbound.message`），
   而解析器只看第一个 token 是否以 `/` 开头 → 前导在前时永远解析不到。
   现在解析器会先剥掉前导再解析，并把前导保留在 User request 里（它是有效上下文）。

### 技能的"方法论"在 DSH 路径下也能按需加载（已实现）

本地 runner 会把绑定技能注册成工具；DSH 路径原本只有斜杠命中的模板文本。
现在 Go 把绑定技能随任务一起发给桥，桥写进会话工作区的 `.dsh/skills/<id>/SKILL.md`，
由 DSH 自带的 `dsh-skill-filesystem` 扫描成"模型可发现的目录 + 可按需加载"：

```
Go: 绑定技能(kind=prompt, 有正文) → POST /jobs 的 skills 字段
桥: writeSkills() → <会话工作区>/.dsh/skills/<id>/SKILL.md（每次 run 重写并清理陈旧项）
DSH: 首个请求前给模型一份技能目录；模型用 `skill` 工具按需加载完整方法论
```

**两个实测出来的关键点**（都不是照文档推的）：

1. **DSH 的技能名必须是 ASCII 标识符。** 中文名（如「镜头设计」）文件在磁盘上、
   frontmatter 也合法，但**进不了会话 catalog**，`skill` 工具报 `invalid skill name`。
   对照实验：同时导出 `shot-design`（ASCII，✅ 加载成功）与「镜头设计」（❌ 被拒）。
   所以 ccy 中文技能名会被映射成稳定标识符（提不出 ASCII 就用 `ccy-skill-<hash>`），
   原名放进 description（`…（ccy 技能：镜头设计）`），模型据此仍能对上是哪个技能。

2. **不要写 `user-invocable: false`。** 我原本为了防止与 ccy 自己的斜杠解析抢
   `/技能名` 而设了它，结果实测模型据此判定"技能不可调用"并退回 `glob`+`read` 绕过。
   冲突其实不存在：ccy 的 `/技能名` 在 Go 侧就被解析成模板正文，那个 token 到不了 DSH。
   现在两个 flag 都不写。

修完后的实测：

```
工具调用：skill × 1（没有 glob/read 绕过）
技能名：ccy-skill-5b34fe48（ccy 技能：镜头设计）
第一条规则：（准确引用技能正文）
```

### 上线后才暴露的两个真 bug（都已修）

**1. 开关会被种子冲掉 → 表现是"改了没用"。**

`EnsureCreatorSuiteAgentSeeds` 每次 API 启动都会 upsert 一遍种子，其中
`insertAgentParamsToUpdate` 用 `Metadata: params.Metadata` **整体替换** metadata ——
把管理侧写在 `metadata.agentRuntime` 的开关一起冲掉了。
实测：设了 17/17，重启几次内核后变回 **0/17**，用户看到的就是"内核没更新"。

修法：种子写回前用 `withPreservedAgentRuntime` 合并保留该键
（种子不拥有这个开关）。已在 `creator_suite_agents.go` 修，并实测"设置 → 重启 → 仍在"。

**2. agent 看不到用户的真实画布。**

MCP 的画布工具读的是会话工作区里的 `canvas.json`，而浏览器是**每次 run** 把整张画布
快照随请求发上来的 —— 桥原先完全没读 `body.nodes/edges`，所以工具在一个**空画布**上工作。
现象：用户画布上明明有内容，agent 却回答"当前画布是空的"。

修法：
- Go 侧在 payload 里带上 `nodes` / `edges` / `groups` / `canvas_revision`；
- 桥在**建 job 时**用 `seedCanvasFromRequest` 把快照写进会话工作区（原子写 + 清空 patch 文件）。
  revision 用快照自带的，这样工具产出的 patch 的 `base_revision` 与浏览器当前 revision 对齐，
  前端 `advanceCanvasPatchRevision` 才能接上。
  只在请求确实带画布时才写 —— 空数组不能当成"用户清空了画布"（那会抹掉工作区状态）。

实测：给 2 个节点 + 1 条连线（revision 7），agent 正确回答出 `n1 开场图` / `n2 分镜说明` /
`n2 -> n1` / `revision=7`。

**3. harness 分支必须在"解析模型 endpoint"之前。**

DSH 用的是它自己的凭据，与 ccy 的 provider catalog 无关。分支放在解析之后的话，
模型名在 catalog 里解析不到的 agent（实测有：`model=volcengine:...`）会直接报
"所选模型暂不可用"，harness 根本轮不上。已把分支提到解析之前。

### 部署时的三个坑（运维相关）

- **有两个 `ccy-canvas-api.exe` 副本**：仓库根的（`start-all.bat` 实际跑的）和
  `backend/` 下的。只换一个会出现"路由 405 / 行为没变"。两边都要换。
- **工作目录必须是仓库根**：`start-all.bat` 是 `cd` 到根再执行根目录的 exe。
  用 `backend/` 当工作目录启动会走另一条相对路径解析。
- **`.bat` 文件必须 CRLF**：LF-only 会让 cmd 吃掉行首字符（报 `'he' is not recognized`），
  且 batch 里嵌转义括号会把解析搞断 —— 所以端口清理与探活都放在 Node 脚本里。

## 把画布变更接进对话时间线（做完了）

原先 `canvas_patch` 只进面板底部的汇总卡，**不进线程时间线** —— 于是"agent 在画布上
做了什么"在对话流里是缺失的，而 DSH 的事件流里它本来就按时间序插在工具调用之间。
现在它会按发生顺序渲染成绿色卡片（操作图标 + 动作 + 标题 + revision）。

链路（三处都要对，缺一个就白做）：

```
AgentRunPanel.runSteps(canvas 步骤)
  → agent-timeline.canvasStepsToParts()  → { type: "data-canvas-op", data: {...} }
  → assistant-ui 运行时 convertDataPrefixedPart() → 内部 { type:"data", name:"canvas-op", data }
  → useAssistantDataUI({ name:"canvas-op", render }) 注册的渲染器 → CanvasOpCard
```

**这条路上踩了两个"类型检查过了但运行时不对"的坑**，都值得记：

1. **part 类型不能自造。** 我第一版写 `{ type: "canvas-op" }`，TypeScript 直接拒绝
   （part 类型是严格联合）。**报错反而指出了正确方向** —— 合法列表里有 `data`。

2. **`{ type: "data", name, data }` 也不行，而且更危险。** 类型能过，但运行时
   `thread-message-like.js` 转换 part 的 switch **没有 `data` 分支**，兜底是
   `convertDataPrefixedPart(type, part.data)`；非 `data-` 前缀会直接
   `throw new Error("Unsupported assistant message part type: …")`。
   正确写法是 **`{ type: "data-canvas-op", data }`** —— 前缀 `data-` 后面的部分
   会被当作 `name`（`type.substring(5)`），所以注册名要写 `"canvas-op"`。

3. **渲染不能自己在 switch 里做。** `MessagePartComponent` 的 `case "data"` 从
   `data?.by_name?.[part.name]` 取注册的渲染器；自己在 switch 里再渲染一次会出两张卡。
   而且**同一个 switch 里出现两个 `case "data"`** 时，后者永不执行 —— esbuild 会警告
   （`This case clause will never be evaluated because it duplicates an earlier case clause`），
   但类型检查和测试都可能照样通过，只有跑构建才看得见。

4. **光靠类型和单测不够，要真的渲染一次。** 这条链路的三个环节里，类型检查只覆盖
   第一环。项目里已经有 jsdom + `createRoot` 的轻量测试模式（不需要 testing-library），
   所以 `CanvasOpCard.test.tsx` 把卡片**真的渲染成 DOM** 并断言文案/revision/title，
   同时断言 `buildAgentThreadMessages` 产出的 part 形状与顺序。

共性教训：**assistant-ui 的自定义 part 有它自己的注册协议，光看类型定义不够，
必须读运行时的转换与分发代码**。以上都从 `node_modules/@assistant-ui/core/dist`
读出来并配了可回归的测试，不是猜的。

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 存活 + runtime 池状态 + 当前画布 revision + 落库统计 |
| GET | `/inspector` | 只读检视页（历史回放） |
| GET | `/inspector/jobs?limit=N` | job 列表（只读） |
| GET | `/inspector/timeline.js` | 共享时间线实现的浏览器 bundle（现打 + 缓存） |
| POST | `/api/app/agents/:agentId/jobs` | 建任务 → `{ job_id, conversation_id }`（202） |
| GET | `/api/app/agent-jobs/:jobId` | 任务状态（`success` / `error` / `cancelled` / `interrupted`） |
| GET | `/api/app/agent-jobs/:jobId/events?after=N` | SSE 事件流，可断线续传 |
| POST | `/api/app/agent-jobs/:jobId/cancel?hard=1` | 取消（见下方"取消语义"） |

SSE 帧格式与 `backend/internal/skills/interfaces/agent_job_handler.go` **完全一致**：

```
id: N
event: NAME
data: JSON

```

所以前端 `src/app/api/agent-run.ts` 可以整体切过来、一行不改。

## 事件映射

| DSH session 事件 | ccy 前端事件 |
|---|---|
| `assistant/message`.stream 的 `text-chunks` | `message_delta`（按原始 `dt` 节奏逐片） |
| `assistant/message`.stream 的 `reasoning-chunks` | `thought_delta`（思考块流式增长） |
| `assistant/message`.usage | `usage`（上下文计量表） |
| `assistant/message` | `message`（最终回复，取 `message.content`） |
| `tool/call` | `tool_call`（工具名去掉 `mcp__ccy__` 前缀） |
| `tool/result` | `tool_result`（按 callId 回填工具名） |
| `turn/end` | `done` |
| 工作区 `patches.jsonl` 增量 | `canvas_patch`（**在 done 之前**补发） |

被刻意忽略的过程性事件：`turn/start`、`step/*`、`system/message`、`request/*`。

## 三个必须知道的约束（都来自 DSH SDK 协议本身）

1. **没有 per-prompt 取消**。`cancel()` 只是"软取消"：停止转发事件 + 标记 cancelled，
   后台那一轮仍会跑完（静默消耗 token）。要真取消只能 `?hard=1` 关掉整个 runtime
   —— 代价是该会话的上下文一起丢。前端"停止"按钮的语义必须按这个来设计。
2. **`session.event` 是全 runtime 广播**，包含非本会话的事件，必须按 sessionId 过滤
   （翻译器已内置）。
3. **`session/prompt` 只是入队收据**，不代表这一轮结束。结束判定靠 `turn/end`，
   并以 `session.status = idle` 兜底。

## 踩过的坑（改之前先读）

- **`done` 必须是最后一条事件**。最初实现把 `canvas_patch` 放在 `done` 之后补发，
  结果前端一收到 `done` 就停止处理，**画布变更被静默丢弃**。
- **事件处理必须保序**。最初用 `void (async () => …)` 并发处理事件，`session.status=idle`
  的兜底会抢在最后一条 `assistant/message` 之前收尾，导致最终回复停留在中间步骤
  （实测把 "Now connect text(n2) → image(n1)." 当成了最终汇报）。
- **活动的工作区路径必须按会话解析**。任何模块级 `const CANVAS_FILE` 都是错的。
- **`cwd` 解析成 undefined 会让整棵 DSH 插件树加载失败**（MCP 配置 schema 校验），
  所以 bridge 起 dsh 时必须注入 `CCY_MCP_WORKSPACE`（见 `canvas-cli/ccy-mcp.patch.yml`）。
  这是刻意的失败方式：宁可不启动，也不要一个没有画布工具、会"假装改画布"的智能体。
- **成功路径必然写库**，所以它没法用 nil store 做无库测试；失败路径也要写终态，
  同样不能。为此给 router 加了可注入的 `terminalSink`（`WithTerminalSink`），
  无库测试注入内存实现，真库测试用真实 SQL（见 `agent_harness_bridge_test.go`
  与 `agent_harness_db_test.go` 的分工）。
- **`agents.strategy` 有 CHECK 约束**（只允许 `reactive`/`scripted`）——
  想用 strategy 当后端开关会在插入时报 `agents_strategy_check` 违反。这是测试
  连库跑才暴露的，纯读代码看不出来。

## 还没做（生产化前需要补）

- **鉴权**：桥现在只绑 `127.0.0.1`，无 token 校验。
- **切到 metadata 之外的正式开关**：加 `agents.agent_runtime` 列 + 迁移 + sqlc 重新生成
  + 管理端下拉框。
- **桥的 runtime 上限/超时的运维参数**：`--max-runtimes`、`--idle-ms` 已有，
  但没有暴露到配置中心。
- **多实例部署**：落库是本地 SQLite，所以桥目前只适合单实例；
  要多实例得换成共享存储（或把 job 落在 Go 侧统一管理）。
